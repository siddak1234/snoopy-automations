import {
  CallbackRefusedError,
  isUnanswered,
  isUnsent,
  type Automation,
  type InvokeRequest,
  type Logger,
  type Step,
  type StepContext,
  type StepResult,
} from '@autom8x/automation-sdk';

import { codeOf } from './outcome.js';
import { runResult } from './output.js';
import {
  UNCONFIRMED_LINE,
  notRecorded,
  onQuickBooksPath,
  quickBooksStateOf,
  unconfirmed,
} from './quickbooks-path.js';
import { RUN_FAILS } from './words.js';
import { createdOf } from './writes/saved-state.js';

/**
 * How a run ends when a step THROWS — and what the log keeps.
 *
 * A step throws a platform failure it cannot judge — no answer, a 502 that names no reason —
 * unchanged, so the SDK's step retry can repeat it. When the attempts are spent:
 *
 * - a QuickBooks step is ended by the run's `recover` (`recoverQuickBooks`): QuickBooks did not
 *   answer, so the document is "not recorded in QuickBooks" — or, for a write, QuickBooks "didn't
 *   confirm" — and the run goes on to save the details (the session's decision 6);
 * - any other step ends the run, and the serving shell would make the error's own message its
 *   reason. Instead each step is wrapped to note which step threw — in a WeakMap keyed by the error
 *   object itself, so the SDK's marks on it still hold and its retry still reads it — and the run's
 *   `execute` turns the throw into a failed result with one of the spec's sentences (§3.F).
 *
 * The runner reports each step AFTER it returns, and a report the platform refuses — the Edge's
 * 429 — throws outside any step: once a record was made, or a write QuickBooks may have made, the run
 * must not say "Try again". So the wrapper also notes, per run, what a step made (`RunNotes`), and
 * the run ends saying it. It
 * logs each reason code a step's result carries (`src/outcome.ts`): codes reach the log, never a
 * person.
 */

const thrownBy = new WeakMap<object, string>();

/** What a run's steps have done that its end must not deny. */
export interface RunNotes {
  /** create-record made the record: the result line naming it (§3.F). */
  readonly recorded: string | null;
  /** A write nothing answered: QuickBooks may hold it, and the run must not say "Try again". */
  readonly unconfirmed: boolean;
  /** The sentence the last step to return ended the run with; the runner says it once reported. */
  readonly failureReason: string | undefined;
}

const NOTHING_DONE: RunNotes = { recorded: null, unconfirmed: false, failureReason: undefined };

/** Per run, keyed by its request — the one object every step's context carries. */
const runs = new WeakMap<object, RunNotes>();

/** The result line of the record a state holds, or null. */
function recordedLine(request: InvokeRequest, result: StepResult): string | null {
  const state = result.outcome === 'skipped' ? undefined : result.state;
  if (state === undefined || !createdOf(state)) return null;
  try {
    return runResult(state, request).summary;
  } catch {
    return null;
  }
}

/** A step's result, noted against its run: a record made, or a write unconfirmed, stays noted. */
function noteResult(request: InvokeRequest, result: StepResult): void {
  const before = runs.get(request) ?? NOTHING_DONE;
  const state = result.outcome === 'skipped' ? undefined : result.state;
  const quickBooks = state === undefined ? null : quickBooksStateOf(state);
  runs.set(request, {
    recorded: recordedLine(request, result) ?? before.recorded,
    unconfirmed:
      before.unconfirmed ||
      (quickBooks !== null && quickBooks !== undefined && 'unconfirmed' in quickBooks),
    failureReason: result.outcome === 'failed' ? result.failureReason : undefined,
  });
}

/** Every step that calls QuickBooks; the two writes among them. */
export const QUICKBOOKS_STEPS: ReadonlySet<string> = new Set([
  'read-company',
  'read-preferences',
  'find-accounts',
  'find-vendor',
  'find-vendor-company',
  'find-similar-vendors',
  'find-customer-name',
  'find-employee-name',
  'find-duplicate-number',
  'find-duplicate-amount',
  'find-related',
  'find-other-record',
  'confirm-company',
  'confirm-vendor',
  'create-vendor',
  'confirm-no-duplicate',
  'create-record',
]);
export const WRITE_STEPS: ReadonlySet<string> = new Set(['create-vendor', 'create-record']);

/** The steps that call a model: a throw there that got no answer is "AI is busy". */
export const MODEL_STEPS: ReadonlySet<string> = new Set(['extract', 'verify-read']);

/**
 * The run's `recover`: a QuickBooks step that threw until the SDK's attempts were spent ends
 * "not recorded in QuickBooks: QuickBooks didn't answer" — a write, "QuickBooks didn't confirm",
 * since it may have been made — and the run goes on (decision 6). Any other step's throw ends the
 * run as before (`undefined`).
 */
export function recoverQuickBooks(log: Logger) {
  return (stepId: string, error: unknown, context: StepContext): StepResult | undefined => {
    if (!QUICKBOOKS_STEPS.has(stepId) || !onQuickBooksPath(context.request, context.state)) {
      return undefined;
    }
    log('info', 'quickbooks_step_gave_up', {
      runId: context.request.runId,
      stepId,
      ...shapeOf(error),
    });
    const result = WRITE_STEPS.has(stepId)
      ? unconfirmed(context.state)
      : notRecorded(context.state, 'no_answer');
    noteResult(context.request, result);
    return result;
  };
}

/**
 * Each step, noting the step id against anything it throws, then throwing it on unchanged — and
 * what it returned against its run (`RunNotes`), before the runner reports it; a result carrying a
 * reason code is logged with its step.
 */
export function noteThrows(
  steps: Readonly<Record<string, Step>>,
  log: Logger,
): Record<string, Step> {
  return Object.fromEntries(
    Object.entries(steps).map(([stepId, step]): [string, Step] => [
      stepId,
      async (context) => {
        let result: StepResult;
        try {
          result = await step(context);
        } catch (error) {
          if (typeof error === 'object' && error !== null) thrownBy.set(error, stepId);
          throw error;
        }
        const code = codeOf(result);
        if (code !== undefined) {
          log('info', 'step_failed', { runId: context.request.runId, stepId, reason: code });
        }
        noteResult(context.request, result);
        return result;
      },
    ]),
  );
}

/** The automation, ending a thrown run with a fixed sentence instead of the error's message. */
export function withFixedSentences(automation: Automation, log: Logger): Automation {
  return {
    ...automation,
    async execute(request, platform) {
      // Each run starts with nothing done, the same request run again included.
      runs.set(request, NOTHING_DONE);
      try {
        return await automation.execute(request, platform);
      } catch (error) {
        const stepId =
          typeof error === 'object' && error !== null ? thrownBy.get(error) : undefined;
        log('error', 'run_failed_on_a_throw', {
          runId: request.runId,
          stepId: stepId ?? null,
          ...shapeOf(error),
        });
        return {
          outcome: 'failed',
          failureReason: sentenceFor(stepId, error, runs.get(request)),
        };
      }
    },
  };
}

export function sentenceFor(
  stepId: string | undefined,
  error: unknown,
  run: RunNotes = NOTHING_DONE,
): string {
  // The record stands, whatever threw after it: say so, never "Try again" — nor after a write
  // QuickBooks may have made.
  if (run.recorded !== null) return run.recorded;
  if (run.unconfirmed) return UNCONFIRMED_LINE;
  // A step that ended the run, its report refused: the run ends as that step said.
  if (run.failureReason !== undefined) return run.failureReason;
  // The Edge's flood valve: busy, at whatever step — never "add the file again".
  const busy = error instanceof CallbackRefusedError && error.status === 429;
  if (stepId !== undefined && MODEL_STEPS.has(stepId)) {
    if (busy || isUnanswered(error) || isUnsent(error)) return RUN_FAILS.ai_busy;
  }
  if (stepId === 'receive' && !busy) return RUN_FAILS.file;
  return RUN_FAILS.other;
}

/** What the log keeps of an error. */
function shapeOf(error: unknown): Record<string, unknown> {
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
