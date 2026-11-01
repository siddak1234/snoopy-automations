import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { isManifest, type Manifest } from '../src/manifest.js';
import { PlatformClient } from '../src/platform.js';
import { definePrompt } from '../src/prompt.js';
import { CallbackRefusedError } from '../src/refusals.js';
import { held, type StepContext } from '../src/steps.js';
import { RecordingPlatform, artifactFixture, unitFixture } from '../src/testing.js';
import { MEMORY_LIMITS } from '../src/memory.js';
import { assertValid, validator } from './published-schemas.js';
import { define, invoke, manifest, ok } from './runner-fixtures.js';
import { type StubPlatform, startStubPlatform } from './stub-platform.js';

/**
 * Batch intake and a flow's memory in the runner, the client and the double (platform ADR-0048
 * amendments 3 and 4): a batch run runs `batch.pipeline` and answers units; a child run, with its
 * `unit`, runs `pipeline`; a step's model call reads a page range; `platform.memory` reaches the
 * two callbacks; a keyless provider's fixed query is refused as the platform refuses it.
 */

const FILE = '33333333-3333-4333-8333-333333333333';
const withBatch: Manifest = {
  ...manifest(1, ['read', 'save'], ['document-extraction', 'memory']),
  batch: {
    pipeline: [{ id: 'chunk' }, { id: 'queue' }],
    unitWords: { singular: 'Visit', plural: 'Visits' },
  },
};
const unit = { label: 'Jane Doe · Oct 12, 2026', artifacts: [{ artifactId: FILE }], data: {} };
const steps = {
  chunk: ok('Chunked', { chunked: true }),
  queue: ok('Queued', { units: [unit] }),
  read: (context: StepContext) =>
    Promise.resolve({
      outcome: 'ok' as const,
      summary: 'Read',
      state: { label: context.request.unit?.label ?? null },
    }),
  save: ok('Saved'),
};
const automation = () =>
  define({
    manifests: [withBatch],
    steps,
    result: (state) => ({
      summary: 'Done',
      output: { ...state },
      ...(Array.isArray(state.units) ? { units: state.units as never } : {}),
    }),
  });

test('a batch run runs batch.pipeline and answers its units; a child, with its unit, runs pipeline', async () => {
  const platform = new RecordingPlatform();
  const batch = await automation().execute(invoke({ batch: true }), platform);
  assert.deepEqual(
    platform.steps.map((step) => step.stepId),
    ['chunk', 'queue'],
  );
  assert.equal(batch.outcome, 'success');
  assert.deepEqual(batch.outcome === 'success' && batch.units, [unit]);

  const child = new RecordingPlatform();
  const run = await automation().execute(invoke({ unit: unitFixture(unit) }), child);
  assert.deepEqual(
    child.steps.map((step) => step.stepId),
    ['read', 'save'],
  );
  assert.deepEqual(run.outcome === 'success' && run.output, { label: unit.label });
});

test('a batch run of a version without a batch, a held batch run, an unimplemented batch step: refused', async () => {
  const plain = await define().execute(invoke({ batch: true }), new RecordingPlatform());
  assert.match(plain.outcome === 'failed' ? plain.failureReason : '', /declares no batch/u);

  const holding = define({
    manifests: [withBatch],
    steps: {
      ...steps,
      queue: () => Promise.resolve(held({ summary: 'Wait', heldReason: 'Wait', state: {} })),
    },
  });
  const ended = await holding.execute(invoke({ batch: true }), new RecordingPlatform());
  assert.match(ended.outcome === 'failed' ? ended.failureReason : '', /cannot be held/u);

  const { queue: _queue, ...missing } = steps;
  assert.throws(
    () => define({ manifests: [withBatch], steps: missing }),
    /declares step "queue", which the code does not implement/u,
  );
});

test("a step's model call sends a page range, and the double refuses one the file cannot give", async () => {
  const prompt = definePrompt({
    id: 'categorize',
    version: 1,
    capability: 'document-extraction',
    template: 'Sort the pages.',
    outputSchema: {},
  });
  let sent: unknown;
  const reading = define({
    manifests: [withBatch],
    prompts: [prompt],
    steps: {
      ...steps,
      chunk: async (context) => {
        await context.platform.callModel(
          prompt,
          {},
          { artifactId: FILE, pages: { from: 2, to: 4 } },
        );
        return { outcome: 'ok', summary: 'Chunked' };
      },
    },
  });
  const platform = new RecordingPlatform();
  platform.artifacts = [artifactFixture({ pageCount: 3 })];
  platform.model = (call, model) => {
    sent = call.pages;
    return Promise.resolve({
      text: 'x',
      model,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  };
  await assert.rejects(reading.execute(invoke({ batch: true }), platform), (error) => {
    assert.ok(error instanceof CallbackRefusedError);
    return error.reason === 'pages_out_of_range';
  });
  platform.artifacts = [artifactFixture({ pageCount: 4 })];
  await reading.execute(invoke({ batch: true }), platform);
  assert.deepEqual(sent, { from: 2, to: 4 });
  platform.artifacts = [artifactFixture({ contentType: 'image/jpeg' })];
  await assert.rejects(
    reading.execute(invoke({ batch: true }), platform),
    /only meaningful for a PDF/u,
  );
});

test("the double's memory: kept as JSON, null removes, the 101st key and an undeclared flow refused", async () => {
  const platform = new RecordingPlatform();
  assert.equal(await platform.memory.get('codes'), null);
  assert.equal(await platform.memory.put('codes', { N18: 2 }), 1);
  assert.deepEqual(await platform.memory.get('codes'), { N18: 2 });
  assert.equal(await platform.memory.put('codes', null), 0);
  await assert.rejects(platform.memory.put('Bad Key', 1), /lowercase letters/u);
  for (let at = 0; at < MEMORY_LIMITS.keys; at += 1) await platform.memory.put(`k${at}`, at);
  await assert.rejects(platform.memory.put('one-more', 1), (error) => {
    return error instanceof CallbackRefusedError && error.reason === 'memory_full';
  });
  platform.memory.declared = false;
  await assert.rejects(platform.memory.get('k1'), (error) => {
    return error instanceof CallbackRefusedError && error.reason === 'capability_not_declared';
  });
});

test("a keyless provider's fixed query named by the caller is the platform's 400, nothing recorded", async () => {
  const platform = new RecordingPlatform();
  platform.fixedQuery = { 'nppes npi.lookup': ['version'] };
  const call = {
    providerId: 'nppes',
    operation: 'npi.lookup',
    idempotencyKey: 'npi-0123456789abcdef',
  };
  await assert.rejects(
    platform.callProvider({ ...call, input: { number: '1234567893', version: '1.0' } }),
    (error) => error instanceof CallbackRefusedError && error.reason === 'fixed_query',
  );
  assert.equal(platform.providerCalls.length, 0);
  await platform.callProvider({ ...call, input: { number: '1234567893' } });
  assert.equal(platform.providerCalls.length, 1);
});

let stub: StubPlatform;
before(async () => {
  stub = await startStubPlatform();
});
after(async () => {
  await stub.close();
});

test('the client reaches memory-get and memory-put with the token, and refuses a bad key unsent', async () => {
  const client = new PlatformClient(stub.origin, 'run-token', { timeoutMs: 1000 });
  stub.answers['memory-get'] = () => ({ status: 200, body: { value: { N18: 1 } } });
  assert.deepEqual(await client.memory.get('codes'), { N18: 1 });
  assert.equal(await client.memory.put('codes', { N18: 2 }), 1);
  const [get, put] = stub.calls.slice(-2);
  assert.equal(get?.path, '/v1/automations/callbacks/memory-get');
  assert.deepEqual(get?.body, { key: 'codes' });
  assert.equal(put?.path, '/v1/automations/callbacks/memory-put');
  assert.deepEqual(put?.body, { key: 'codes', value: { N18: 2 } });
  assertValid(validator('automation-memory-put-request'), put?.body, 'the put sent');
  const before = stub.calls.length;
  await assert.rejects(client.memory.get('Codes'), /lowercase letters/u);
  assert.equal(stub.calls.length, before, 'nothing sent');
});

test('a manifest declaring Healthcare, batch, memory, object options and a several-file field validates', () => {
  const reference = JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'fixtures/reference-manifest.json'), 'utf8'),
  ) as Record<string, unknown> & {
    display: Record<string, unknown>;
    trigger: Record<string, unknown>;
  };
  const v2 = {
    ...reference,
    display: { ...reference.display, category: 'Healthcare' },
    trigger: {
      kind: 'manual',
      input: [
        {
          key: 'notes',
          title: 'Visit notes',
          description: 'PDFs.',
          control: 'artifact',
          required: true,
          multiple: true,
          maxFiles: 50,
        },
      ],
    },
    requiredCapabilities: ['document-extraction', 'memory'],
    batch: {
      pipeline: [{ id: 'chunk', title: 'Pages counted', description: 'Each file.' }],
      unitWords: { singular: 'Visit', plural: 'Visits' },
    },
  };
  assertValid(validator('automation-manifest'), v2, 'a v2 manifest');
  assert.ok(isManifest(v2));
  assert.equal(isManifest({ ...v2, batch: { pipeline: [] } }), false);
  const options = [{ value: '207RN0300X', label: 'Nephrology', group: 'Physicians' }];
  const select = {
    section: 'rules',
    key: 's',
    title: 'S',
    description: 'S.',
    control: 'select',
    required: true,
    options,
  };
  assertValid(validator('automation-manifest'), { ...v2, setup: [select] }, 'object options');
});
