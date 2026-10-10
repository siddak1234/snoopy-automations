import { QUICKBOOKS_SENTENCES } from '@autom8x/automation-kit/quickbooks';
import {
  CallbackRefusedError,
  type Automation,
  type Logger,
  type Step,
} from '@autom8x/automation-sdk';

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
 */

const thrownBy = new WeakMap<object, string>();

export const THROWN_SENTENCES = {
  /** The Edge's flood valve: a callback refused 429. */
  busy: 'Autom8x is busy; run it again in a few minutes.',
  receive:
    'The invoice file could not be read. Run it again in a few minutes; if it repeats, upload the file again.',
  quickbooks: QUICKBOOKS_SENTENCES.qb_unreachable,
  other:
    "Invoice Processing stopped before it finished. Check the run's timeline before running it again.",
} as const;

const QUICKBOOKS_STEPS: ReadonlySet<string> = new Set([
  'read-company',
  'read-preferences',
  'find-account',
]);

/** Each step, noting the step id against anything it throws, then throwing it on unchanged. */
export function noteThrows(steps: Readonly<Record<string, Step>>): Record<string, Step> {
  return Object.fromEntries(
    Object.entries(steps).map(([stepId, step]): [string, Step] => [
      stepId,
      async (context) => {
        try {
          return await step(context);
        } catch (error) {
          if (typeof error === 'object' && error !== null) thrownBy.set(error, stepId);
          throw error;
        }
      },
    ]),
  );
}

/** The automation, ending a thrown run with a fixed sentence instead of the error's message. */
export function withFixedSentences(automation: Automation, log: Logger): Automation {
  return {
    ...automation,
    async execute(request, platform) {
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
        return { outcome: 'failed', failureReason: sentenceFor(stepId, error) };
      }
    },
  };
}

export function sentenceFor(stepId: string | undefined, error: unknown): string {
  if (error instanceof CallbackRefusedError && error.status === 429) return THROWN_SENTENCES.busy;
  if (stepId === 'receive') return THROWN_SENTENCES.receive;
  if (stepId !== undefined && QUICKBOOKS_STEPS.has(stepId)) return THROWN_SENTENCES.quickbooks;
  return THROWN_SENTENCES.other;
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
