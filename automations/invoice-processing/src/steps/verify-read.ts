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
  truncateText,
  type JsonObject,
  type ModelCompletion,
  type ModelRefusalReason,
  type PromptModule,
  type Step,
  type StepResult,
} from '@autom8x/automation-sdk';

import { secondReadOf } from '../checks/answers.js';
import { namedFields } from '../checks/fields.js';
import { RECORDING_RULES, type RecordingRule } from '../checks/rules.js';
import { limitCentsOf } from '../decide/holds.js';
import { runFails } from '../outcome.js';
import { notRecorded, onQuickBooksPath } from '../quickbooks-path.js';
import { compareReads, recheckedWith } from '../reads/compare.js';
import type { DocumentState, Finding, NotMadeReason, VerificationState } from '../state.js';
import { LINE_MAXIMUM, type RunFail } from '../words.js';
import { MODELS } from './extract.js';

/**
 * `verify-read` (the second AI step) — made ONLY when the first read shows a problem (the
 * session's decision 3, approved in advance by the owner's "approve. complete"; the owner's "Why
 * are there so many ai steps", build 19): after check-document, its findings include totals that
 * don't add up, unclear fields or a total not cross-checked — or, on the QuickBooks path, the
 * amount is over the flow's approval limit (`secondReadDue`). Otherwise it is skipped, and there is
 * no second read (`{ status: 'not_needed' }`). One model call per document, then; two only on a
 * problem.
 *
 * When due: a second, blind read of the document by another maker's model, compared with the first
 * by code (the plan's §4; Group 2's D1–D6, Group 3's D8 and D9). It sends
 * `prompts/verify-document.v1.json` — unchanged, so its recordings stay valid — with the same
 * fixed task, `MODELS` and the run's file, and leaves out the maker of the model that served the
 * first read. Where the reads part, the run holds at decide on the QuickBooks path, with both
 * values and what will be written — the first read's, unless the totals differ and only the second
 * agrees with the document's own arithmetic, when it is recorded and the arithmetic run again. On
 * a statement only the type is compared, and a disagreement keeps it from being recorded (F7).
 *
 * A second read that cannot be made — no other maker, a refusal, no usable answer — is recorded,
 * and the run holds at decide: "second read not made" (Group 2's D6). Out of time, and a fault on
 * the platform's side, fail. An answer that never came, and a 503 naming no code, are thrown on
 * unchanged, so the runner repeats the call once when nothing was sent, as `extract` does.
 */

/** The findings that call for a second read (decision 3). */
const PROBLEMS: ReadonlySet<Finding> = new Set([
  'amounts_mismatch',
  'unclear_fields',
  'not_cross_checked',
]);

/**
 * Whether a second read is due: the first read's checks found a problem, or — on the QuickBooks
 * path, where a person approves what is recorded — the amount is over the flow's approval limit
 * (`config.holdAboveAmount`, $500 when it is not a usable amount).
 */
export function secondReadDue(
  document: Pick<DocumentState, 'findings' | 'amountCents'>,
  config: JsonObject,
  quickBooks: boolean,
): boolean {
  if (document.findings.some((finding) => PROBLEMS.has(finding))) return true;
  return quickBooks && (document.amountCents ?? 0) > limitCentsOf(config);
}

/** The user message, fixed, as read 1's: blind — nothing of the first read, nothing a person typed. */
export const VERIFY_INPUT: JsonObject = {
  task: 'Extract the fields of the attached document.',
};

/** The ways the second read fails the run, each a code for the log and the spec's sentence (§3.F). */
export const VERIFY_READ_FAILS = {
  out_of_time: 'ai_unavailable',
  platform_fault: 'ai_unavailable',
  model_account_refused: 'ai_unavailable',
  busy: 'ai_busy',
  file_gone: 'file',
  state_incomplete: 'other',
} as const satisfies Readonly<Record<string, RunFail>>;

type Fails = keyof typeof VERIFY_READ_FAILS;

function failed(reason: Fails): StepResult {
  return runFails(VERIFY_READ_FAILS[reason], reason);
}

/**
 * Each typed refusal of the second read: a reason it was not made — the run holds — or a fault on
 * the platform's side, which fails. The file was read once already, so a refusal of it now is the
 * platform's. Typed against the SDK's closed list, so a reason it gains fails the build here.
 */
const SECOND_READ_REFUSALS: Readonly<Record<ModelRefusalReason, NotMadeReason | 'platform_fault'>> =
  {
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

/** The run goes on, the second read not made: decide holds it ("second read not made"). */
function notMade(reason: NotMadeReason, state: JsonObject): StepResult {
  const verification: VerificationState = { status: 'not_made', reason };
  return {
    outcome: 'ok',
    summary: 'Second read not made',
    state: { ...state, verification: verification as unknown as JsonObject },
  };
}

/** A refusal the platform answered: not made (the run holds), or a failure. */
function refused(error: CallbackRefusedError, state: JsonObject): StepResult {
  if (error instanceof ModelRefusedError) {
    const reason = SECOND_READ_REFUSALS[error.reason];
    return reason === 'platform_fault' ? failed(reason) : notMade(reason, state);
  }
  const { status, code, reason } = error;
  if (status === 429) return failed('busy');
  if (status === 404) return failed('file_gone');
  if (status === 403 && reason === 'deadline_exceeded') return failed('out_of_time');
  if (status === 503 && code === 'NOT_CONFIGURED') return failed('platform_fault');
  if ((status === 502 || status === 503 || status === 504) && reason === undefined) {
    // OpenRouter refusing the platform's own key or credit: the platform's, so it fails.
    const upstream = error.details.upstreamStatus;
    if (upstream === '401' || upstream === '402') return failed('model_account_refused');
    // No model answered usably: the second check was not made.
    return notMade('no_answer', state);
  }
  return failed('platform_fault');
}

/** check-document's state, when it is there. */
function documentOf(state: JsonObject): DocumentState | undefined {
  const document = state.document;
  return isObject(document) && typeof document.route === 'string' && isObject(document.arithmetic)
    ? (document as unknown as DocumentState)
    : undefined;
}

/** The timeline line of a second read made (§3.E): `Second read matches`, or where the reads part. */
export function verifiedSummary(
  verification: Extract<VerificationState, { status: 'made' }>,
): string {
  const { differences } = verification;
  if (differences.length === 0) return 'Second read matches';
  return truncateText(
    `Second read differs: ${namedFields(differences.map((each) => each.field))}`,
    LINE_MAXIMUM,
  );
}

export function verifyRead(prompt: PromptModule): Step {
  return async ({ request, state, platform }) => {
    const document = documentOf(state);
    const firstModel = state.modelServed;
    if (!document || typeof firstModel !== 'string') return failed('state_incomplete');
    const quickBooks = onQuickBooksPath(request, state);
    if (!secondReadDue(document, request.config, quickBooks)) return { outcome: 'skipped' };
    const fileId = isObject(state.file) ? state.file.artifactId : undefined;
    if (typeof fileId !== 'string' || artifactIdProblem(fileId) !== undefined) {
      return failed('platform_fault');
    }
    // Not a call whose answer could not be reported before the deadline, as `extract`.
    if (Date.parse(request.deadline) - Date.now() < DEFAULT_MODEL_TIMEOUT_MS) {
      return failed('out_of_time');
    }
    // Another maker's, or no second read at all: never a call without the exclusion.
    const maker = modelAuthor(firstModel);
    if (maker === undefined || excludeModelAuthorsProblem([maker]) !== undefined) {
      return notMade('no_other_maker', state);
    }
    let completion: ModelCompletion;
    try {
      completion = await platform.callModel(prompt, VERIFY_INPUT, {
        models: MODELS,
        excludeModelAuthors: [maker],
        artifactId: fileId,
      });
    } catch (error) {
      if (error instanceof CallbackRefusedError && !isUnsent(error)) return refused(error, state);
      throw error;
    }
    if (modelAuthor(completion.model) === maker) return notMade('same_maker', state);
    let answer: JsonObject;
    try {
      answer = readJsonCompletion(completion);
    } catch {
      return notMade('answer_unusable', state);
    }
    const second = secondReadOf(answer);
    if (!second) return notMade('answer_unusable', state);

    const comparison = compareReads(document, second);
    let kept = document;
    let rule: RecordingRule | undefined;
    if (comparison.totalPicked === 'second' && comparison.secondTotalCents !== null) {
      const rechecked = recheckedWith(document, comparison.secondTotalCents);
      kept = rechecked.document;
      // A recording rule the new total meets keeps it out of QuickBooks; with "None", none applies.
      rule = quickBooks ? rechecked.rule : undefined;
    }
    const verification: VerificationState = {
      status: 'made',
      modelServed: completion.model,
      compared: comparison.compared,
      differences: comparison.differences,
      totalPicked: comparison.totalPicked,
      spendTypeDisputed: comparison.spendTypeDisputed,
    };
    const next = {
      ...state,
      document: kept as unknown as JsonObject,
      verification: verification as unknown as JsonObject,
    };
    if (rule !== undefined) return notRecorded(next, RECORDING_RULES[rule], 'ok');
    return { outcome: 'ok', summary: verifiedSummary(verification), state: next };
  };
}
