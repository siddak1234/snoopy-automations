import { QUICKBOOKS_SENTENCES } from '@autom8x/automation-kit/quickbooks';
import {
  CallbackRefusedError,
  UNANSWERED_REASON,
  isUnanswered,
  isUnsent,
  type Automation,
  type Logger,
  type Step,
  type StepResult,
} from '@autom8x/automation-sdk';

import { NOUNS } from './writes/lines.js';
import { createdOf, vendorCreated } from './writes/saved-state.js';
import { recordedUnfinished } from './writes/sentences.js';

/**
 * A fixed sentence for a run that ends on a THROWN error.
 *
 * A step throws a platform failure it cannot judge — no answer, a 502 that names no
 * reason — unchanged, so the SDK's step retry can repeat it; when the attempts are
 * spent the runner reports the step failed in fixed words and throws on, and the
 * serving shell would make the error's own message the run's reason: for a refusal,
 * `callback provider refused with 502: ` and the platform's raw problem. Instead each
 * step is wrapped to note which step threw — in a WeakMap keyed by the error object
 * itself, so the SDK's marks on it still hold and its retry still reads it — and the
 * run's `execute` turns the throw into a failed result with that step's sentence. One
 * log line keeps the error's name, status, code and reason, never its message.
 *
 * The runner reports each step AFTER it returns, and a report the platform refuses — the Edge's
 * 429 — throws outside any step: once a write was made the run must not say "run it again in a
 * few minutes", nor send the person to a timeline that lacks the line naming the record. So the
 * wrapper also notes, per run, what the steps have done (`RunNotes`), and the run ends saying it.
 */

const thrownBy = new WeakMap<object, string>();
/** A sentence a step registered on the error it throws on unchanged: it wins over every other. */
const sentences = new WeakMap<object, string>();

/** What a run's steps have done that its end must not deny. */
export interface RunNotes {
  /** create-record made the record: its noun and QuickBooks Id. */
  readonly recorded: { readonly noun: string; readonly id: string } | null;
  /** create-vendor added the vendor: every later sentence says so. */
  readonly vendorAdded: boolean;
  /** The sentence the last step to return ended the run with; the runner says it once reported. */
  readonly failureReason: string | undefined;
}

const NOTHING_DONE: RunNotes = { recorded: null, vendorAdded: false, failureReason: undefined };

/** Per run, keyed by its request — the one object every step's context carries. */
const runs = new WeakMap<object, RunNotes>();

/** A step's result, noted against its run: a record made and a vendor added stay noted. */
function noteResult(request: object, result: StepResult): void {
  const before = runs.get(request) ?? NOTHING_DONE;
  const state = result.outcome === 'skipped' ? undefined : result.state;
  const created = state === undefined ? undefined : createdOf(state);
  const noun = created && Object.hasOwn(NOUNS, created.record) ? NOUNS[created.record] : 'record';
  runs.set(request, {
    recorded: created ? { noun, id: created.id } : before.recorded,
    vendorAdded: before.vendorAdded || (state !== undefined && vendorCreated(state)),
    failureReason: result.outcome === 'failed' ? result.failureReason : undefined,
  });
}

export const THROWN_SENTENCES = {
  /** The Edge's flood valve: a callback refused 429. */
  busy: 'Autom8x is busy; run it again in a few minutes.',
  receive:
    'The document file could not be read. Run it again in a few minutes; if it repeats, upload the file again.',
  quickbooks: QUICKBOOKS_SENTENCES.qb_unreachable,
  /**
   * `extract` or `verify-read`: no answer reached the step — a timeout, a reset, a cut connection —
   * or its one repeat never reached the platform either. The SDK's own sentence for an answer that
   * never came.
   */
  unanswered: UNANSWERED_REASON,
  other:
    "Bills & Receipts stopped before it finished. Check the run's timeline before running it again.",
} as const;

/**
 * Every step that READS QuickBooks: a throw there ends with QuickBooks' sentence. The writes —
 * create-vendor, create-record — throw on only what nothing answered, for the SDK's retry (sandbox
 * S6), and register their own "did not confirm" sentence on it (`noteSentence`), so a write that
 * QuickBooks may have made never ends "nothing was created"; any other throw there is a fault, and
 * the general sentence sends the person to the timeline. A record made, and a vendor added, the
 * run's end names itself (`RunNotes`): the line naming them may be the very report that failed.
 */
export const QUICKBOOKS_STEPS: ReadonlySet<string> = new Set([
  'read-company',
  'read-preferences',
  'find-accounts',
  'find-payer',
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
  'confirm-no-duplicate',
]);

/** The steps that call a model: a throw there that got no answer ends with the SDK's sentence. */
export const MODEL_STEPS: ReadonlySet<string> = new Set(['extract', 'verify-read']);

/**
 * A step's own sentence for an error it throws on unchanged — for the SDK's retry to read — so that
 * when the attempts are spent the run ends with it: confirm-no-duplicate's, once this run added a
 * vendor, says so; create-vendor's and create-record's say QuickBooks did not confirm the write.
 */
export function noteSentence(error: unknown, sentence: string): void {
  if (typeof error === 'object' && error !== null) sentences.set(error, sentence);
}

/**
 * Each step, noting the step id against anything it throws, then throwing it on unchanged — and
 * what it returned against its run (`RunNotes`), before the runner reports it.
 */
export function noteThrows(steps: Readonly<Record<string, Step>>): Record<string, Step> {
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
  // The record stands, whatever threw after it: say so, never "run it again".
  if (run.recorded) {
    return recordedUnfinished(run.recorded.noun, run.recorded.id, run.vendorAdded);
  }
  const registered = typeof error === 'object' && error !== null ? sentences.get(error) : undefined;
  if (registered !== undefined) return registered;
  // A step that ended the run, its report refused — a write QuickBooks did not confirm, say: the
  // run ends as that step said.
  if (run.failureReason !== undefined) return run.failureReason;
  // Only these two can end a run after create-vendor: every QuickBooks read but
  // confirm-no-duplicate's, which registers its own sentence, and both model calls come before it.
  const vendor = run.vendorAdded ? ' The new vendor was added to QuickBooks.' : '';
  if (error instanceof CallbackRefusedError && error.status === 429) {
    return `${THROWN_SENTENCES.busy}${vendor}`;
  }
  if (stepId === 'receive') return THROWN_SENTENCES.receive;
  if (stepId !== undefined && QUICKBOOKS_STEPS.has(stepId)) return THROWN_SENTENCES.quickbooks;
  if (stepId !== undefined && MODEL_STEPS.has(stepId) && (isUnanswered(error) || isUnsent(error))) {
    return THROWN_SENTENCES.unanswered;
  }
  return `${THROWN_SENTENCES.other}${vendor}`;
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
