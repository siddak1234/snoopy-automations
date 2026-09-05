import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import type { InvokeRequest, RunResult } from '@autom8x/automation-sdk';
import { RecordingPlatform, declaredSteps, invokeFixture } from '@autom8x/automation-sdk/testing';

import { execute } from '../src/run.js';

const manifestPath = resolve(import.meta.dirname, '../../../manifests/invoice-intake.v1.json');

function invoke(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return invokeFixture({
    templateId: 'invoice-intake',
    config: { holdAboveAmount: 500, notifyEmail: 'ap@example.com' },
    input: {
      trigger: { kind: 'webhook', deliveryId: 'delivery-1001' },
      payload: { vendor: 'Northwind Trading', amount: 120.5, reference: 'INV-1001' },
    },
    ...overrides,
  });
}

function successOutput(result: RunResult): Record<string, unknown> {
  assert.equal(result.outcome, 'success');
  assert.ok(result.outcome === 'success');
  return result.output ?? {};
}

test('a webhook invoice within threshold is accepted and emailed through Google', async () => {
  const platform = new RecordingPlatform();
  const result = await execute(invoke(), platform);

  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome]),
    [
      ['receive', 'ok'],
      ['validate', 'ok'],
      ['notify', 'ok'],
    ],
  );
  assert.equal(platform.providerCalls.length, 1);
  const call = platform.providerCalls[0]!;
  assert.equal(call.providerId, 'google');
  assert.equal(call.operation, 'messages.send');
  assert.equal(call.input.userId, 'me');
  assert.ok(!('accountId' in call.input), 'the platform chooses the connected account');
  assert.ok(!('workspaceId' in call.input), 'the run token supplies the workspace');
  assert.match(call.idempotencyKey, /^invoice-intake-[0-9a-f]{64}$/u);
  assert.ok(call.idempotencyKey.length >= 16 && call.idempotencyKey.length <= 128);

  const message = Buffer.from(String(call.input.raw), 'base64url').toString('utf8');
  assert.match(message, /^To: ap@example\.com\r\n/u);
  assert.match(message, /Content-Type: text\/plain; charset=UTF-8/u);
  assert.equal(successOutput(result).notified, true);
  assert.equal(platform.modelCalls.length, 0, 'invoice intake has no model callback');
});

test('the provider key stays stable and bounded for every schema-valid run id', async () => {
  const request = invoke({ runId: 'run'.repeat(100) });
  const first = new RecordingPlatform();
  const replay = new RecordingPlatform();

  await execute(request, first);
  await execute(request, replay);

  const firstKey = first.providerCalls[0]?.idempotencyKey;
  assert.equal(firstKey, replay.providerCalls[0]?.idempotencyKey);
  assert.match(firstKey ?? '', /^invoice-intake-[0-9a-f]{64}$/u);
  assert.ok((firstKey?.length ?? 0) >= 16 && (firstKey?.length ?? 129) <= 128);
});

test('an invoice above threshold ends held and an approval resumes from state alone', async () => {
  const platform = new RecordingPlatform();
  const held = await execute(
    invoke({
      input: {
        trigger: { kind: 'webhook', deliveryId: 'delivery-2002' },
        payload: { vendor: 'Contoso', amount: 1499.99, reference: 'INV-2002' },
      },
    }),
    platform,
  );

  assert.equal(held.outcome, 'held');
  assert.ok(held.outcome === 'held');
  assert.equal(held.held.stepId, 'validate');
  assert.deepEqual(held.held.state.invoice, {
    vendor: 'Contoso',
    amount: 1499.99,
    reference: 'INV-2002',
  });
  assert.deepEqual(
    platform.steps.map((step) => step.stepId),
    ['receive', 'validate'],
  );
  assert.equal(platform.providerCalls.length, 0, 'a held run stops before the side effect');

  const resumed = new RecordingPlatform();
  const result = await execute(
    invoke({
      input: {},
      continuation: {
        ofRunId: invoke().runId,
        kind: 'approval',
        stepId: 'validate',
        decision: 'approved',
        decidedAt: '2026-09-04T18:00:00.000Z',
        state: held.held.state,
      },
    }),
    resumed,
  );

  assert.deepEqual(
    resumed.steps.map((step) => step.stepId),
    ['notify'],
    'the continuation performs only the work that remains',
  );
  assert.equal(successOutput(result).decidedBy, 'after approval');
  assert.equal(resumed.providerCalls.length, 1);
  assert.equal(resumed.modelCalls.length, 0);
});

test('a direct or malformed payload is refused rather than invented into an invoice', async () => {
  for (const input of [
    { vendor: 'Contoso', amount: 10, reference: 'DIRECT-1' },
    { trigger: { kind: 'manual' }, payload: { vendor: 'Contoso', amount: 10, reference: 'M-1' } },
    { trigger: { kind: 'webhook' }, payload: { vendor: 'Contoso' } },
  ]) {
    const platform = new RecordingPlatform();
    const result = await execute(invoke({ input }), platform);
    assert.equal(result.outcome, 'failed');
    assert.equal(platform.steps.at(-1)?.stepId, 'receive');
    assert.equal(platform.steps.at(-1)?.outcome, 'failed');
    assert.equal(platform.providerCalls.length, 0);
    assert.equal(platform.modelCalls.length, 0);
  }
});

test('a failed email is visible without undoing the accepted invoice', async () => {
  const privateMarker = 'private-provider-response@example.com';
  for (const provider of [
    () => Promise.resolve({ status: 403, body: { detail: privateMarker } }),
    () => Promise.reject(new Error(privateMarker)),
  ]) {
    const platform = new RecordingPlatform();
    platform.provider = provider;
    const result = await execute(invoke(), platform);

    assert.equal(result.outcome, 'success');
    assert.equal(successOutput(result).notified, false);
    assert.equal(platform.steps.at(-1)?.stepId, 'notify');
    assert.equal(platform.steps.at(-1)?.outcome, 'failed');
    assert.ok(!JSON.stringify(platform.steps).includes(privateMarker));
    assert.ok(!JSON.stringify(result).includes(privateMarker));
  }
});

test('the address and unrelated webhook fields never enter retained summaries', async () => {
  const marker = 'ACCOUNT-9911-ROUTING-2200';
  const platform = new RecordingPlatform();
  await execute(
    invoke({
      config: { holdAboveAmount: 500, notifyEmail: 'private.person@example.com' },
      input: {
        trigger: { kind: 'webhook', deliveryId: 'delivery-private' },
        payload: {
          vendor: 'Contoso',
          amount: 10,
          reference: 'INV-PRIVATE',
          routing: marker,
        },
      },
    }),
    platform,
  );

  const summaries = platform.steps.map((step) => step.summary).join(' | ');
  assert.ok(!summaries.includes(marker), 'an unrelated payload field leaked');
  assert.ok(!summaries.includes('private.person@example.com'), 'the configured address leaked');
  assert.ok(!summaries.includes('base64'), 'the encoded message leaked');
});

test('every possible step is declared and the manifest asks only for Gmail send', async () => {
  const scenarios = [
    invoke(),
    invoke({
      input: {
        trigger: { kind: 'webhook', deliveryId: 'delivery-held' },
        payload: { vendor: 'Contoso', amount: 9999, reference: 'INV-HELD' },
      },
    }),
    invoke({ input: {} }),
  ];
  const declared = declaredSteps(manifestPath);
  for (const scenario of scenarios) {
    const platform = new RecordingPlatform();
    await execute(scenario, platform);
    for (const step of platform.steps) {
      assert.ok(declared.has(step.stepId), `undeclared step reported: ${step.stepId}`);
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    trigger: unknown;
    requiredConnections: unknown;
    requiredCapabilities: unknown;
  };
  assert.deepEqual(manifest.trigger, { kind: 'webhook' });
  assert.deepEqual(manifest.requiredConnections, [
    {
      providerId: 'google',
      displayName: 'Google',
      purpose: 'Sends each invoice intake outcome from your own Gmail account.',
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
    },
  ]);
  assert.deepEqual(manifest.requiredCapabilities, []);
});
