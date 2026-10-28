import type { InvokeRequest, JsonObject, ProviderAnswer } from './contract.js';
import { isUnanswered, isUnsent } from './marks.js';
import { CallbackRefusedError, ModelRefusedError, type ModelRefusalReason } from './refusals.js';
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
 *
 * **A provider call nothing answered is `unconfirmed`**, not `vendor_down`: unless it provably
 * never left (`isUnsent`), the app may have done it, and a re-run carries a new run's key, so the
 * sentence says to check the app, never "Try again" (Invoice Processing's `UNCONFIRMED_LINE`).
 * Under `defineFlow` each attempt's context also carries `log`, and `settle` logs `settled` with
 * the kind and the error's shape (`shapeOf`) — never its text.
 *
 * **Once a provider call in the run may have written** (`context.wrote()`, `defineFlow`'s per-run
 * note), every failure but `unconfirmed` keeps its kind and takes `FLOW_WORDS.after_write` as its
 * sentence: "Connect it, then run it again" after an earlier step's write would make that write
 * again under a new run's key.
 */

export type SettleKind =
  | 'not_connected'
  | 'not_declared'
  | 'vendor_refused'
  | 'vendor_down'
  | 'unconfirmed'
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

/** The provider calls nothing answered that were not provably unsent (`defineFlow` marks them). */
const unconfirmed = new WeakSet<object>();

/**
 * Whether a provider call's `error` leaves the app's side unknown: no answer at all, a timeout,
 * or a 502/503/504 that decided nothing — unless it provably never left (`isUnsent`).
 */
export function leavesUnconfirmed(error: unknown): boolean {
  if (isUnsent(error)) return false;
  if (error instanceof CallbackRefusedError) return isTransient(error);
  return isUnanswered(error) || (error instanceof Error && error.name === 'TimeoutError');
}

/** Marks `error`, thrown by a provider call, as one nothing answered (`defineFlow`). */
export function markUnconfirmed(error: unknown): void {
  if (typeof error === 'object' && error !== null) unconfirmed.add(error);
}

/** The sentence for a typed model refusal: by what a person can do about it. */
const MODEL_WORDS: Partial<Record<ModelRefusalReason, keyof typeof FLOW_WORDS>> = {
  truncated: 'ai_too_long',
  over_plan_limit: 'ai_allowance',
  capability_not_in_plan: 'ai_setup',
  entitlements_not_configured: 'ai_setup',
  no_model_left: 'ai_setup',
};

/**
 * The kind of a failure, or undefined for one that is none of them (the step's own mistake).
 * Read in this order: a provider call nothing answered, the deadline, a typed model refusal, the
 * platform's refusals by callback and status, then no answer at all.
 */
export function kindOf(error: unknown): Kind | undefined {
  if (typeof error === 'object' && error !== null && unconfirmed.has(error)) {
    return of('unconfirmed');
  }
  if (error instanceof Error && error.name === 'TimeoutError') return of('timeout');
  if (error instanceof ModelRefusedError) return of('ai_refused', MODEL_WORDS[error.reason]);
  if (error instanceof CallbackRefusedError) {
    if (error.reason === 'deadline_exceeded') return of('timeout');
    if (error.reason === 'provider_not_declared') return of('not_declared');
    const provider = error.callback === 'provider';
    if (provider && error.status === 404) return of('not_connected');
    if (error.callback === 'model') return modelKind(error);
    if (provider && leavesUnconfirmed(error)) return of('unconfirmed');
    if (isTransient(error) || error.status === 429 || isUnsent(error)) {
      return provider ? of('vendor_down') : of('unanswered');
    }
    if (provider) return error.status >= 500 ? of('vendor_down') : of('vendor_refused');
    return of('unanswered');
  }
  if (isUnanswered(error) || isUnsent(error)) return of('unanswered');
  return undefined;
}

/**
 * A model callback's untyped refusal: "AI is busy" only for what may clear on its own — a 502/503/504
 * that decided nothing, a 429, or one that provably never left. A 413 is the file, too large; a 400
 * the flow's own request; any other the general sentence. Retrying none of those changes anything.
 */
function modelKind(error: CallbackRefusedError): Kind {
  if (isTransient(error) || error.status === 429 || isUnsent(error)) {
    return of('unanswered', 'ai_busy');
  }
  if (error.status === 413) return of('ai_refused', 'ai_too_large');
  if (error.status === 400) return of('ai_refused', 'ai_request');
  return of('ai_refused', 'other');
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
  context: Pick<StepContext, 'retryLeft' | 'log' | 'wrote'>,
  call: () => Promise<T>,
): Promise<Settled<T>> {
  const worded = (kind: Kind): Kind =>
    kind.kind !== 'unconfirmed' && context.wrote?.() === true
      ? { kind: kind.kind, sentence: FLOW_WORDS.after_write }
      : kind;
  let value: T;
  try {
    value = await call();
  } catch (error) {
    if (isUnmatched(error) || context.retryLeft?.(error) === true) throw error;
    const kind = kindOf(error);
    if (kind === undefined) throw error;
    context.log?.('info', 'settled', { kind: kind.kind, ...shapeOf(error) });
    return { ok: false, ...worded(kind) };
  }
  const refused = answerKind(value);
  if (refused === undefined) return { ok: true, value };
  context.log?.('info', 'settled', {
    kind: refused.kind,
    status: (value as ProviderAnswer).status,
  });
  return { ok: false, ...worded(refused) };
}

/** What the log keeps of an error: its name, and a refusal's status, code and reason — never its text. */
export function shapeOf(error: unknown): Record<string, unknown> {
  if (error instanceof CallbackRefusedError) {
    return {
      error: error.name,
      status: error.status,
      code: error.code ?? null,
      reason: error.reason ?? null,
    };
  }
  return { error: error instanceof Error ? error.name : typeof error };
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
 * `vendorChoiceOf`), given the step's context. Not chosen: the step returns `skipped`. Chosen and
 * not connected — `settle`'s `not_connected` — the step returns `notConnected`: failed WITHOUT a
 * failure reason, so the run goes on, and the line says where it was not sent; under
 * `defineFlow` the log gets `not_connected` with the provider's id.
 */
export function optionalConnection(
  context: { readonly request: Pick<InvokeRequest, 'config'> } & Pick<StepContext, 'log'>,
  key: string,
  providerId: string,
): {
  readonly chosen: boolean;
  notConnected(displayName: string, state?: JsonObject): StepResult;
} {
  return {
    chosen: context.request.config[key] === providerId,
    notConnected: (displayName, state) => {
      context.log?.('info', 'not_connected', { providerId });
      return {
        outcome: 'failed',
        summary: notSentLine(displayName),
        ...(state === undefined ? {} : { state }),
      };
    },
  };
}
