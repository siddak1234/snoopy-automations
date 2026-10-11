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
import { CHECK_DOCUMENT_REASONS, CHECK_DOCUMENT_SENTENCES } from '../checks/rules.js';
import { THROWN_SENTENCES } from '../failures.js';
import { failedWith } from '../outcome.js';
import { compareReads, recheckedWith } from '../reads/compare.js';
import type { DocumentState, NotMadeReason, VerificationState } from '../state.js';
import { MODELS } from './extract.js';

/**
 * `verify-read` (step 8, the second AI step) — a second, blind read of the document by another
 * maker's model, compared with the first by code (the plan's §4; Group 2's D1–D6, Group 3's D8
 * and D9). It sends `prompts/verify-document.v1.json` — read 1's own definitions for the fields
 * that go into QuickBooks, and for a statement the type — with the same fixed task, `MODELS` and
 * the run's file, and leaves out the maker of the model that served the first read, whatever list
 * serves. Nothing of the first read reaches it, nor "Who paid".
 *
 * Where the reads part, the run holds at decide, with both values and what will be written —
 * the first read's, unless the totals differ and only the second agrees with the document's own
 * arithmetic, when it is recorded and the arithmetic is run again. On a statement only the type
 * is compared, and a disagreement fails at decide (F7).
 *
 * A second read that cannot be made — no other maker, a refusal, no usable answer — is recorded,
 * and the run holds at decide: "second check not made" (Group 2's D6). It is never made without
 * the exclusion. Out of time, and a fault on the platform's side, fail. An answer that never came,
 * and a 503 naming no code, are thrown on unchanged, so the runner repeats the call once when
 * nothing was sent, as `extract` does.
 */

/** The user message, fixed, as read 1's: blind — nothing of the first read, nothing a person typed. */
export const VERIFY_INPUT: JsonObject = {
  task: 'Extract the fields of the attached document.',
};

/** The ways the second read fails the run: out of time, or a fault on the platform's side. */
export const VERIFY_READ_SENTENCES = {
  out_of_time:
    'The run ran out of time before the document was checked a second time; start it again with the document.',
  platform_fault:
    'The document could not be checked a second time because of a fault on our side; nothing was created.',
  file_gone: 'The document file is no longer available; start the run again with the document.',
  model_account_refused:
    'Model calls are unavailable on the platform right now; start the run again with the document later.',
  state_incomplete:
    'Bills & Receipts could not finish its checks. Run it again. Nothing was created.',
} as const;

type Fails = keyof typeof VERIFY_READ_SENTENCES;

const WHAT = 'The document was not checked a second time';
/** The re-check after the tie-break (D9) met one of check-document's fail rules. */
const RECHECKED = 'Checked again, not recorded';

function failed(reason: Fails): StepResult {
  return failedWith(WHAT, reason, VERIFY_READ_SENTENCES[reason]);
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

/** The run goes on, the second check not made: decide holds it ("second check not made"). */
function notMade(reason: NotMadeReason, state: JsonObject): StepResult {
  const verification: VerificationState = { status: 'not_made', reason };
  return {
    outcome: 'ok',
    summary: `A second check could not be made (${reason})`,
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
  if (status === 429) return failedWith(WHAT, 'busy', THROWN_SENTENCES.busy);
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

/** The timeline line of a second read made: what it compared, where the reads part, whose total stands. */
export function verifiedSummary(
  model: string,
  verification: Extract<VerificationState, { status: 'made' }>,
): string {
  const head = `Read again by ${truncateText(model, 100)}`;
  const { compared, differences, totalPicked, spendTypeDisputed } = verification;
  const notes: string[] = [];
  if (differences.length === 0) {
    notes.push(
      compared.length === 1
        ? 'the document type agrees'
        : `the ${compared.length} fields compared agree`,
    );
  } else {
    notes.push(`the reads differ on ${namedFields(differences.map((each) => each.field))}`);
  }
  if (totalPicked === 'second') notes.push("the second read's total adds up and is kept");
  if (totalPicked === 'first') notes.push("the first read's total is kept");
  if (spendTypeDisputed) notes.push('spend type disputed, the default category used');
  return truncateText(`${head}: ${notes.join('; ')}`, 200);
}

export function verifyRead(prompt: PromptModule): Step {
  return async ({ request, state, platform }) => {
    const document = documentOf(state);
    const firstModel = state.modelServed;
    if (!document || typeof firstModel !== 'string') return failed('state_incomplete');
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
    if (comparison.totalPicked === 'second' && comparison.secondTotalCents !== null) {
      const rechecked = recheckedWith(document, comparison.secondTotalCents);
      if (rechecked.outcome === 'failed') {
        return failedWith(
          RECHECKED,
          CHECK_DOCUMENT_REASONS[rechecked.rule],
          CHECK_DOCUMENT_SENTENCES[rechecked.rule],
        );
      }
      kept = rechecked.document;
    }
    const verification: VerificationState = {
      status: 'made',
      modelServed: completion.model,
      compared: comparison.compared,
      differences: comparison.differences,
      totalPicked: comparison.totalPicked,
      spendTypeDisputed: comparison.spendTypeDisputed,
    };
    return {
      outcome: 'ok',
      summary: verifiedSummary(completion.model, verification),
      state: {
        ...state,
        document: kept as unknown as JsonObject,
        verification: verification as unknown as JsonObject,
      },
    };
  };
}
