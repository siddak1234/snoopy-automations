import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { CallbackRefusedError } from '@autom8x/automation-sdk';
import { RecordingPlatform, artifactFixture, declaredSteps } from '@autom8x/automation-sdk/testing';

import { automation, invoke, invokeAt, manifests, manifestsRoot, output } from './fixtures.js';

/**
 * The automation's own behaviour, against the recording platform: which steps it
 * claims, what it hands back, and what it never carries. Ported with the move from
 * the platform repository; the platform's acceptance is proven by the SDK's own
 * suite against the wire. The outcome mail is `notify.test.ts`.
 */

test('the container serves v1 to v4, and only v2 and later declare notify', () => {
  assert.deepEqual(automation.versions, [1, 2, 3, 4]);
  assert.deepEqual(automation.steps, ['receive', 'validate', 'post', 'notify']);
  assert.deepEqual(
    [...declaredSteps(join(manifestsRoot, 'invoice-check.v1.json'))],
    ['receive', 'validate', 'post'],
  );
});

test('an invoice within the threshold is posted and succeeds', async () => {
  const platform = new RecordingPlatform();
  const result = await automation.execute(invoke({ config: { holdAboveAmount: 500 } }), platform);
  assert.deepEqual(result, {
    outcome: 'success',
    output: {
      reference: 'INV-1001',
      vendor: 'Northwind Trading',
      amount: 120.5,
      decidedBy: 'automatically, within threshold',
    },
    summary: 'Recorded INV-1001 automatically, within threshold',
  });
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome]),
    [
      ['receive', 'ok'],
      ['validate', 'ok'],
      ['post', 'ok'],
    ],
  );
});

test('a long reference no longer fails a recorded run: the result summary is bounded on the wire (platform §12.1 #220)', async () => {
  const platform = new RecordingPlatform();
  const request = invoke({ input: { vendor: 'Contoso', amount: 10, reference: 'R'.repeat(300) } });
  const result = await automation.execute(request, platform);
  assert.equal(result.outcome, 'success');
  // What the SDK sends: the recording platform bounds the result exactly as the
  // client does before posting it, so a 341-character summary is cut, not refused.
  await platform.reportResult(request.runId, result);
  const sent = platform.results[0]?.result;
  assert.ok(sent && sent.outcome === 'success');
  assert.equal(sent.summary?.length, 200);
  assert.ok(sent.summary?.startsWith('Recorded RRRR'));
  for (const step of platform.steps) assert.ok(step.summary.length <= 200, step.stepId);
});

test('an invoice above the threshold ends the run held, with state to resume from', async () => {
  const platform = new RecordingPlatform();
  const result = await automation.execute(
    invoke({
      config: { holdAboveAmount: 500 },
      input: { vendor: 'Contoso', amount: 1499.99, reference: 'INV-2002' },
    }),
    platform,
  );
  assert.equal(result.outcome, 'held');
  assert.ok(result.outcome === 'held');
  assert.equal(result.held.stepId, 'validate');
  assert.match(result.held.reason, /Contoso/u, 'the approver is told what they are deciding on');
  // The state is this automation's memory across the gap: enough to finish the
  // work without the original trigger payload, which is gone.
  assert.deepEqual(result.held.state, {
    invoice: { vendor: 'Contoso', amount: 1499.99, reference: 'INV-2002' },
    threshold: 500,
  });
  assert.deepEqual(
    platform.steps.map((step) => step.stepId),
    ['receive', 'validate'],
    'post never ran: a held run stops at the step that held',
  );
  assert.equal(platform.steps[1]?.heldReason, 'Someone should approve this before it is posted');
});

test('an approved continuation finishes from the state alone', async () => {
  const platform = new RecordingPlatform();
  const result = await automation.execute(
    invoke({
      // No input at all: the trigger payload is long gone by the time a person
      // decides. Everything needed comes back in `continuation.state`.
      input: {},
      continuation: {
        ofRunId: '33333333-3333-4333-8333-333333333333',
        kind: 'approval',
        stepId: 'validate',
        decision: 'approved',
        state: {
          invoice: { vendor: 'Contoso', amount: 1499.99, reference: 'INV-2002' },
          threshold: 500,
        },
      },
    }),
    platform,
  );
  assert.equal(result.outcome, 'success');
  assert.ok(result.outcome === 'success');
  assert.equal(result.output?.reference, 'INV-2002');
  assert.equal(result.output?.decidedBy, 'after approval');
  assert.equal(result.summary, 'Recorded INV-2002 after approval');
  assert.deepEqual(
    platform.steps.map((step) => step.stepId),
    ['post'],
    'a continuation resumes at the remaining work rather than repeating what was done',
  );

  const malformed = new RecordingPlatform();
  const refused = await automation.execute(
    invoke({
      input: {},
      continuation: {
        ofRunId: '33333333-3333-4333-8333-333333333333',
        kind: 'approval',
        stepId: 'validate',
        decision: 'approved',
        state: { invoice: { vendor: 'Contoso' } },
      },
    }),
    malformed,
  );
  assert.deepEqual(refused, {
    outcome: 'failed',
    failureReason: 'the approved state did not carry an invoice',
  });
});

test('the workspace threshold decides, not a constant', async () => {
  const strict = new RecordingPlatform();
  assert.equal(
    (await automation.execute(invoke({ config: { holdAboveAmount: 50 } }), strict)).outcome,
    'held',
    '120.50 is above a 50 threshold',
  );
  const relaxed = new RecordingPlatform();
  assert.equal(
    (await automation.execute(invoke({ config: { holdAboveAmount: 5000 } }), relaxed)).outcome,
    'success',
    'and below a 5000 one',
  );
});

test('an unusable payload fails rather than inventing an invoice', async () => {
  const platform = new RecordingPlatform();
  const result = await automation.execute(invoke({ input: { vendor: 'Contoso' } }), platform);
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason: 'input must carry vendor, amount, and reference',
  });
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome]),
    [['receive', 'failed']],
  );
});

test('a file the run was given is read by reference and measured from its bytes, never linked in a summary', async () => {
  const platform = new RecordingPlatform();
  platform.artifacts = [artifactFixture({ artifactId: 'doc-1', filename: 'invoice.pdf' })];
  platform.bytes = () => new TextEncoder().encode('THE INVOICE');
  await automation.execute(
    invoke({ input: { vendor: 'Contoso', amount: 10, reference: 'INV-3', artifactId: ' doc-1 ' } }),
    platform,
  );
  assert.deepEqual(platform.artifactReads, ['doc-1']);
  assert.equal(
    platform.steps[0]?.summary,
    'Invoice INV-3 from Contoso, with invoice.pdf (11 bytes)',
  );
  assert.ok(
    !JSON.stringify(platform.steps).includes('signature=fixture'),
    'the link never reaches the timeline',
  );

  const missing = new RecordingPlatform();
  await assert.rejects(
    automation.execute(
      invoke({ input: { vendor: 'Contoso', amount: 10, reference: 'INV-4', artifactId: 'gone' } }),
      missing,
    ),
    (error: unknown) => error instanceof CallbackRefusedError && error.status === 404,
  );
  assert.deepEqual(
    missing.steps.map((step) => [step.stepId, step.outcome, step.summary]),
    [['receive', 'failed', 'The receive step failed']],
    'the timeline names the step the run died in, with fixed text',
  );
});

test('every step this automation can report is declared by the pinned version', async () => {
  for (const manifest of manifests) {
    const declared = declaredSteps(join(manifestsRoot, `invoice-check.v${manifest.version}.json`));
    for (const scenario of [
      invokeAt(manifest.version),
      invokeAt(manifest.version, { holdAboveAmount: 50 }),
      invoke({ templateVersion: manifest.version, input: {} }),
    ]) {
      const platform = new RecordingPlatform();
      await automation.execute(scenario, platform);
      for (const step of platform.steps) {
        assert.ok(declared.has(step.stepId), `v${manifest.version} reported ${step.stepId}`);
      }
    }
  }
});

test('a summary never carries the document it describes', async () => {
  const platform = new RecordingPlatform();
  const secret = 'ACCOUNT-9911-ROUTING-2200';
  await automation.execute(
    invoke({ input: { vendor: 'Contoso', amount: 10, reference: secret, note: secret } }),
    platform,
  );
  // The reference is an identifier and belongs in a summary; anything else from
  // the payload does not. The timeline outlives the run and is read by people.
  const summaries = platform.steps.map((step) => step.summary).join(' | ');
  assert.ok(!summaries.includes('note'), 'no payload field leaks into the timeline');
});
