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
import { UNCONFIRMED_LINE, notRecorded } from './quickbooks-path.js';
import { confirmCompanyGaveUp } from './run/approval.js';
import { written } from './run/documents.js';
import { gaveUp, type FanOut } from './run/fan-out.js';
import { quickBooksRun } from './run/quickbooks.js';
import { runResult } from './run/result.js';
import { runStateOf } from './run/state.js';
import { RUN_FAILS } from './words.js';

/**
 * How a run ends when a step THROWS — and what the log keeps.
 *
 * A step throws a platform failure it cannot judge — no answer, a 502 that names no reason —
 * unchanged, so the SDK's step retry can repeat it. When the attempts are spent:
 *
 * - a QuickBooks step is ended by the run's `recover` (`recoverQuickBooks`): QuickBooks did not
 *   answer, so the documents it had not finished are "not recorded in QuickBooks" — or, the one it
 *   was writing, QuickBooks "didn't confirm" — and the run goes on to save their details (v2's
 *   decision 6, per document in v3: `gaveUp` in `src/run/fan-out.ts`);
 * - any other step ends the run, and the serving shell would make the error's own message its
 *   reason. Instead each step is wrapped to note which step threw — in a WeakMap keyed by the error
 *   object itself, so the SDK's marks on it still hold and its retry still reads it — and the run's
 *   `execute` turns the throw into a failed result with one of the spec's sentences (§3.F).
 *
 * The runner reports each step AFTER it returns, and a report the platform refuses — the Edge's
 * 429 — throws outside any step: once a record was made, or a write QuickBooks may have made, the
 * run must not say "Try again". So the wrapper also notes, per run, what its steps made
 * (`RunNotes`), and the run ends saying it. It logs each reason code a step's result carries
 * (`src/outcome.ts`): codes reach the log, never a person.
 */

const thrownBy = new WeakMap<object, string>();

/** What a run's steps have done that its end must not deny. */
export interface RunNotes {
  /** A record was made: the run's summary of its documents (§3.5). */
  readonly recorded: string | null;
  /** A write nothing answered: QuickBooks may hold it, and the run must not say "Try again". */
  readonly unconfirmed: boolean;
  /** The sentence the last step to return ended the run with; the runner says it once reported. */
  readonly failureReason: string | undefined;
}

const NOTHING_DONE: RunNotes = { recorded: null, unconfirmed: false, failureReason: undefined };

/** Per run, keyed by its request — the one object every step's context carries. */
const runs = new WeakMap<object, RunNotes>();

/** What a state's documents hold that QuickBooks may now have: a record made, a write unconfirmed. */
function writtenOf(request: InvokeRequest, result: StepResult) {
  const state = result.outcome === 'skipped' ? undefined : result.state;
  const run = state === undefined ? undefined : runStateOf(state);
  if (!state || !run) return { recorded: null, unconfirmed: false };
  const kinds = run.documents.map((entry) => written(entry.engine));
  let recorded: string | null = null;
  if (kinds.includes('recorded')) {
    try {
      recorded = runResult(state, request).summary;
    } catch {
      recorded = null;
    }
  }
  return { recorded, unconfirmed: kinds.includes('unconfirmed') };
}

/** A step's result, noted against its run: a record made, or a write unconfirmed, stays noted. */
function noteResult(request: InvokeRequest, result: StepResult): void {
  const before = runs.get(request) ?? NOTHING_DONE;
  const { recorded, unconfirmed } = writtenOf(request, result);
  runs.set(request, {
    recorded: recorded ?? before.recorded,
    unconfirmed: before.unconfirmed || unconfirmed,
    failureReason: result.outcome === 'failed' ? result.failureReason : undefined,
  });
}

/** The run-level QuickBooks reads, made once for every document (`src/run/quickbooks.ts`). */
export const RUN_LEVEL_STEPS: ReadonlySet<string> = new Set([
  'read-company',
  'read-preferences',
  'find-accounts',
]);

/** The steps that call a model: a throw there that got no answer is "AI is busy". */
export const MODEL_STEPS: ReadonlySet<string> = new Set(['extract', 'verify-read']);

/**
 * The run's `recover`: a QuickBooks step that threw until the SDK's attempts were spent ends — the
 * run-level reads keeping every document out of QuickBooks, a per-document step the documents it
 * had not finished, confirm-company those that waited — and the run goes on (decision 6). Any
 * other step's throw ends the run as before (`undefined`).
 */
export function recoverQuickBooks(log: Logger, perDocument: Readonly<Record<string, FanOut>>) {
  return (stepId: string, error: unknown, context: StepContext): StepResult | undefined => {
    let result: StepResult | undefined;
    if (RUN_LEVEL_STEPS.has(stepId) && quickBooksRun(context.state, context.request)) {
      result = notRecorded(context.state, 'no_answer');
    } else if (stepId === 'confirm-company') {
      result = confirmCompanyGaveUp(context);
    } else if (Object.hasOwn(perDocument, stepId)) {
      result = gaveUp(perDocument[stepId]!, error, context);
    }
    if (result === undefined) return undefined;
    log('info', 'quickbooks_step_gave_up', {
      runId: context.request.runId,
      stepId,
      ...shapeOf(error),
    });
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
  // The records stand, whatever threw after them: say so, never "Try again" — nor after a write
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
