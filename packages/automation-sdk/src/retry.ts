import { setTimeout as sleepFor } from 'node:timers/promises';

import { ONE_LINE_MAX_LENGTH, truncateText } from './contract.js';
import { isUnanswered } from './platform.js';
import { CallbackRefusedError } from './refusals.js';
import type { StepResult } from './runner.js';

/**
 * The runner's bounded step-level retry — platform BUILD-PLAN 25.5.1, the runner's
 * half of 25.2.10 (ADR-0034 decision 5, unconditional since 2026-10-08, D3). The
 * platform re-attempts an INVOKE that was refused or never answered; a step that
 * fails inside a running automation is the runner's to re-attempt, here.
 *
 * **Declared, or nothing.** A step re-attempts only when its automation declares a
 * policy for it (`defineAutomation({ retry: { act: { attempts: 3, backoffMs: 5_000 } } })`);
 * a step with none runs once, exactly as before this file existed.
 *
 * **Bounded three ways.** At most `MAX_STEP_ATTEMPTS` attempts, the first
 * included. Waits of `backoffMs`, then twice that, never more than
 * `MAX_STEP_BACKOFF_MS` in all — a policy asking for more is clamped, not refused.
 * And no attempt starts at or after the invoke's `deadline`: past it the platform
 * refuses every callback (403 `deadline_exceeded`) and its sweep fails the run; a
 * deadline that does not parse allows no retry at all.
 *
 * **Only a transient failure** (`isTransient`): the platform did not decide.
 * Never a 4xx, never a typed refusal, never an error the step's own code made.
 *
 * **One key for every attempt.** The step's idempotency key is derived once from
 * the run and the step (25.3.2), so a repeated provider request or mail reaches
 * the platform's records for that key rather than a fresh one; README's "Retrying
 * a step" says what each record does with it — and that a repeated MODEL call has
 * none, and is a second vendor call and a second `runs.model_calls` row.
 *
 * The two ceilings are integrator figures, not measurements: three attempts and
 * 30 seconds of waiting in all. Callbacks reach the Edge through the platform's
 * proxy, which re-admits a restarted Edge on a 10-second health check (its
 * `deploy/Caddyfile`, `health_interval 10s`) — the transient a platform deploy
 * causes — so 30 seconds spans three checks, and stays a small part of a run's
 * deadline (900 s for every manifest here). Replace them when a real automation's
 * failures say otherwise.
 */

export interface RetryPolicy {
  /** Every attempt, the first included — 2 is one retry. A positive integer; above `MAX_STEP_ATTEMPTS` it is clamped. */
  readonly attempts: number;
  /** Milliseconds before the second attempt; the wait doubles before each later one. Clamped so the waits sum to at most `MAX_STEP_BACKOFF_MS`. */
  readonly backoffMs: number;
}

/** The most attempts any step makes, the first included. */
export const MAX_STEP_ATTEMPTS = 3;

/** The most a step's waits between attempts add up to, in milliseconds. */
export const MAX_STEP_BACKOFF_MS = 30_000;

/** The statuses a callback answers when the platform could not decide: a hop or a dependency did not answer. */
const TRANSIENT_STATUSES: readonly number[] = [502, 503, 504];

/**
 * The policy as the runner applies it: refused at definition when malformed,
 * clamped when it asks for more than the ceilings allow.
 */
export function boundedPolicy(stepId: string, policy: RetryPolicy): RetryPolicy {
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
    throw new Error(`the retry policy for step "${stepId}" must count at least one attempt`);
  }
  if (!Number.isInteger(policy.backoffMs) || policy.backoffMs < 0) {
    throw new Error(
      `the retry policy for step "${stepId}" must wait a whole number of milliseconds`,
    );
  }
  const attempts = Math.min(policy.attempts, MAX_STEP_ATTEMPTS);
  // The waits, counted in first waits: none for one attempt, 1 for two, 1 + 2 for three.
  const firstWaits = 2 ** (attempts - 1) - 1;
  const backoffMs =
    firstWaits === 0 ? 0 : Math.min(policy.backoffMs, Math.floor(MAX_STEP_BACKOFF_MS / firstWaits));
  return { attempts, backoffMs };
}

/** The waits before the second and each later attempt. */
export function backoffWaits(policy: RetryPolicy): number[] {
  return Array.from({ length: policy.attempts - 1 }, (_, index) => policy.backoffMs * 2 ** index);
}

/**
 * Whether a failure may clear on its own, so that running the step again is a
 * fair question to ask.
 *
 * Transient: NO ANSWER AT ALL — the client marked the error itself where the
 * request was made (`isUnanswered`: refused, reset, timed out, cut off) — or a
 * callback answered 502, 503 or 504 WITHOUT DECIDING: no `details.reason`, and a
 * code that is the platform's `DEPENDENCY_FAILURE` (the Edge could not reach
 * Runs, Runs could not reach a dependency) or none at all (a proxy's own page).
 *
 * Never: any 4xx — the mail allowance's 429 included; a `ModelRefusedError` (it
 * always names its reason); a 5xx the platform typed with a reason
 * (`workspace_membership_truncated`, `pinned_version_unavailable`,
 * `outbound_mail_not_configured`); `NOT_CONFIGURED`, a deployment without the
 * component, which no wait inside a run repairs; an answer that came and was
 * malformed; a provider's own status, which comes back inside a 200 and is the
 * step's to judge; and any error the step's own code made — including one built
 * from a transient error, so a step that wants the retry rethrows the original.
 */
export function isTransient(error: unknown): boolean {
  if (isUnanswered(error)) return true;
  return (
    error instanceof CallbackRefusedError &&
    TRANSIENT_STATUSES.includes(error.status) &&
    error.reason === undefined &&
    (error.code === undefined || error.code === 'DEPENDENCY_FAILURE')
  );
}

/** How a step's attempts ended: the result the last one returned, or the error it threw. */
export type Attempted =
  | { readonly threw: false; readonly result: StepResult; readonly attempts: number }
  | { readonly threw: true; readonly error: unknown; readonly attempts: number };

/**
 * Runs a step, then again after each wait while its failure is transient, a
 * wait remains, and the next attempt would start before the deadline. A result
 * the step RETURNS ends it on the spot — `ok`, `failed`, `skipped` and `held`
 * alike, so a held step is never run twice; only a THROWN transient failure is
 * re-attempted. `sleep` is the wait itself, replaced only by a test.
 */
export async function attempt(
  run: () => Promise<StepResult>,
  waits: readonly number[],
  deadline: string,
  sleep: (milliseconds: number) => Promise<unknown> = sleepFor,
): Promise<Attempted> {
  const deadlineAt = Date.parse(deadline);
  for (let attempts = 1; ; attempts += 1) {
    try {
      return { threw: false, result: await run(), attempts };
    } catch (error) {
      const wait = waits[attempts - 1];
      // `<` against NaN is false: a deadline the runner cannot read allows no retry.
      if (wait === undefined || !isTransient(error) || !(Date.now() + wait < deadlineAt)) {
        return { threw: true, error, attempts };
      }
      await sleep(wait);
    }
  }
}

/**
 * The step's one timeline line, saying how many attempts it took when more than
 * one: fixed words and a count, never the error's text or the document. The
 * step's own words are cut first, so the count always fits the platform's bound;
 * an empty line is left as it is, for the client to refuse as it always has.
 */
export function withAttempts(summary: string, attempts: number): string {
  const line = summary.trim();
  if (attempts <= 1 || line === '') return summary;
  const note = ` (after ${attempts} attempts)`;
  return `${truncateText(line, ONE_LINE_MAX_LENGTH - note.length).trimEnd()}${note}`;
}
