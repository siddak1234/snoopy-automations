import {
  CallbackRefusedError,
  DEFAULT_MODEL_TIMEOUT_MS,
  ModelRefusedError,
  artifactIdProblem,
  isObject,
  isUnsent,
  readJsonCompletion,
  type JsonObject,
  type ModelCompletion,
  type ModelRefusalReason,
  type PromptModule,
  type Step,
  type StepResult,
} from '@autom8x/automation-sdk';

import { cleanCurrency, cleanText, toCents } from '@autom8x/automation-kit/values';

import {
  DOCUMENT_TYPES,
  LISTED_KINDS,
  PAYMENT_METHODS,
  REFUND_METHODS,
  type DocumentType,
} from '../document.js';
import { runFails } from '../outcome.js';
import { SPEND_TYPES } from '../spend-types.js';
import type { ExtractionState } from '../state.js';
import { DOCUMENT_WORDS, lineWith, money, type RunFail } from '../words.js';

/**
 * `extract` — the platform's model reads the document — a bill, a receipt, a credit note or a
 * statement — into the 27 fields of `prompts/extract-document.v1.json`, so the next steps can
 * check them. It reads nothing else, decides nothing and writes nothing to QuickBooks (the
 * owner's design of 2026-10-10, and the plan of 2026-10-11, §4).
 *
 * One call through the platform's model callback: the registered prompt, a fixed user message,
 * `MODELS`, and the run's file by the id `receive` kept — never its bytes, which the platform
 * reads and sends itself. The platform asks one model per attempt and falls to the next on an
 * unusable answer, so the step sees the first usable answer or the last refusal. A refusal the
 * platform answered ends the run with one of the spec's sentences, its reason word in the log;
 * an answer that never came, and a 503 naming no code (a page from in front of the platform), is
 * thrown on unchanged, so the runner repeats the step once when nothing was sent. The answer is
 * kept whole in the state; the timeline line says what it read, its seller and its total. Every
 * run takes this step, whatever the vendor: ONE model call per document unless the first read
 * shows a problem (decision 3, `verify-read`).
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

/**
 * The user message, fixed: nothing a person typed and nothing read from the document is in it.
 */
export const EXTRACT_INPUT: JsonObject = {
  task: 'Extract the fields of the attached document.',
};

/**
 * Why the first read ends the run, each a code for the log and one of the spec's sentences
 * (§3.F): the file could not be opened, the answer cannot be read, AI is busy for now, or the
 * document cannot be read right now — model calls off, out of plan, out of time, a fault on our
 * side. Never the model's text.
 */
export const EXTRACT_FAILS = {
  answer_unusable: 'unreadable',
  content_filtered: 'unreadable',
  plan_without_model_calls: 'ai_unavailable',
  plan_check_unavailable: 'ai_unavailable',
  allowance_used: 'ai_unavailable',
  model_calls_off: 'ai_unavailable',
  model_account_refused: 'ai_unavailable',
  out_of_time: 'ai_unavailable',
  platform_fault: 'ai_unavailable',
  no_answer: 'ai_busy',
  busy: 'ai_busy',
  file_type: 'file',
  file_too_large: 'file',
  file_mismatch: 'file',
  file_encrypted: 'file',
  file_integrity: 'file',
  file_gone: 'file',
} as const satisfies Readonly<Record<string, RunFail>>;

type Reason = keyof typeof EXTRACT_FAILS;

/**
 * Each typed refusal's reason word. `no_model_left` answers a call that leaves out a maker,
 * which this one never does: a fault on our side. Typed against the SDK's closed list, so a
 * reason it gains fails the build here until it is given its sentence.
 */
const MODEL_REFUSALS: Readonly<Record<ModelRefusalReason, Reason>> = {
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

function failed(reason: Reason): StepResult {
  return runFails(EXTRACT_FAILS[reason], reason);
}

/**
 * The timeline line (§3.E): `Read: bill from Harrowgate Office Supply, $461.53` — what the first
 * read says the document is, its seller and its total, each cleaned and bounded; a part not read
 * is left out. Never a line item, nor anything else the model wrote.
 */
export function readLine(answer: JsonObject): string {
  const type = DOCUMENT_WORDS[answer.documentType as DocumentType] ?? 'document';
  const seller = cleanText(answer.vendorName);
  const total = toCents(answer.total);
  const currency = cleanCurrency(answer.currency);
  const amount =
    total.kind === 'cents'
      ? `, ${money(Math.abs(total.cents), currency.kind === 'code' ? currency.code : null)}`
      : '';
  return seller === null
    ? lineWith(`Read: ${type}`, '', amount)
    : lineWith(`Read: ${type} from `, seller, amount);
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
    const { lineItems, listedItems, uncertainFields } = answer;
    if (
      !Array.isArray(lineItems) ||
      !Array.isArray(listedItems) ||
      !Array.isArray(uncertainFields) ||
      !listedItems.every((row) => isObject(row) && isOneOf(row.kind, LISTED_KINDS)) ||
      !isOneOf(answer.documentType, DOCUMENT_TYPES) ||
      !isOneOf(answer.paymentMethod, PAYMENT_METHODS) ||
      !isOneOf(answer.refundMethod, REFUND_METHODS) ||
      !isOneOf(answer.spendType, SPEND_TYPES)
    ) {
      return failed('answer_unusable');
    }
    const extracted: ExtractionState = { extraction: answer, modelServed: completion.model };
    return { outcome: 'ok', summary: readLine(answer), state: { ...state, ...extracted } };
  };
}

/** One of a list's values: the shape check of a field the prompt gives a list. */
function isOneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
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
    return failed(reason);
  }
  const { status, code, reason } = error;
  // The Edge's flood valve, as at every step of this automation.
  if (status === 429) return failed('busy');
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
