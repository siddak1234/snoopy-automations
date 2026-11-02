import {
  readJsonCompletion,
  settle,
  type JsonObject,
  type ModelCallOptions,
  type PageRange,
  type PromptModule,
  type StepContext,
} from '@autom8x/automation-sdk';

import { MODELS } from '../models.js';

/**
 * The audit record of each AI call (the owner's audit fixes, 2026-11-01), kept in the run's state
 * and given in its output: the step, the prompt and its version, the model that served, the file
 * and its pages, the tokens, the finish reason, the JSON answer, what the step's gate made of it,
 * and the ids of the clinic's examples it was sent.
 */
export interface AuditRecord {
  step: string;
  prompt: string;
  model: string;
  file: string | null;
  pages: PageRange | null;
  tokens: { input: number; output: number };
  finishReason: string;
  answer: unknown;
  gate: string;
  examples: string[];
}

/** The records a run's state holds so far. */
export const auditOf = (state: JsonObject): AuditRecord[] =>
  Array.isArray(state.audit) ? (state.audit as unknown as AuditRecord[]) : [];

/** The most bytes of answers the output keeps: a later record past it gives its answer as null. */
export const AUDIT_ANSWER_BYTES = 96 * 1024;

/** The records as the output gives them: every record, each answer while the answers fit. */
export function boundedAudit(records: readonly AuditRecord[]): AuditRecord[] {
  let room = AUDIT_ANSWER_BYTES;
  return records.map((record) => {
    room -= Buffer.byteLength(JSON.stringify(record.answer), 'utf8');
    return room >= 0 ? record : { ...record, answer: null };
  });
}

/**
 * One AI call, settled (`settle`), its answer read as JSON, and its audit record with an empty
 * gate for the step to fill.
 */
export async function askModel(
  context: StepContext,
  prompt: PromptModule,
  input: JsonObject,
  options: ModelCallOptions = {},
  examples: string[] = [],
) {
  const asked = await settle(context, () =>
    context.platform.callModel(prompt, input, { models: MODELS, ...options }),
  );
  if (!asked.ok) return asked;
  const { model, finishReason, usage } = asked.value;
  const answer = readJsonCompletion(asked.value);
  const record: AuditRecord = {
    step: context.stepId,
    prompt: `${prompt.id} v${prompt.version}`,
    model,
    file: options.artifactId ?? null,
    pages: options.pages ?? null,
    tokens: { input: usage.inputTokens, output: usage.outputTokens },
    finishReason,
    answer,
    gate: '',
    examples,
  };
  return { ok: true as const, answer, record };
}

/**
 * Runs `work` on items 0 to `count` − 1 in order, `width` at once; none starts once a `work` has
 * answered false or thrown (the throw is the run's).
 */
export async function atOnce(
  count: number,
  width: number,
  work: (at: number) => Promise<boolean>,
): Promise<void> {
  let next = 0;
  let going = true;
  const worker = async (): Promise<void> => {
    while (going && next < count) {
      const at = next;
      next += 1;
      try {
        going &&= await work(at);
      } catch (error) {
        going = false;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
}
