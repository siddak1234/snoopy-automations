import {
  CallbackRefusedError,
  ModelRefusedError,
  type ModelRefusalReason,
  type StepResult,
} from '@autom8x/automation-sdk';

import { runFails } from '../outcome.js';
import type { RunFail } from '../words.js';

/**
 * How a refusal of the first read ends the run (v2's `extract`, kept): each a code for the log and
 * one of the spec's sentences (§3.F) — the file could not be opened, the answer cannot be read, AI
 * is busy for now, or the document cannot be read right now: model calls off, out of plan, out of
 * time, a fault on our side. Never the model's text.
 */

/**
 * The models the reads ask for: the primary, then a fallback by another maker — on 2026-10-10 both
 * had a US zero-retention endpoint taking the call's parameters within the price ceiling, and
 * neither thinks above low by default (README, "Pick a model"). The owner picks the final models.
 */
export const MODELS: readonly string[] = [
  'anthropic/claude-haiku-4.5',
  'google/gemini-3.1-flash-lite',
];

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
  none_found: 'none_found',
} as const satisfies Readonly<Record<string, RunFail>>;

export type ExtractFail = keyof typeof EXTRACT_FAILS;

/**
 * Each typed refusal's reason word. `no_model_left` answers a call that leaves out a maker, which
 * the first read never does: a fault on our side. Typed against the SDK's closed list, so a reason
 * it gains fails the build here until it is given its sentence.
 */
const MODEL_REFUSALS: Readonly<Record<ModelRefusalReason, ExtractFail>> = {
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

export function extractFailed(reason: ExtractFail): StepResult {
  return runFails(EXTRACT_FAILS[reason], reason);
}

/** A refusal the platform answered, as the reason word and the sentence it ends the run with. */
export function extractRefused(error: CallbackRefusedError): StepResult {
  if (error instanceof ModelRefusedError) return extractFailed(MODEL_REFUSALS[error.reason]);
  const { status, code, reason } = error;
  // The Edge's flood valve, as at every step of this automation.
  if (status === 429) return extractFailed('busy');
  if (status === 503 && code === 'NOT_CONFIGURED') return extractFailed('model_calls_off');
  if (status === 404) return extractFailed('file_gone');
  if (status === 403 && reason === 'deadline_exceeded') return extractFailed('out_of_time');
  if ((status === 502 || status === 503 || status === 504) && reason === undefined) {
    // OpenRouter refusing the platform's key or credit ends the call: no model would answer.
    const upstream = error.details.upstreamStatus;
    return extractFailed(
      upstream === '401' || upstream === '402' ? 'model_account_refused' : 'no_answer',
    );
  }
  return extractFailed('platform_fault');
}
