import { setTimeout as sleepFor } from 'node:timers/promises';

import { CallbackRefusedError } from './refusals.js';

/**
 * The Edge's flood valve, waited out — the owner's decision of 2026-10-12, "Wait and retry".
 *
 * Every callback reaches the platform through its Edge, which sheds a flood before it reads the
 * body, asks the identity provider or touches the database (snoopy-backend `apps/api/src/app.ts`,
 * `DEFAULT_EDGE_RATE_LIMIT`: 120 requests a minute per source, counted in a fixed one-minute
 * window). Its refusal is a 429 problem with the code `TOO_MANY_REQUESTS`, no `details.reason`,
 * and a `retry-after` header: the whole seconds until that window turns, at most 60. Nothing
 * reached Runs, so nothing ran and nothing was spent — and every automation on a host calls back
 * through the same address, so they share one bucket, which one bill's 25–44 callbacks can
 * empty. So the client sends the same callback again once the window has turned, for as long as
 * the run's deadline allows: a burst slows down instead of failing. A step report, a provider or
 * model call, a file read, a mail and the result alike — before this, a result refused halfway
 * through a burst left its run "running" until the deadline (`result_unreportable`).
 *
 * Only that refusal. A 429 that names a reason — the mail allowance's, a workspace's quota — is
 * the platform's decision and is thrown as before, as is any other status; so is a flood refusal
 * whose wait would not end before the deadline, past which the platform refuses every callback.
 */

/** The longest the Edge's window can have left, in milliseconds: its whole minute. */
export const FLOOD_WAIT_MAX_MS = 60_000;

/** The shortest wait, so a refusal is never answered by an immediate repeat. */
const FLOOD_WAIT_MIN_MS = 1_000;

/** Whether `error` is the Edge's flood valve: a 429 `TOO_MANY_REQUESTS` that names no reason. */
export function isFloodRefusal(error: unknown): boolean {
  return (
    error instanceof CallbackRefusedError &&
    error.status === 429 &&
    error.code === 'TOO_MANY_REQUESTS' &&
    error.reason === undefined
  );
}

/**
 * How long to wait before sending again: `retry-after` when it is whole seconds, as the Edge
 * writes it; else the whole window, since the client cannot see when it turns — never more than
 * that minute, and never less than a second.
 */
export function floodWaitMs(retryAfter: string | null): number {
  const seconds = retryAfter?.trim() ?? '';
  const wait = /^\d{1,9}$/u.test(seconds) ? Number(seconds) * 1000 : FLOOD_WAIT_MAX_MS;
  return Math.min(FLOOD_WAIT_MAX_MS, Math.max(FLOOD_WAIT_MIN_MS, wait));
}

/**
 * What time it is, and how the client waits for the window to turn: `Date.now()` and `setTimeout`
 * from `node:timers/promises`. Replaced only by this package's own suite, which records each wait
 * instead of sleeping it, and moves its own time on by it; the package does not export it.
 */
export const floodClock: {
  now: () => number;
  sleep: (milliseconds: number) => Promise<unknown>;
} = {
  now: () => Date.now(),
  sleep: (milliseconds) => sleepFor(milliseconds),
};

/** Whether a wait of `milliseconds` ends before `deadline`; none given, or one that does not parse, allows none. */
export function waitEndsBefore(milliseconds: number, deadline: string | undefined): boolean {
  // `<` against NaN is false: a deadline missing (`Date.parse('')`) or unreadable allows no wait.
  return floodClock.now() + milliseconds < Date.parse(deadline ?? '');
}
