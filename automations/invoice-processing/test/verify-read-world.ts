import assert from 'node:assert/strict';

import {
  defineAutomation,
  isObject,
  modelAuthor,
  type InvokeRequest,
  type JsonObject,
  type ModelCompletion,
  type ModelRequest,
} from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture, type NO_ANSWER } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import type { CheckInput } from '../src/checks/check.js';
import { VERIFY_DOCUMENTS_V1 } from '../src/prompts.js';
import { partAnswerOf, v2AnswerOf } from '../src/run/answer.js';
import { documentReadOf } from '../src/run/document-read.js';
import { KIND_OF, runStateOf, type Entry } from '../src/run/state.js';
import { verifyRead } from '../src/run/verify.js';
import { check, documentOf } from './check-world.js';
import { SEEDED_STATE } from './extract-world.js';
import {
  asTexts,
  completion,
  documentAnswer,
  partAnswer,
  pdf,
  secondAnswer,
  verifyAnswer,
} from './fixtures.js';

/**
 * `verify-read` alone, on the SDK's runner, for a file of one document: a first step seeds the
 * state `check-documents` leaves — the document's first read cleaned into its `document`, the model
 * that read it — then `verify-read` runs, and the result hands the whole state back, read here as
 * v2 kept one document's (`flat`). By default the second read is due: QuickBooks chosen and an
 * approval limit of 0, so any amount is over it (decision 3).
 */

/** The settings that make a second read due whatever the document: over a limit of 0. */
export const DUE: JsonObject = { vendor: 'quickbooks', holdAboveAmount: 0 };

/** One second-read attempt's answer: one document's 14 fields, or a whole answer. */
export type Answering = (
  call: ModelRequest,
  model: string,
) => Promise<ModelCompletion | typeof NO_ANSWER>;

export interface VerifySetUp {
  /** Read 1's answer, cleaned by the checks into the seeded `document`. */
  readonly first: JsonObject;
  readonly options?: Partial<CheckInput>;
  /** The model that served read 1. */
  readonly firstModel?: string;
  /** What the second read answers; by default a reader who agrees. */
  readonly answer?: Answering;
  /** Changes to the seeded state: `document`, `verification`, `quickBooks` are the document's. */
  readonly state?: JsonObject;
  readonly deadlineInMs?: number;
  /** The flow's settings; `DUE` by default. */
  readonly config?: JsonObject;
}

const DOCUMENT_KEYS = ['document', 'verification', 'quickBooks'];

/** A second read answering one document's fields, as the whole answer for the file's one document. */
function asWhole(answer: ModelCompletion | typeof NO_ANSWER): ModelCompletion | typeof NO_ANSWER {
  if (typeof answer === 'symbol') return answer;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    return answer;
  }
  if (!isObject(parsed) || Array.isArray(parsed.documents) || !('documentType' in parsed)) {
    return answer;
  }
  const whole = verifyAnswer([[1, asTexts(parsed)]], 1);
  return { ...answer, text: JSON.stringify(whole) };
}

export function verifyWorld(setUp: VerifySetUp) {
  const document = documentOf(check(setUp.first, setUp.options));
  const [read] = partAnswerOf(partAnswer([documentAnswer(setUp.first)]))?.documents ?? [];
  assert.ok(read, 'a usable first read');
  const own = Object.fromEntries(
    Object.entries(setUp.state ?? {}).filter(([key]) => DOCUMENT_KEYS.includes(key)),
  );
  const shared = Object.fromEntries(
    Object.entries(setUp.state ?? {}).filter(([key]) => !DOCUMENT_KEYS.includes(key)),
  );
  const engine: JsonObject = { document: document as unknown as JsonObject, ...own };
  for (const [key, value] of Object.entries(engine)) if (value === undefined) delete engine[key];
  const entry: Entry = {
    index: 1,
    kind: KIND_OF[read.documentType],
    read: documentReadOf(read),
    answer: v2AnswerOf(read),
    doubts: [],
    engine,
    stage: 'read',
  };
  const firstModel = setUp.firstModel ?? 'anthropic/claude-haiku-4.5';
  const maker = modelAuthor(firstModel);
  const seeded: JsonObject = {
    ...SEEDED_STATE,
    modelServed: firstModel,
    readMakers: maker === undefined ? [] : [maker],
    documents: [entry as unknown as JsonObject],
    ...shared,
  };
  for (const [key, value] of Object.entries(seeded)) if (value === undefined) delete seeded[key];
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [
      {
        templateId: TEMPLATE_ID,
        version: 3,
        requiredCapabilities: ['document-extraction'],
        pipeline: [{ id: 'seed' }, { id: 'verify-read' }],
      },
    ],
    prompts: [VERIFY_DOCUMENTS_V1],
    steps: {
      seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: seeded }),
      'verify-read': verifyRead(VERIFY_DOCUMENTS_V1, { now: () => Date.parse('2026-10-11') }),
    },
    result: (state) => ({ output: state }),
  });
  const platform = new RecordingPlatform();
  platform.artifacts = [pdf()];
  const answer: Answering =
    setUp.answer ??
    ((_call, model) => Promise.resolve(completion(model, secondAnswer(setUp.first))));
  platform.model = async (call, model) => asWhole(await answer(call, model));
  const request: InvokeRequest = invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 3,
    config: setUp.config ?? DUE,
    deadline: new Date(Date.now() + (setUp.deadlineInMs ?? 900_000)).toISOString(),
  });
  return {
    platform,
    request,
    seeded,
    document,
    run: () => automation.execute(request, platform),
    /** The step's own line. */
    line: () => platform.steps.find((step) => step.stepId === 'verify-read'),
  };
}

/** A state as v2 kept one document's: what the run shares, and the document's own keys. */
export function flat(state: JsonObject): JsonObject {
  const [entry] = runStateOf(state)?.documents ?? [];
  return { ...state, ...(entry?.engine ?? {}) };
}
