import type { ModelCompletion, ModelRequest } from './contract.js';
import { MODEL_REQUEST_LIMITS } from './model-request.js';
import type { AutomationPlatform } from './platform.js';
import { CallbackRefusedError, ModelRefusedError } from './refusals.js';
import { retryableUnder, spreadWaits } from './retry.js';
import { buildRunner } from './runner.js';
import { jsonLogger, type Logger } from './serve.js';
import { codeOf, isUnmatched, kindOf, markUnmatched } from './settle.js';
import {
  held,
  type Automation,
  type AutomationDefinition,
  type RunnerStandards,
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
 * - **`retryLeft` on every attempt** (`settle`): true while the runner would run the step again,
 *   and false once the attempt has had a model answer — so a re-ask that then gets no answer ends
 *   as `unanswered`, and the billed first call is never made again (the re-check's finding 1).
 * - **Q2.** An answer that misses its schema (`output_schema_mismatch`) is asked once more with
 *   the same registered prompt and one fixed line naming the schema's `path` and `rule`. A second
 *   miss holds the run for a person (`FLOW_WORDS.ai_unmatched`; the state gains
 *   `unmatchedAnswer: <step id>` for the step after it). **One to three more paid AI calls**: the
 *   platform tries the request's next model on a miss too.
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
}

/** The owner's cap on one answer, the most a re-ask asks for. */
const CAP = MODEL_REQUEST_LIMITS.maxOutputTokens;

/** Refusals the model had already answered for: billed (`runs.model_calls`). */
const SPENT = new Set(['output_schema_mismatch', 'content_filtered', 'truncated']);

export function defineFlow(definition: FlowDefinition): Automation {
  const log = definition.log ?? jsonLogger(definition.templateId);
  const sentences = definition.sentences ?? {};
  const standards: RunnerStandards = {
    waits: (policy) => spreadWaits(policy),
    attemptOf(attempt, { context, policy, waits, platform, platformWith }) {
      const answered = { value: false };
      const repeats = retryableUnder(policy);
      const deadlineAt = Date.parse(context.request.deadline);
      const wait = waits[attempt - 1];
      const retryLeft = (error: unknown): boolean =>
        !answered.value &&
        !isUnmatched(error) &&
        repeats(error) &&
        wait !== undefined &&
        Date.now() + wait < deadlineAt;
      return {
        context: { ...context, platform: platformWith(reasking(platform, answered)), retryLeft },
        retryable: retryLeft,
      };
    },
    thrown(stepId, error, context): StepResult {
      log('error', 'step_threw', { runId: context.request.runId, stepId, ...shapeOf(error) });
      if (isUnmatched(error)) {
        return held({
          summary: FLOW_WORDS.ai_unmatched,
          heldReason: FLOW_WORDS.ai_unmatched,
          state: { ...context.state, unmatchedAnswer: stepId },
        });
      }
      const sentence = sentences[stepId] ?? kindOf(error)?.sentence ?? FLOW_WORDS.other;
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
    async execute(request, platform) {
      try {
        return await automation.execute(request, platform);
      } catch (error) {
        log('error', 'run_failed_on_a_throw', { runId: request.runId, ...shapeOf(error) });
        return { outcome: 'failed', failureReason: FLOW_WORDS.other };
      }
    },
  };
}

/** The platform's model call, with Q2's and 5d's one re-ask, noting when a model has answered. */
function reasking(platform: AutomationPlatform, answered: { value: boolean }) {
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

/** What the log keeps of an error: its name, and a refusal's status, code and reason. */
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
