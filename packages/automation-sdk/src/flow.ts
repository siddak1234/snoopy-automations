import type { InvokeRequest, ModelCompletion, ModelRequest } from './contract.js';
import { MODEL_REQUEST_LIMITS } from './model-request.js';
import type { AutomationPlatform } from './platform.js';
import { ModelRefusedError } from './refusals.js';
import { retryableUnder, spreadWaits } from './retry.js';
import { buildRunner } from './runner.js';
import { jsonLogger, type Logger } from './serve.js';
import {
  codeOf,
  isUnmatched,
  kindOf,
  leavesUnconfirmed,
  markUnconfirmed,
  markUnmatched,
  shapeOf,
} from './settle.js';
import {
  held,
  type Automation,
  type AutomationDefinition,
  type RunnerStandards,
  type StepContext,
  type StepPlatform,
  type StepResult,
} from './steps.js';
import { FLOW_WORDS } from './words.js';

/**
 * `defineFlow`: `defineAutomation` with the standards on (Round 21, D2). New flows only — the
 * template, `npm run scaffold` and `/create-flow` use it; the two live flows keep
 * `defineAutomation`, unchanged, until their after-pilot versions.
 *
 * - **A throw never reaches a person.** A step that threw until its attempts were spent, and
 *   that `recover` did not end, ends the run with the flow's own sentence for that step
 *   (`sentences`) or the SDK's (`FLOW_WORDS`, by `kindOf`) — never `error.message`, which may
 *   carry the document. The log keeps the error's shape: its name, status, code and reason (as
 *   Invoice Processing's `noteThrows` does). A throw outside a step (a refused report) ends it
 *   with `FLOW_WORDS.other`. A `failed(sentence, code)` result's code is logged with its step.
 * - **Never "Try again" once an app may have done something.** Per run, `defineFlow` notes when a
 *   provider call has answered 2xx, or got no answer and was not provably unsent — that error
 *   marked so `settle` and `kindOf` read it as `unconfirmed` ("Check it before you run this
 *   again"). A re-run is a new run's key, so it would do the write again. Once noted — each
 *   attempt's context carries it as `wrote()` — a throw ends the run with `FLOW_WORDS.after_write`,
 *   ahead of the flow's own `sentences`, and `settle` words every failure but `unconfirmed` the same
 *   way, at any later step (Invoice Processing's `RunNotes`). A run that holds once noted keeps the
 *   note in its held state (`providerWrote`), and the approval's continuation starts noted, so a
 *   failure after the approval says the same; the steps never see the key.
 * - **The log, per attempt** (`context.log`): `settled`, `model_reasked` (the reason, the schema's
 *   path and rule) and `not_connected`, each with the run's and the step's ids.
 * - **`retryLeft` on every attempt** (`settle`): true while the runner would run the step again,
 *   and false once the attempt has had a model answer — so a re-ask that then gets no answer ends
 *   as `unanswered`, and the billed first call is never made again (the re-check's finding 1).
 * - **Q2.** An answer that misses its schema (`output_schema_mismatch`) is asked once more with
 *   the same registered prompt and one fixed line naming the schema's `path` and `rule`. A second
 *   miss at a step in `holdUnmatched` holds the run for a person (`FLOW_WORDS.ai_unmatched`; the
 *   state gains `unmatchedAnswer: <step id>` for the step after it); at any other step it ends the
 *   run with `FLOW_WORDS.ai_unusable` — an approval carries a decision, never the AI's fields, so a
 *   hold is offered only where the next step can go on without them. **One to three more paid AI
 *   calls**: the platform tries the request's next model on a miss too.
 * - **5d.** A call asks at the owner's cap unless the step names a lower `maxOutputTokens`; one
 *   cut off (`truncated`) below the cap is asked once more at the cap, **one to three more paid
 *   AI calls**; one cut off at the cap is not asked again, and ends with `FLOW_WORDS.ai_too_long`.
 * - **5a.** The waits between attempts are spread upward inside the cap (`spreadWaits`).
 *
 * One re-ask per call at most, for either reason.
 */
export interface FlowDefinition extends AutomationDefinition {
  /** The run's sentence when a step throws, by step id; else the SDK's. */
  sentences?: Readonly<Record<string, string>>;
  /** Where codes and error shapes go; `jsonLogger(templateId)` unless given. */
  log?: Logger;
  /**
   * The steps whose answer, off its schema twice, holds the run for a person (Q2). The step after
   * each must read `state.unmatchedAnswer` (the held step's id) and go on without that step's
   * fields: an approval carries a decision, never fields. None unless given: any other step's
   * second miss ends the run with `FLOW_WORDS.ai_unusable`.
   */
  holdUnmatched?: readonly string[];
}

/** The owner's cap on one answer, the most a re-ask asks for. */
const CAP = MODEL_REQUEST_LIMITS.maxOutputTokens;

/** Refusals the model had already answered for: billed (`runs.model_calls`). */
const SPENT = new Set(['output_schema_mismatch', 'content_filtered', 'truncated']);

/** What a run's provider calls have done that its end must not deny: an app may hold a write. */
interface RunNotes {
  wrote: boolean;
}

/**
 * The held state's reserved key for the note: an approval's continuation is a new `execute`, so a
 * run that wrote and then held carries it here, and its continuation starts noted.
 */
const WROTE = 'providerWrote';

/** A continuation's note, read and taken out of the state the steps see. */
function resumed(request: InvokeRequest): { request: InvokeRequest; wrote: boolean } {
  const continuation = request.continuation;
  if (continuation === undefined || !(WROTE in continuation.state)) {
    return { request, wrote: false };
  }
  const { [WROTE]: noted, ...state } = continuation.state;
  return {
    request: { ...request, continuation: { ...continuation, state } },
    wrote: noted === true,
  };
}

/** Per run, keyed by its request — the one object every step's context carries. */
const runs = new WeakMap<InvokeRequest, RunNotes>();

const notesOf = (request: InvokeRequest): RunNotes => {
  const notes = runs.get(request) ?? { wrote: false };
  runs.set(request, notes);
  return notes;
};

export function defineFlow(definition: FlowDefinition): Automation {
  const log = definition.log ?? jsonLogger(definition.templateId);
  const sentences = definition.sentences ?? {};
  const holds = new Set(definition.holdUnmatched ?? []);
  for (const stepId of holds) {
    if (definition.steps[stepId] === undefined) {
      throw new Error(`holdUnmatched names "${stepId}", which is not one of the flow's steps`);
    }
  }
  const standards: RunnerStandards = {
    waits: (policy) => spreadWaits(policy),
    attemptOf(attempt, { context, policy, waits, platform, platformWith }) {
      const answered = { value: false };
      const { runId } = context.request;
      const stepLog: NonNullable<StepContext['log']> = (level, event, fields = {}) =>
        log(level, event, { runId, stepId: context.stepId, ...fields });
      const repeats = retryableUnder(policy);
      const deadlineAt = Date.parse(context.request.deadline);
      const wait = waits[attempt - 1];
      const retryLeft = (error: unknown): boolean =>
        !answered.value &&
        !isUnmatched(error) &&
        repeats(error) &&
        wait !== undefined &&
        Date.now() + wait < deadlineAt;
      const notes = notesOf(context.request);
      const stepPlatform = watching(platformWith(reasking(platform, answered, stepLog)), notes);
      return {
        context: {
          ...context,
          platform: stepPlatform,
          retryLeft,
          log: stepLog,
          wrote: () => notes.wrote,
        },
        retryable: retryLeft,
      };
    },
    thrown(stepId, error, context): StepResult {
      log('error', 'step_threw', { runId: context.request.runId, stepId, ...shapeOf(error) });
      if (isUnmatched(error) && holds.has(stepId)) {
        return held({
          summary: FLOW_WORDS.ai_unmatched,
          heldReason: FLOW_WORDS.ai_unmatched,
          state: { ...context.state, unmatchedAnswer: stepId },
        });
      }
      const kind = isUnmatched(error) ? undefined : kindOf(error);
      const wrote = notesOf(context.request).wrote && kind?.kind !== 'unconfirmed';
      const own = isUnmatched(error) ? FLOW_WORDS.ai_unusable : sentences[stepId];
      const sentence = wrote ? FLOW_WORDS.after_write : (own ?? kind?.sentence ?? FLOW_WORDS.other);
      return { outcome: 'failed', summary: sentence, failureReason: sentence };
    },
    returned(stepId, result, context) {
      const code = codeOf(result);
      if (code !== undefined) {
        log('info', 'step_failed', { runId: context.request.runId, stepId, reason: code });
      }
    },
  };
  const automation = buildRunner(definition, standards);
  return {
    ...automation,
    async execute(outer, platform) {
      const { request, wrote } = resumed(outer);
      const notes: RunNotes = { wrote };
      runs.set(request, notes);
      try {
        const result = await automation.execute(request, platform);
        if (result.outcome !== 'held' || !notes.wrote) return result;
        return {
          ...result,
          held: { ...result.held, state: { ...result.held.state, [WROTE]: true } },
        };
      } catch (error) {
        const { wrote } = notes;
        log('error', 'run_failed_on_a_throw', { runId: request.runId, wrote, ...shapeOf(error) });
        return {
          outcome: 'failed',
          failureReason: wrote ? FLOW_WORDS.after_write : FLOW_WORDS.other,
        };
      }
    },
  };
}

/**
 * The step's platform with its provider calls noted against the run: a 2xx answer, or no answer
 * that was not provably unsent — that error marked `unconfirmed` for `settle` and `kindOf`.
 */
function watching(platform: StepPlatform, notes: RunNotes): StepPlatform {
  return {
    ...platform,
    async callProvider(request, options) {
      try {
        const answer = await platform.callProvider(request, options);
        if (answer.status >= 200 && answer.status < 300) notes.wrote = true;
        return answer;
      } catch (error) {
        if (leavesUnconfirmed(error)) {
          markUnconfirmed(error);
          notes.wrote = true;
        }
        throw error;
      }
    },
  };
}

/** The platform's model call, with Q2's and 5d's one re-ask, noting when a model has answered. */
function reasking(
  platform: AutomationPlatform,
  answered: { value: boolean },
  log: NonNullable<StepContext['log']>,
) {
  const reasked = (error: ModelRefusedError) =>
    log('info', 'model_reasked', {
      reason: error.reason,
      path: error.path ?? null,
      rule: error.rule ?? null,
    });
  const ask = async (request: ModelRequest): Promise<ModelCompletion> => {
    try {
      const completion = await platform.callModel(request);
      answered.value = true;
      return completion;
    } catch (error) {
      if (error instanceof ModelRefusedError && SPENT.has(error.reason)) answered.value = true;
      throw error;
    }
  };
  return async (request: ModelRequest): Promise<ModelCompletion> => {
    try {
      return await ask(request);
    } catch (error) {
      if (!(error instanceof ModelRefusedError)) throw error;
      if (error.reason === 'output_schema_mismatch') {
        reasked(error);
        try {
          return await ask({ ...request, prompt: `${request.prompt}\n\n${missLine(error)}` });
        } catch (again) {
          if (again instanceof ModelRefusedError && again.reason === 'output_schema_mismatch') {
            markUnmatched(again);
          }
          throw again;
        }
      }
      const cap = request.maxOutputTokens;
      if (error.reason === 'truncated' && cap !== undefined && cap < CAP) {
        reasked(error);
        return await ask({ ...request, maxOutputTokens: CAP });
      }
      throw error;
    }
  };
}

/** Q2's one fixed line: where the answer missed, in the schema's own words — never the answer's. */
export function missLine(error: ModelRefusedError): string {
  const where = error.path === undefined ? '' : ` at ${error.path}`;
  const rule = error.rule === undefined ? '' : ` (${error.rule})`;
  return `Your last answer did not match the schema${where}${rule}. Answer again with only the JSON object the schema describes.`;
}

/**
 * Q1, the exact-quote check: the names of the values whose exact words are not in the document
 * (white space read as one space). A model's value the document does not carry is one a person
 * checks: the template's held step sends these to a person. Only strings are checked; an empty
 * one is not.
 */
export function quotesIn(
  documentText: string,
  values: Readonly<Record<string, unknown>>,
): string[] {
  const flat = (text: string) => text.replace(/\s+/gu, ' ').trim();
  const document = flat(documentText);
  return Object.entries(values)
    .filter(([, value]) => typeof value === 'string' && flat(value) !== '')
    .filter(([, value]) => !document.includes(flat(value as string)))
    .map(([name]) => name);
}
