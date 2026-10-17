import type { Clock } from '@autom8x/automation-kit/quickbooks';
import { utcDay } from '@autom8x/automation-kit/values';
import {
  CallbackRefusedError,
  DEFAULT_MODEL_TIMEOUT_MS,
  ModelRefusedError,
  artifactIdProblem,
  excludeModelAuthorsProblem,
  isObject,
  isUnsent,
  modelAuthor,
  readJsonCompletion,
  type JsonObject,
  type ModelCompletion,
  type ModelRefusalReason,
  type PromptModule,
  type Step,
  type StepResult,
} from '@autom8x/automation-sdk';

import { secondReadOf, type SecondRead } from '../checks/answers.js';
import { limitCentsOf } from '../decide/holds.js';
import { runFails } from '../outcome.js';
import { QUICKBOOKS, vendorChoiceOf } from '../quickbooks-path.js';
import type { DocumentState, Finding, NotMadeReason } from '../state.js';
import type { RunFail } from '../words.js';
import { READ_TYPES, V2_TYPES, type ReadType } from './answer.js';
import { documentOf } from './check.js';
import { MODELS } from './model-refusals.js';
import { compared, notMade, settled, verifyLine } from './settle.js';
import { runStateOf, withEntries, type Entry } from './state.js';
import { DOUBTS } from './words.js';

/**
 * `verify-read` (the second AI step) — ONE second read for the whole file, made only when a
 * document is doubtful (the session's spec, B4): v2's triggers — totals that don't add up, unclear
 * fields, a total not cross-checked, or on the QuickBooks path an amount over the approval limit —
 * and v2's former run-failing rules, which v3 leaves `unsettled` (`check.ts`). Blind and by another
 * maker, as v2's: it names the doubtful documents by their place in the file and nothing of the
 * first read, and leaves out every maker that read a part of it. Twenty documents to a call, so an
 * answer never nears the platform's cap; a clean file makes no second read at all.
 *
 * Documents are matched by place. A second read that counts the file's documents otherwise holds
 * every doubtful document: "two reads differ: number of documents". Each document is then compared
 * as v2 compared one (`settle.ts`): an unsettled one is settled when the second read gives what the
 * first could not read — the seller, the total, the date — and still unclear, it waits (B4).
 *
 * A second read that cannot be made is recorded on each document, and on the QuickBooks path the
 * document holds: "second read not made" (v2's D6). Out of time and a fault on the platform's side
 * fail the run, as v2's; an answer that never came is thrown on unchanged, for the runner's one
 * repeat of a call that never reached the platform.
 */

/** The fixed task: blind — nothing of the first read, nothing a person typed. */
export const VERIFY_TASK = 'Read again the documents the instruction names.';

/** The most documents one second-read call names. */
export const VERIFY_DOCUMENTS_PER_CALL = 20;

/** The findings that call for a second read (v2's decision 3). */
const PROBLEMS: ReadonlySet<Finding> = new Set([
  'amounts_mismatch',
  'unclear_fields',
  'not_cross_checked',
]);

/** v2's trigger: a finding that is a problem, or — on the QuickBooks path — over the approval limit. */
export function secondReadDue(
  document: Pick<DocumentState, 'findings' | 'amountCents'>,
  config: JsonObject,
  quickBooks: boolean,
): boolean {
  if (document.findings.some((finding) => PROBLEMS.has(finding))) return true;
  return quickBooks && (document.amountCents ?? 0) > limitCentsOf(config);
}

/** Whether one document's second read is due (B4). */
export function due(entry: Entry, config: JsonObject): boolean {
  if (entry.kind !== 'record' && entry.kind !== 'statement') return false;
  // A first read no check could use at all is not read again: it waits as it is.
  if (entry.unsettled !== undefined) return entry.unsettled !== 'answer_unusable';
  const document = documentOf(entry.engine);
  const quickBooks = vendorChoiceOf(config) === QUICKBOOKS && entry.engine.quickBooks === undefined;
  return document !== undefined && secondReadDue(document, config, quickBooks);
}

/** The ways the second read fails the run (v2's, kept). */
const FAILS = {
  out_of_time: 'ai_unavailable',
  platform_fault: 'ai_unavailable',
  model_account_refused: 'ai_unavailable',
  busy: 'ai_busy',
  file_gone: 'file',
} as const satisfies Readonly<Record<string, RunFail>>;

const failed = (reason: keyof typeof FAILS): StepResult => runFails(FAILS[reason], reason);

/** Each typed refusal: a reason it was not made, or a fault on the platform's side (v2's). */
const REFUSALS: Readonly<Record<ModelRefusalReason, NotMadeReason | 'platform_fault'>> = {
  output_schema_mismatch: 'answer_unusable',
  truncated: 'answer_unusable',
  content_filtered: 'content_filtered',
  over_plan_limit: 'allowance_used',
  capability_not_in_plan: 'plan_without_model_calls',
  entitlements_not_configured: 'plan_check_unavailable',
  no_model_left: 'no_model_left',
  content_type_not_accepted: 'platform_fault',
  file_too_large: 'platform_fault',
  file_content_mismatch: 'platform_fault',
  file_encrypted: 'platform_fault',
  file_integrity: 'platform_fault',
};

/** A refusal the platform answered: why the second read was not made, or the run's failure. */
function refusedWith(error: CallbackRefusedError): NotMadeReason | StepResult {
  if (error instanceof ModelRefusedError) {
    const reason = REFUSALS[error.reason];
    return reason === 'platform_fault' ? failed(reason) : reason;
  }
  const { status, code, reason } = error;
  if (status === 429) return failed('busy');
  if (status === 404) return failed('file_gone');
  if (status === 403 && reason === 'deadline_exceeded') return failed('out_of_time');
  if (status === 503 && code === 'NOT_CONFIGURED') return failed('platform_fault');
  if ((status === 502 || status === 503 || status === 504) && reason === undefined) {
    const upstream = error.details.upstreamStatus;
    if (upstream === '401' || upstream === '402') return failed('model_account_refused');
    return 'no_answer';
  }
  return failed('platform_fault');
}

/** One answer of the second read: the file's count and each document read again, by its place. */
interface VerifyAnswer {
  readonly documentCount: number;
  readonly documents: ReadonlyMap<number, SecondRead>;
}

/** The answer, each document's 14 fields as v2's comparison reads them; undefined when malformed. */
export function verifyAnswerOf(value: unknown): VerifyAnswer | undefined {
  if (!isObject(value) || !Array.isArray(value.documents)) return undefined;
  const count = value.documentCount;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
  const documents = new Map<number, SecondRead>();
  for (const item of value.documents) {
    if (!isObject(item) || !(READ_TYPES as readonly unknown[]).includes(item.documentType)) {
      return undefined;
    }
    const { position, ...fields } = item;
    if (typeof position !== 'number' || !Number.isSafeInteger(position)) return undefined;
    const second = secondReadOf({
      ...fields,
      documentType: V2_TYPES[item.documentType as ReadType],
    });
    if (!second) return undefined;
    documents.set(position, second);
  }
  return { documentCount: count, documents };
}

/** The makers that read the file: the second read leaves them all out. */
function makersOf(state: JsonObject): string[] | undefined {
  const makers = state.readMakers;
  if (!Array.isArray(makers) || makers.length === 0) return undefined;
  const named = makers.filter((maker): maker is string => typeof maker === 'string');
  return named.length === makers.length && excludeModelAuthorsProblem(named) === undefined
    ? named
    : undefined;
}

export function verifyRead(prompt: PromptModule, clock: Pick<Clock, 'now'>): Step {
  return async ({ request, state, platform }) => {
    const run = runStateOf(state);
    if (!run) return runFails('other', 'state_incomplete');
    const doubtful = run.documents.filter((entry) => due(entry, request.config));
    if (doubtful.length === 0) return { outcome: 'skipped' };
    const fileId = isObject(state.file) ? state.file.artifactId : undefined;
    if (typeof fileId !== 'string' || artifactIdProblem(fileId) !== undefined) {
      return failed('platform_fault');
    }
    const makers = makersOf(state);
    const read = new Map<number, Entry>();
    const notMadeAll = (reason: NotMadeReason, entries: readonly Entry[]) =>
      entries.forEach((entry) => read.set(entry.index, notMade(entry, reason)));
    if (makers === undefined) notMadeAll('no_other_maker', doubtful);
    for (
      let at = 0;
      makers !== undefined && at < doubtful.length;
      at += VERIFY_DOCUMENTS_PER_CALL
    ) {
      const chunk = doubtful.slice(at, at + VERIFY_DOCUMENTS_PER_CALL);
      if (Date.parse(request.deadline) - Date.now() < DEFAULT_MODEL_TIMEOUT_MS) {
        return failed('out_of_time');
      }
      let completion: ModelCompletion;
      try {
        completion = await platform.callModel(
          prompt,
          { task: VERIFY_TASK, positions: chunk.map((entry) => entry.index).join(', ') },
          { models: MODELS, excludeModelAuthors: makers, artifactId: fileId },
        );
      } catch (error) {
        if (!(error instanceof CallbackRefusedError) || isUnsent(error)) throw error;
        const reason = refusedWith(error);
        if (typeof reason !== 'string') return reason;
        notMadeAll(reason, chunk);
        continue;
      }
      if (makers.includes(modelAuthor(completion.model) ?? '')) {
        notMadeAll('same_maker', chunk);
        continue;
      }
      let answer: VerifyAnswer | undefined;
      try {
        answer = verifyAnswerOf(readJsonCompletion(completion));
      } catch {
        answer = undefined;
      }
      if (!answer) {
        notMadeAll('answer_unusable', chunk);
        continue;
      }
      const checks = {
        quickBooks: vendorChoiceOf(request.config) === QUICKBOOKS,
        today: utcDay(clock.now()),
        model: completion.model,
      };
      for (const entry of chunk) {
        const second = answer.documents.get(entry.index);
        read.set(
          entry.index,
          answer.documentCount !== run.documents.length
            ? { ...entry, doubts: [...entry.doubts, DOUBTS.count_differs] }
            : second === undefined
              ? notMade(entry, 'answer_unusable')
              : entry.unsettled !== undefined
                ? settled(entry, second, checks)
                : compared(entry, second, checks),
        );
      }
    }
    const entries = run.documents.map((entry) => read.get(entry.index) ?? entry);
    return {
      outcome: 'ok',
      summary: verifyLine(
        doubtful.map((entry) => read.get(entry.index) ?? entry),
        doubtful,
      ),
      state: withEntries(state, entries),
    };
  };
}
