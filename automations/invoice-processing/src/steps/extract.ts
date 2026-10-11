import {
  CallbackRefusedError,
  DEFAULT_MODEL_TIMEOUT_MS,
  ModelRefusedError,
  artifactIdProblem,
  isObject,
  isUnsent,
  readJsonCompletion,
  truncateText,
  type JsonObject,
  type ModelCompletion,
  type ModelRefusalReason,
  type PromptModule,
  type Step,
  type StepResult,
} from '@autom8x/automation-sdk';

import { THROWN_SENTENCES } from '../failures.js';
import { failedWith, grouped } from '../outcome.js';
import type { ExtractionState } from '../state.js';

/**
 * `extract` — the platform's model reads the invoice into the 18 fields of
 * `prompts/extract-invoice.v1.json`, so the next steps can check them. It reads nothing else,
 * decides nothing and writes nothing to QuickBooks (the owner's design of 2026-10-10).
 *
 * One call through the platform's model callback: the registered prompt, a fixed user message,
 * `MODELS`, and the run's file by the id `receive` kept — never its bytes, which the platform
 * reads and sends itself. The platform asks one model per attempt and falls to the next on an
 * unusable answer, so the step sees the first usable answer or the last refusal. A refusal the
 * platform answered ends the run with a fixed sentence and puts its reason word in the
 * timeline; an answer that never came, and a 503 naming no code (a page from in front of the
 * platform), is thrown on unchanged, so the runner repeats the step once when nothing was
 * sent. The answer is kept whole in the state and never quoted: the timeline line names the
 * model that served and two counts.
 */

/**
 * The models the call asks for: the primary, then a fallback by another maker — on 2026-10-10
 * both had a US zero-retention endpoint taking the call's parameters within the price ceiling,
 * and neither thinks above low by default (README, "Pick a model"). The owner's setting for
 * this automation wins over the list, and the owner picks the final models last.
 */
export const MODELS: readonly string[] = [
  'anthropic/claude-haiku-4.5',
  'google/gemini-3.1-flash-lite',
];

/** The user message, fixed: nothing a person typed and nothing read from the invoice is in it. */
export const EXTRACT_INPUT: JsonObject = {
  task: 'Extract the fields of the attached supplier invoice.',
};

/** Each refusal's sentence: the run's reason, at most 200 characters, never the model's text. */
export const EXTRACT_SENTENCES = {
  answer_unusable: 'The invoice could not be read; try a clearer photo or the PDF.',
  content_filtered: 'The model provider declined to read this document.',
  plan_without_model_calls: "This workspace's plan does not include model calls.",
  plan_check_unavailable:
    "Model calls could not be checked against this workspace's plan just now; start the run again with the invoice later.",
  model_calls_off: 'Model calls are not switched on yet.',
  no_answer:
    'No model could read the invoice just now, and nothing was created. Start the run again with the invoice in a few minutes.',
  model_account_refused:
    'Model calls are unavailable on the platform right now; start the run again with the invoice later.',
  file_type: 'The invoice must be a PDF, JPEG or PNG file.',
  file_too_large: 'The invoice file is larger than 3.5 MB.',
  file_mismatch: 'The invoice file is not the type it says it is; upload the PDF or photo again.',
  file_encrypted: 'The PDF is password-protected; upload a copy without a password.',
  file_integrity:
    'The invoice file could not be read back from storage; start the run again with the invoice.',
  file_gone: 'The invoice file is no longer available; start the run again with the invoice.',
  out_of_time:
    'The run ran out of time before the invoice was read; start it again with the invoice.',
  platform_fault:
    'The invoice could not be sent to be read because of a fault on our side; nothing was created.',
} as const;

type Reason = keyof typeof EXTRACT_SENTENCES;

/** `over_plan_limit`'s sentence: the plan's limit when the platform sent one. */
export function allowanceUsed(limit: number | undefined): string {
  return limit === undefined
    ? 'This workspace has used its model calls this month.'
    : `This workspace has used its ${grouped(limit)} model calls this month.`;
}

/**
 * Each typed refusal's reason word. `no_model_left` answers a call that leaves out a maker,
 * which this one never does: a fault on our side. Typed against the SDK's closed list, so a
 * reason it gains fails the build here until it is given its sentence.
 */
const MODEL_REFUSALS: Readonly<Record<ModelRefusalReason, Reason | 'allowance_used'>> = {
  output_schema_mismatch: 'answer_unusable',
  truncated: 'answer_unusable',
  content_filtered: 'content_filtered',
  over_plan_limit: 'allowance_used',
  capability_not_in_plan: 'plan_without_model_calls',
  entitlements_not_configured: 'plan_check_unavailable',
  content_type_not_accepted: 'file_type',
  file_too_large: 'file_too_large',
  file_content_mismatch: 'file_mismatch',
  file_encrypted: 'file_encrypted',
  file_integrity: 'file_integrity',
  no_model_left: 'platform_fault',
};

const WHAT = 'The invoice could not be read';

function failed(reason: Reason): StepResult {
  return failedWith(WHAT, reason, EXTRACT_SENTENCES[reason]);
}

export function extract(prompt: PromptModule): Step {
  return async ({ request, state, platform }) => {
    const artifactId = artifactIdOf(state);
    if (artifactId === undefined) return failed('platform_fault');
    // Not a call whose answer could not be reported before the deadline: past it the platform
    // refuses every callback. A deadline that does not parse goes on, for the platform to hold.
    if (Date.parse(request.deadline) - Date.now() < DEFAULT_MODEL_TIMEOUT_MS) {
      return failed('out_of_time');
    }
    let completion: ModelCompletion;
    try {
      completion = await platform.callModel(prompt, EXTRACT_INPUT, { models: MODELS, artifactId });
    } catch (error) {
      if (error instanceof CallbackRefusedError && !isUnsent(error)) return refused(error);
      throw error;
    }
    let answer: JsonObject;
    try {
      answer = readJsonCompletion(completion);
    } catch {
      return failed('answer_unusable');
    }
    // The shape only, never a value: the platform held the answer to the schema, and every
    // check of a value is the next step's.
    const { documentType, lineItems, lineItemsComplete, uncertainFields } = answer;
    if (
      typeof documentType !== 'string' ||
      !Array.isArray(lineItems) ||
      !Array.isArray(uncertainFields)
    ) {
      return failed('answer_unusable');
    }
    const lines = `${lineItems.length} ${lineItems.length === 1 ? 'line' : 'lines'}`;
    const more = lineItemsComplete === false ? ' (more on the invoice)' : '';
    const extracted: ExtractionState = { extraction: answer, modelServed: completion.model };
    return {
      outcome: 'ok',
      summary: `Read the invoice with ${truncateText(completion.model, 100)}: ${lines}${more}, ${uncertainFields.length} unclear`,
      state: { ...state, ...extracted },
    };
  };
}

/** The upload `receive` kept, in the platform's id shape; anything else is no file to send. */
function artifactIdOf(state: JsonObject): string | undefined {
  const id = isObject(state.file) ? state.file.artifactId : undefined;
  return typeof id === 'string' && artifactIdProblem(id) === undefined ? id : undefined;
}

/** A refusal the platform answered, as the reason word and the sentence it ends the run with. */
function refused(error: CallbackRefusedError): StepResult {
  if (error instanceof ModelRefusedError) {
    const reason = MODEL_REFUSALS[error.reason];
    return reason === 'allowance_used'
      ? failedWith(WHAT, reason, allowanceUsed(error.limit))
      : failed(reason);
  }
  const { status, code, reason } = error;
  // The Edge's flood valve, as at every step of this automation.
  if (status === 429) return failedWith(WHAT, 'busy', THROWN_SENTENCES.busy);
  if (status === 503 && code === 'NOT_CONFIGURED') return failed('model_calls_off');
  if (status === 404) return failed('file_gone');
  if (status === 403 && reason === 'deadline_exceeded') return failed('out_of_time');
  if ((status === 502 || status === 503 || status === 504) && reason === undefined) {
    // OpenRouter refusing the platform's key or credit ends the call: no model would answer.
    const upstream = error.details.upstreamStatus;
    return failed(upstream === '401' || upstream === '402' ? 'model_account_refused' : 'no_answer');
  }
  return failed('platform_fault');
}
