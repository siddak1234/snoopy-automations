import {
  defineAutomation,
  type InvokeRequest,
  type JsonObject,
  type ModelCompletion,
  type ModelRequest,
} from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture, type NO_ANSWER } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import type { CheckInput } from '../src/checks/check.js';
import { VERIFY_DOCUMENT_V1 } from '../src/prompts.js';
import { verifyRead } from '../src/steps/verify-read.js';
import { check, documentOf } from './check-world.js';
import { SEEDED_STATE } from './extract-world.js';
import { completion, pdf, secondAnswer } from './fixtures.js';

/**
 * `verify-read` alone, on the SDK's runner: a first step seeds the state `check-document` leaves —
 * the first read cleaned into `document`, the model that served it — then `verify-read` runs, and
 * the result hands the whole state back. By default the second read is due: QuickBooks chosen and
 * an approval limit of 0, so any amount is over it (decision 3).
 */

/** The settings that make a second read due whatever the document: over a limit of 0. */
export const DUE: JsonObject = { vendor: 'quickbooks', holdAboveAmount: 0 };

/** One second-read attempt's answer. */
export type Answering = (
  call: ModelRequest,
  model: string,
) => Promise<ModelCompletion | typeof NO_ANSWER>;

export interface VerifySetUp {
  /** Read 1's answer, cleaned by check-document into the seeded `document`. */
  readonly first: JsonObject;
  readonly options?: Partial<CheckInput>;
  /** The model that served read 1. */
  readonly firstModel?: string;
  /** What the second read answers; by default a reader who agrees. */
  readonly answer?: Answering;
  /** Changes to the seeded state. */
  readonly state?: JsonObject;
  readonly deadlineInMs?: number;
  /** The flow's settings; `DUE` by default. */
  readonly config?: JsonObject;
}

export function verifyWorld(setUp: VerifySetUp) {
  const document = documentOf(check(setUp.first, setUp.options));
  const seeded: JsonObject = {
    ...SEEDED_STATE,
    document: document as unknown as JsonObject,
    modelServed: setUp.firstModel ?? 'anthropic/claude-haiku-4.5',
    ...setUp.state,
  };
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [
      {
        templateId: TEMPLATE_ID,
        version: 2,
        requiredCapabilities: ['document-extraction'],
        pipeline: [{ id: 'seed' }, { id: 'verify-read' }],
      },
    ],
    prompts: [VERIFY_DOCUMENT_V1],
    steps: {
      seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: seeded }),
      'verify-read': verifyRead(VERIFY_DOCUMENT_V1),
    },
    result: (state) => ({ output: state }),
  });
  const platform = new RecordingPlatform();
  platform.artifacts = [pdf()];
  platform.model =
    setUp.answer ??
    ((_call, model) => Promise.resolve(completion(model, secondAnswer(setUp.first))));
  const request: InvokeRequest = invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 2,
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
