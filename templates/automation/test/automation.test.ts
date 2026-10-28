import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  FLOW_WORDS,
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

import { MODELS, TEMPLATE_ID, WORDS, define } from '../src/automation.js';

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
  // The document prints the vendor the model reads, so the exact-quote check (Q1) passes.
  const vendor = (fields as { vendor?: unknown }).vendor;
  platform.bytes = () =>
    new TextEncoder().encode(`Invoice from ${String(vendor ?? 'Contoso')}, total 120.50`);
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
    blocks: [
      {
        type: 'metric',
        items: [
          { label: 'Amount', value: '$120.50' },
          { label: 'Recorded', value: 'Yes', tone: 'success' },
        ],
      },
      {
        type: 'table',
        columns: [{ title: 'Field' }, { title: 'Value' }],
        rows: [
          { cells: ['Reference', 'DOC-1'] },
          { cells: ['Vendor', 'Contoso'] },
          { cells: ['Decided', 'Automatically'] },
        ],
      },
    ],
  });
});

test("what a person reads is sent as blocks, bounded: the model's words cut, or left empty", async () => {
  const cells = async (vendor: string) => {
    const result = await automation.execute(invoke(), platformWith({ vendor, amount: 12 }));
    assert.ok(result.outcome === 'success');
    const table = result.blocks?.find((block) => block.type === 'table');
    assert.ok(table?.type === 'table');
    return table.rows.map((row) => row.cells[1]);
  };
  assert.deepEqual(await cells('Contoso  \n Ltd'), ['DOC-1', 'Contoso Ltd', 'Automatically']);
  assert.equal((await cells('V'.repeat(300)))[1], 'V'.repeat(200), 'a cell is cut at 200');
  // Sent as written, the platform would refuse the result whole, and the run be unreportable.
  assert.deepEqual(await cells('<b>Contoso</b>'), ['DOC-1', '', 'Automatically']);
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
  const table = result.blocks?.find((block) => block.type === 'table');
  assert.deepEqual(table?.type === 'table' && table.rows.at(-1), {
    cells: ['Decided', 'After approval'],
  });
});

test('a completion off its schema is asked once more, then held for a person, never quoted', async () => {
  const secret = 'ACCOUNT-9911-ROUTING-2200';
  // Off the declared schema: the platform refuses it before the step sees it, typed, and the
  // recording platform answers as the platform does (SDK 25.3.10). `defineFlow` asks once more
  // with one fixed line (Q2), and holds the run when the answer misses again.
  const offSchema = platformWith({ vendor: 'Contoso', note: secret });
  const result = await automation.execute(invoke(), offSchema);
  assert.ok(result.outcome === 'held');
  assert.equal(result.held.reason, FLOW_WORDS.ai_unmatched);
  assert.equal(offSchema.modelCalls.length, 2, 'one more paid call, never a third');
  assert.ok(!JSON.stringify([result, offSchema.steps]).includes(secret));
  assert.equal(offSchema.providerCalls.length, 0);

  // In the schema's shape but empty where the step needs a value: the step's own check.
  const empty = platformWith({ vendor: ' ', amount: 120 });
  assert.deepEqual(await automation.execute(invoke(), empty), {
    outcome: 'failed',
    failureReason: WORDS.noFields,
  });
  assert.equal(empty.providerCalls.length, 0);
});

test('a vendor the document does not print is held for a person (Q1)', async () => {
  const platform = platformWith({ vendor: 'Contoso', amount: 12 });
  platform.bytes = () => new TextEncoder().encode('Invoice from Fabrikam, total 12.00');
  const result = await automation.execute(invoke(), platform);
  assert.ok(result.outcome === 'held');
  assert.equal(result.held.reason, WORDS.checkVendor);
  assert.ok(!('document' in result.held.state), 'the document is not kept in the held state');
});

test('a provider refusal fails the run at act, and a refused mail does not', async () => {
  const refusing = platformWith({ vendor: 'Contoso', amount: 10 });
  refusing.provider = () => Promise.resolve({ status: 403, body: {} });
  assert.deepEqual(await automation.execute(invoke(), refusing), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.vendor_refused,
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

test('act, a provider write, declares no retry: a failure the platform did not decide ends the run saying to check the app, never "Try again", and the provider is called once', async () => {
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
  assert.deepEqual(await automation.execute(request, platform), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.unconfirmed,
  });
  assert.deepEqual(
    platform.providerCalls.map((call) => call.idempotencyKey),
    [idempotencyKeyFor(request.runId, 'act')],
  );
  assert.deepEqual(
    platform.steps.filter((step) => step.stepId === 'act').map((step) => step.summary),
    [FLOW_WORDS.unconfirmed],
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
