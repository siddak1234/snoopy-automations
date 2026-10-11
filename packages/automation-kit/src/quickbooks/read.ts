import { setTimeout as sleepFor } from 'node:timers/promises';

import type {
  CallbackRefusedError,
  JsonObject,
  ProviderAnswer,
  StepPlatform,
} from '@autom8x/automation-sdk';

import { faultOf } from './answers.js';

/**
 * One QuickBooks READ through the SDK's provider call, judged the way every step that
 * reads QuickBooks must judge it — so each step makes one request and turns every way
 * it can end into a fixed, plain sentence.
 *
 * **One request.** The same operation and input on every try, so the platform attaches
 * the step's one idempotency key to identical requests: Connections replays a recorded
 * final answer for the key and refuses a different request under it with 409.
 *
 * **QuickBooks' own status comes back inside a successful callback** (the SDK never
 * repeats it; it is the step's to judge): a 429 waits `THROTTLE_WAIT_MS` and asks again,
 * at most `MAX_THROTTLE_WAITS` times and only while `RESERVE_AFTER_WAIT_MS` of the run
 * would remain after the wait; a 5xx asks again at once, `MAX_SERVER_ERROR_REPEATS`
 * time; then, and for a 408 or 425, QuickBooks is busy. Connections records none of
 * these, so each repeat reaches QuickBooks. A 401 (Connections has already marked the
 * connection for reconnection) and a 403 are the person's to fix; any other status, or a
 * Fault inside a 2xx, is an error named by its numeric code alone — Intuit's `Message`
 * and `Detail` are never read.
 *
 * **The platform's refusals** that name a cause are answered with a sentence: not
 * connected (404), the accounting scope missing (400 `insufficient_scope`), Connections
 * not configured (503 `connections_not_configured`), and the refusals only a bug
 * produces (another 400, 409 `idempotency_key_reused`, 403 `provider_not_declared`).
 * Every other failure is THROWN UNCHANGED — the same object — so the SDK's step retry
 * can see a transient one (no answer, a reasonless 502/503/504) and the run's own
 * wrapper can give its sentence when the attempts are spent: `qb_unreachable` below.
 *
 * READS ONLY: a repeated write could create a second record. The wait is the injected
 * `clock`'s, so a suite never waits a minute.
 */

/** How a read waits, and what time it is. A suite passes its own. */
export interface Clock {
  /** Milliseconds since the epoch, as `Date.now()` reads them. */
  now(): number;
  /** Resolves after `milliseconds`. */
  sleep(milliseconds: number): Promise<unknown>;
}

/** The real clock: `Date.now()` and `setTimeout` from `node:timers/promises`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) => sleepFor(milliseconds),
};

/** Intuit on a 429: "If you see this, wait 60 seconds before retrying the request." */
export const THROTTLE_WAIT_MS = 60_000;
/** The most 429 waits one read makes. */
const MAX_THROTTLE_WAITS = 2;
/**
 * A 429 wait happens only while this much of the run remains after it: time for the run's
 * later QuickBooks calls and its model call, which the SDK waits up to 260 s for.
 */
export const RESERVE_AFTER_WAIT_MS = 300_000;
/** Intuit on a 500: "Resubmit the request once." */
const MAX_SERVER_ERROR_REPEATS = 1;

/** How a QuickBooks read can fail, each with its sentence below. */
export type QuickBooksFailureReason =
  | 'qb_not_connected'
  | 'qb_reauthorize'
  | 'qb_forbidden'
  | 'qb_missing_scope'
  | 'qb_not_configured'
  | 'qb_busy'
  | 'qb_error'
  | 'platform_refused';

/**
 * The fixed sentences. `qb_error` and `platform_refused` are built by `readQuickBooks`
 * around a code or a reason word. Two more belong to every step that reads: a body no
 * reader can read is `unexpected_answer`, and a read that threw until the SDK's attempts
 * were spent is `qb_unreachable`, which the run's wrapper gives.
 */
export const QUICKBOOKS_SENTENCES = {
  qb_not_connected: 'Reconnect QuickBooks in Connections, then run it again.',
  qb_reauthorize: 'Reconnect QuickBooks in Connections, then run it again.',
  qb_forbidden:
    'QuickBooks refused access to this company. Reconnect QuickBooks in Connections as a company admin, then run it again.',
  qb_missing_scope:
    'QuickBooks was connected without accounting access. Reconnect QuickBooks in Connections, then run it again.',
  qb_not_configured:
    'QuickBooks calls are not available on Autom8x right now. Nothing was created; run it again later.',
  qb_busy: 'QuickBooks is busy; run it again in a few minutes.',
  qb_unreachable:
    'Autom8x could not reach QuickBooks. Run it again in a few minutes; nothing was created.',
  unexpected_answer:
    'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
} as const;

export interface QuickBooksReadRequest {
  /** The step's platform: the runner attaches the step's one key to every call. */
  readonly platform: Pick<StepPlatform, 'callProvider'>;
  /** The invoke's `deadline`. One that does not parse allows no wait. */
  readonly deadline: string;
  readonly clock: Clock;
  readonly operation: string;
  readonly input: JsonObject;
  /** What the read is for, ending "QuickBooks answered with error 4000 while …". */
  readonly purpose: string;
  /** The error sentence's last words; "Check QuickBooks, then run it again." when absent. */
  readonly advice?: string;
}

/** The answer, or the failure with its sentence and a word or number for the timeline. */
export type QuickBooksRead =
  | { readonly ok: true; readonly body: unknown }
  | {
      readonly ok: false;
      readonly reason: QuickBooksFailureReason;
      readonly sentence: string;
      /** The Fault code, QuickBooks' status, or the platform's reason word. */
      readonly detail?: string;
    };

export async function readQuickBooks(read: QuickBooksReadRequest): Promise<QuickBooksRead> {
  let waits = 0;
  let repeats = 0;
  for (;;) {
    let answer: ProviderAnswer;
    try {
      answer = await read.platform.callProvider({
        providerId: 'quickbooks',
        operation: read.operation,
        input: read.input,
      });
    } catch (error) {
      const refused = platformRefusal(error);
      if (refused) return refused;
      throw error;
    }
    const { status, body } = answer;
    if (status >= 200 && status < 300) {
      // A Fault inside a 2xx is recorded by Connections: a repeat would only replay it.
      const fault = faultOf(body);
      return fault ? quickBooksError(read, fault.code) : { ok: true, body };
    }
    if (status === 429) {
      if (waits < MAX_THROTTLE_WAITS && mayWait(read)) {
        waits += 1;
        await read.clock.sleep(THROTTLE_WAIT_MS);
        continue;
      }
      return failure('qb_busy', '429');
    }
    if (status >= 500 && status <= 599) {
      if (repeats < MAX_SERVER_ERROR_REPEATS) {
        repeats += 1;
        continue;
      }
      return failure('qb_busy', String(status));
    }
    if (status === 408 || status === 425) return failure('qb_busy', String(status));
    if (status === 401) return failure('qb_reauthorize');
    if (status === 403) return failure('qb_forbidden');
    return quickBooksError(read, faultOf(body)?.code ?? String(status));
  }
}

/** Whether a 429 wait leaves the reserve before the deadline. `<` against NaN is false. */
function mayWait(read: QuickBooksReadRequest): boolean {
  return read.clock.now() + THROTTLE_WAIT_MS + RESERVE_AFTER_WAIT_MS < Date.parse(read.deadline);
}

function failure(
  reason: Exclude<QuickBooksFailureReason, 'qb_error' | 'platform_refused'>,
  detail?: string,
): QuickBooksRead {
  return {
    ok: false,
    reason,
    sentence: QUICKBOOKS_SENTENCES[reason],
    ...(detail === undefined ? {} : { detail }),
  };
}

function quickBooksError(read: QuickBooksReadRequest, code: string | undefined): QuickBooksRead {
  const advice = read.advice ?? 'Check QuickBooks, then run it again.';
  const error = code === undefined ? 'an error' : `error ${code}`;
  return {
    ok: false,
    reason: 'qb_error',
    sentence: `QuickBooks answered with ${error} while ${read.purpose}. ${advice}`,
    ...(code === undefined ? {} : { detail: code }),
  };
}

/** The platform's own word for why, when it is one: lowercase letters, digits and `_`. */
const REASON_WORD = /^[a-z][a-z0-9_]{0,63}$/u;

/** A platform refusal answered with a sentence, or `undefined` for one to throw. */
function platformRefusal(error: unknown): QuickBooksRead | undefined {
  const refusal = refusalOf(error);
  if (!refusal) return undefined;
  const { status, reason } = refusal;
  if (status === 404) return failure('qb_not_connected');
  if (status === 400 && reason === 'insufficient_scope') return failure('qb_missing_scope');
  if (status === 503 && reason === 'connections_not_configured') {
    return failure('qb_not_configured');
  }
  if (
    status === 400 ||
    (status === 409 && reason === 'idempotency_key_reused') ||
    (status === 403 && reason === 'provider_not_declared')
  ) {
    const word = reason !== undefined && REASON_WORD.test(reason) ? reason : 'refused';
    return {
      ok: false,
      reason: 'platform_refused',
      sentence: `Autom8x could not ask QuickBooks (${word}). Nothing was created.`,
      detail: word,
    };
  }
  return undefined;
}

/**
 * The provider callback's refusal, read by its shape: the kit runs on Node built-ins
 * alone, so it holds the SDK's `CallbackRefusedError` as a type and never imports the
 * class. The SDK names the error and records the callback, the status and the
 * platform's reason on it.
 */
function refusalOf(error: unknown): { status: number; reason: string | undefined } | undefined {
  if (!(error instanceof Error) || error.name !== 'CallbackRefusedError') return undefined;
  const { callback, status, reason } = error as Partial<
    Pick<CallbackRefusedError, 'callback' | 'status' | 'reason'>
  >;
  if (callback !== 'provider' || typeof status !== 'number') return undefined;
  return { status, reason: typeof reason === 'string' ? reason : undefined };
}
