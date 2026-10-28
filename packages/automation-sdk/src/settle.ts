import type { InvokeRequest, JsonObject, ProviderAnswer } from './contract.js';
import { isUnanswered, isUnsent } from './marks.js';
import { CallbackRefusedError, ModelRefusedError } from './refusals.js';
import { isTransient } from './retry.js';
import type { StepContext, StepResult } from './steps.js';
import { FLOW_WORDS, notSentLine } from './words.js';

/**
 * One way for every risky call (Round 21, D2.2): `settle(context, () => call)` gives
 * `{ ok: true, value }` or `{ ok: false, kind, sentence }`, the kind from a closed list and the
 * sentence from `FLOW_WORDS` — never the error's own text, which may carry the document.
 *
 * **It works with the step retry, not around it.** While `context.retryLeft(error)` is true — the
 * runner would run the step again (`defineFlow` sets it per attempt, `flow.ts`) — `settle`
 * rethrows, so a 502 or a dropped answer is retried as today. It answers `{ ok: false }` only
 * once the attempts are used up, the deadline is near, the error is not one the policy repeats
 * (a 4xx, a typed refusal), or the attempt has had a model answer. Under `defineAutomation`
 * there is no `retryLeft`, and it answers at once. An error that is none of the kinds — the
 * step's own mistake — is rethrown, for the runner's standard sentence.
 */

export type SettleKind =
  | 'not_connected'
  | 'not_declared'
  | 'vendor_refused'
  | 'vendor_down'
  | 'unanswered'
  | 'ai_refused'
  | 'timeout';

export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: SettleKind; readonly sentence: string };

interface Kind {
  readonly kind: SettleKind;
  readonly sentence: string;
}

const of = (kind: SettleKind, word: keyof typeof FLOW_WORDS = kind): Kind => ({
  kind,
  sentence: FLOW_WORDS[word],
});

/** The answers a second schema mismatch carried: the run waits for a person (`flow.ts`, Q2). */
const unmatched = new WeakSet<object>();

/** Marks a refusal as the re-asked answer that missed its schema again. */
export function markUnmatched(error: ModelRefusedError): void {
  unmatched.add(error);
}

/** Whether `error` is a re-asked answer that missed its schema again: never settled, always held. */
export function isUnmatched(error: unknown): boolean {
  return typeof error === 'object' && error !== null && unmatched.has(error);
}

/**
 * The kind of a failure, or undefined for one that is none of them (the step's own mistake).
 * Read in this order: the deadline, a typed model refusal, the platform's refusals by callback
 * and status, then no answer at all.
 */
export function kindOf(error: unknown): Kind | undefined {
  if (error instanceof Error && error.name === 'TimeoutError') return of('timeout');
  if (error instanceof ModelRefusedError) {
    return error.reason === 'truncated' ? of('ai_refused', 'ai_too_long') : of('ai_refused');
  }
  if (error instanceof CallbackRefusedError) {
    if (error.reason === 'deadline_exceeded') return of('timeout');
    if (error.reason === 'provider_not_declared') return of('not_declared');
    const provider = error.callback === 'provider';
    if (provider && error.status === 404) return of('not_connected');
    if (error.callback === 'model') return of('unanswered', 'ai_busy');
    if (isTransient(error) || error.status === 429 || isUnsent(error)) {
      return provider ? of('vendor_down') : of('unanswered');
    }
    if (provider) return error.status >= 500 ? of('vendor_down') : of('vendor_refused');
    return of('unanswered');
  }
  if (isUnanswered(error) || isUnsent(error)) return of('unanswered');
  return undefined;
}

/** A provider's own answer inside a 200 that is not a success: the vendor refused, or is down. */
function answerKind(value: unknown): Kind | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value) || !('body' in value)) {
    return undefined;
  }
  const { status } = value as ProviderAnswer;
  if (typeof status !== 'number' || (status >= 200 && status < 300)) return undefined;
  return status >= 500 ? of('vendor_down') : of('vendor_refused');
}

export async function settle<T>(
  context: Pick<StepContext, 'retryLeft'>,
  call: () => Promise<T>,
): Promise<Settled<T>> {
  let value: T;
  try {
    value = await call();
  } catch (error) {
    if (isUnmatched(error) || context.retryLeft?.(error) === true) throw error;
    const kind = kindOf(error);
    if (kind === undefined) throw error;
    return { ok: false, ...kind };
  }
  const refused = answerKind(value);
  return refused === undefined ? { ok: true, value } : { ok: false, ...refused };
}

const codes = new WeakMap<object, string>();

/** The code a step's result carries for the log (`failed`); none for any other result. */
export function codeOf(result: StepResult): string | undefined {
  return codes.get(result);
}

/**
 * The step ends the run with `sentence`, which people read as its line and the run's reason;
 * `code` goes to the log alone (`defineFlow` logs it with the step). Replaces each flow's own
 * `failedWith` and `stops`.
 */
export function failed(sentence: string, code?: string): StepResult {
  const result: StepResult = { outcome: 'failed', summary: sentence, failureReason: sentence };
  if (code !== undefined) codes.set(result, code);
  return result;
}

/**
 * An optional connection (Round 21, D2.3), read from the setup field `key` that names
 * `providerId` when the person chose it (`connection` control; generalises Invoice Processing's
 * `vendorChoiceOf`). Not chosen: the step returns `skipped`. Chosen and not connected —
 * `settle`'s `not_connected` — the step returns `notConnected`: failed WITHOUT a failure reason,
 * so the run goes on, and the line says where it was not sent.
 */
export function optionalConnection(
  request: Pick<InvokeRequest, 'config'>,
  key: string,
  providerId: string,
): {
  readonly chosen: boolean;
  notConnected(displayName: string, state?: JsonObject): StepResult;
} {
  return {
    chosen: request.config[key] === providerId,
    notConnected: (displayName, state) => ({
      outcome: 'failed',
      summary: notSentLine(displayName),
      ...(state === undefined ? {} : { state }),
    }),
  };
}
