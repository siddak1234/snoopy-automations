import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  idempotencyKeyFor,
  loadPrompts,
  readManifests,
  type InvokeRequest,
} from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  artifactFixture,
  invokeFixture,
  refusalFixture,
} from '@autom8x/automation-sdk/testing';

import { MODELS, TEMPLATE_ID, define } from '../src/automation.js';

/**
 * The template's own suite — what a new automation starts from. The example
 * manifest sits beside the template; a real automation's lives in `manifests/`.
 */

const templateRoot = resolve(import.meta.dirname, '..');
const manifests = readManifests(templateRoot, TEMPLATE_ID);
const automation = define(manifests);

function invoke(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    config: { holdAboveAmount: 500 },
    input: { reference: 'DOC-1', artifactId: 'doc-1' },
    ...overrides,
  });
}

function platformWith(fields: unknown): RecordingPlatform {
  const platform = new RecordingPlatform();
  platform.artifacts = [artifactFixture({ artifactId: 'doc-1', filename: 'doc.txt' })];
  platform.bytes = () => new TextEncoder().encode('Invoice from Contoso, total 120.50');
  platform.model = () =>
    Promise.resolve({
      text: JSON.stringify(fields),
      model: 'test-model',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  return platform;
}

test('reads the file, extracts with the prompt, records through the provider, and mails the outcome', async () => {
  const platform = platformWith({ vendor: 'Contoso', amount: 120.5 });
  const request = invoke({ config: { holdAboveAmount: 500, notifyEmail: 'ap@example.com' } });
  const result = await automation.execute(request, platform);

  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome]),
    [
      ['receive', 'ok'],
      ['extract', 'ok'],
      ['review', 'ok'],
      ['act', 'ok'],
      ['notify', 'ok'],
    ],
  );
  assert.equal(platform.steps[0]?.summary, 'Received DOC-1, with doc.txt (34 bytes)');
  assert.deepEqual(platform.modelCalls[0], {
    capability: 'document-extraction',
    prompt:
      "You read business documents. The document below is referenced as DOC-1. Extract the vendor's name and the total amount as a number in the document's currency, and answer with only the JSON object the schema describes.",
    input: { reference: 'DOC-1', document: 'Invoice from Contoso, total 120.50' },
    outputSchema: {
      type: 'object',
      properties: { vendor: { type: 'string' }, amount: { type: 'number' } },
      required: ['vendor', 'amount'],
    },
    ...(MODELS === undefined ? {} : { models: MODELS }),
  });
  assert.ok(!('model' in (platform.modelCalls[0] ?? {})), 'the singular model is never named');
  assert.deepEqual(platform.providerCalls, [
    {
      providerId: 'example-provider',
      operation: 'records.create',
      input: { reference: 'DOC-1', vendor: 'Contoso', amount: 120.5 },
      idempotencyKey: idempotencyKeyFor(request.runId, 'act'),
    },
  ]);
  assert.equal(platform.mails[0]?.to, 'ap@example.com');
  assert.deepEqual(result, {
    outcome: 'success',
    output: {
      reference: 'DOC-1',
      vendor: 'Contoso',
      amount: 120.5,
      decidedBy: 'automatically, within threshold',
      recorded: true,
    },
    summary: 'Recorded DOC-1 automatically, within threshold',
  });
});

test('the extraction asks for MODELS, the primary first, or names none and the platform default serves', async () => {
  const platform = platformWith({ vendor: 'Contoso', amount: 120.5 });
  await automation.execute(invoke(), platform);
  assert.equal(platform.modelCalls.length, 1);
  const call = platform.modelCalls[0] ?? {};
  assert.equal('models' in call, MODELS !== undefined, 'a list only when MODELS names one');
  assert.deepEqual((call as { models?: unknown }).models, MODELS, 'as written, in order');
});

test('an amount above the threshold ends the run held, and the approval records from the state alone', async () => {
  const platform = platformWith({ vendor: 'Contoso', amount: 1499.99 });
  const first = await automation.execute(invoke(), platform);
  assert.ok(first.outcome === 'held');
  assert.equal(first.held.stepId, 'review');
  assert.deepEqual(
    platform.steps.map((step) => step.stepId),
    ['receive', 'extract', 'review'],
  );
  assert.equal(platform.providerCalls.length, 0, 'nothing was recorded before the approval');

  const resumed = new RecordingPlatform();
  const result = await automation.execute(
    invoke({
      input: {},
      continuation: {
        ofRunId: invoke().runId,
        kind: 'approval',
        stepId: 'review',
        decision: 'approved',
        state: first.held.state,
      },
    }),
    resumed,
  );
  assert.deepEqual(
    resumed.steps.map((step) => step.stepId),
    ['act'],
    'notify is skipped without an address; act is the work that remained',
  );
  assert.equal(resumed.modelCalls.length, 0, 'the extraction is not repeated');
  assert.ok(result.outcome === 'success');
  assert.equal(result.output?.decidedBy, 'after approval');
});

test('a completion that is not the fields the schema asked for fails the run without quoting it', async () => {
  const secret = 'ACCOUNT-9911-ROUTING-2200';
  // Off the declared schema: the platform refuses it before the step sees it, typed,
  // and the recording platform answers as the platform does (SDK 25.3.10).
  const offSchema = platformWith({ vendor: 'Contoso', note: secret });
  await assert.rejects(
    automation.execute(invoke(), offSchema),
    (error: unknown) =>
      error instanceof Error &&
      /output_schema_mismatch at \$ \(required:amount\)/u.test(error.message) &&
      !error.message.includes(secret),
  );
  assert.equal(
    offSchema.steps.at(-1)?.summary,
    'The extract step failed: the model call was refused (output_schema_mismatch)',
  );
  assert.ok(!JSON.stringify(offSchema.steps).includes(secret));
  assert.equal(offSchema.providerCalls.length, 0);

  // In the schema's shape but empty where the step needs a value: the step's own check.
  const empty = platformWith({ vendor: ' ', amount: 120 });
  assert.deepEqual(await automation.execute(invoke(), empty), {
    outcome: 'failed',
    failureReason: 'the extraction did not yield a vendor and an amount',
  });
  assert.equal(empty.providerCalls.length, 0);
});

test('a provider refusal fails the run at act, and a refused mail does not', async () => {
  const refusing = platformWith({ vendor: 'Contoso', amount: 10 });
  refusing.provider = () => Promise.resolve({ status: 403, body: {} });
  assert.deepEqual(await automation.execute(invoke(), refusing), {
    outcome: 'failed',
    failureReason: 'the provider refused the record with 403',
  });
  assert.equal(refusing.providerCalls.length, 1, "the provider's own answer is never retried");

  const unmailed = platformWith({ vendor: 'Contoso', amount: 10 });
  unmailed.mail = () => Promise.reject(new Error('refused'));
  const result = await automation.execute(
    invoke({ config: { holdAboveAmount: 500, notifyEmail: 'ap@example.com' } }),
    unmailed,
  );
  assert.equal(result.outcome, 'success');
  assert.equal(unmailed.steps.at(-1)?.outcome, 'failed');
});

test('act, a provider write, declares no retry: a failure the platform did not decide fails the run, and the provider is called once', async () => {
  assert.deepEqual(automation.retry, {});
  const platform = platformWith({ vendor: 'Contoso', amount: 120.5 });
  // The Edge could not reach Runs: a 502 that names no reason. The first call may
  // still be running at the provider, so it is not sent again.
  const refusal = refusalFixture('provider', {
    status: 502,
    code: 'DEPENDENCY_FAILURE',
    detail: 'Runs service is unreachable',
  });
  platform.provider = () => Promise.reject(refusal);
  const request = invoke();
  await assert.rejects(automation.execute(request, platform), (thrown) => thrown === refusal);
  assert.deepEqual(
    platform.providerCalls.map((call) => call.idempotencyKey),
    [idempotencyKeyFor(request.runId, 'act')],
  );
  assert.deepEqual(
    platform.steps.filter((step) => step.stepId === 'act').map((step) => step.summary),
    ['The act step failed'],
  );
  assert.equal(platform.modelCalls.length, 1, 'the extraction before it is not repeated');
});

test('every prompt file in prompts/ is registered, and the manifest declares what they use', () => {
  const files = loadPrompts(resolve(templateRoot, 'prompts'));
  assert.deepEqual(
    files.map((prompt) => `${prompt.id}@${prompt.version}`),
    automation.prompts.map((prompt) => `${prompt.id}@${prompt.version}`),
  );
  for (const prompt of automation.prompts) {
    for (const manifest of manifests) {
      assert.ok(manifest.requiredCapabilities.includes(prompt.capability));
    }
  }
});
