import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineAutomation, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';
import { decide as decideStep } from '../src/decide/step.js';
import { bill, receipt, statement } from './check-world.js';
import { RUN_ID, VENDOR, decideState, type DecideSetUp } from './decide-world.js';
import { manifests } from './fixtures.js';

/**
 * decide as a step on the SDK's runner — after the lookups: one held result at most, its reason the
 * hold phrases; not recorded, the run going on; a statement compared and done; and an approval
 * resuming after decide with the saved plan. Lines (§3.E): `Ready to record`, `Waiting for approval`.
 */

/** decide between a seed and the step after it, as the pipeline will hold it. */
function world(setUp: DecideSetUp, input: JsonObject = {}) {
  const seen: JsonObject[] = [];
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [
      {
        templateId: TEMPLATE_ID,
        version: 2,
        requiredCapabilities: [],
        pipeline: [{ id: 'seed' }, { id: 'decide' }, { id: 'after' }],
      },
    ],
    steps: {
      seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: decideState(setUp) }),
      decide: decideStep(),
      after: ({ state }) => {
        seen.push(state);
        return Promise.resolve({ outcome: 'ok', summary: 'After' });
      },
    },
    result: (state) => ({ output: state }),
  });
  const platform = new RecordingPlatform();
  const request = invokeFixture({
    runId: RUN_ID,
    templateId: TEMPLATE_ID,
    templateVersion: 2,
    config: setUp.config ?? {},
    input,
  });
  return { platform, request, seen, run: () => automation.execute(request, platform), automation };
}

test('held: one result, held at decide, its reason the hold phrases, the saved plan', async () => {
  const { platform, run } = world({ answer: receipt({ paymentMethod: 'cash' }) });
  const result = await run();
  assert.equal(result.outcome, 'held');
  assert.ok(result.outcome === 'held');
  assert.equal(result.held.stepId, 'decide');
  assert.equal(result.held.reason, 'Paid from Checking?');
  const line = platform.steps.at(-1);
  assert.deepEqual(
    [line?.stepId, line?.outcome, line?.summary, line?.heldReason],
    ['decide', 'held', 'Waiting for approval', 'Paid from Checking?'],
  );
  assert.equal((result.held.state as JsonObject).v, 2);
  assert.deepEqual((result.held.state as JsonObject).holdReasons, ['paid_from_pick']);
  assert.equal((result.held.state as JsonObject).chart, undefined, 'the chart left behind');
  assert.deepEqual([platform.providerCalls, platform.modelCalls, platform.mails], [[], [], []]);
});

test('approval resumes after decide with the saved plan, and nothing before it runs again', async () => {
  const first = world({ answer: bill(), config: { holdAboveAmount: 0 } });
  const held = await first.run();
  assert.ok(held.outcome === 'held');
  const resumed = await first.automation.execute(
    {
      ...first.request,
      runId: '88888888-8888-4888-8888-888888888888',
      continuation: {
        ofRunId: RUN_ID,
        kind: 'approval',
        stepId: 'decide',
        decision: 'approved',
        decidedAt: new Date().toISOString(),
        state: held.held.state,
      },
    },
    first.platform,
  );
  assert.equal(resumed.outcome, 'success');
  assert.deepEqual(first.seen, [held.held.state], 'the step after decide sees the saved plan');
  assert.deepEqual(
    first.platform.steps.map((step) => step.stepId),
    ['seed', 'decide', 'after'],
  );
});

test('straight through: ok, the state replaced by the saved plan; a rule QuickBooks keeps: not recorded, the run going on', async () => {
  const straight = world({ answer: bill() });
  const result = await straight.run();
  assert.equal(result.outcome, 'success');
  assert.equal((straight.seen[0] as JsonObject).route, 'bill');
  assert.equal(
    straight.platform.steps.find((step) => step.stepId === 'decide')?.summary,
    'Ready to record',
  );
  const closed = world({ answer: bill(), preferences: { bookCloseDate: '2026-12-31' } });
  assert.equal((await closed.run()).outcome, 'success');
  assert.deepEqual(
    closed.platform.steps.at(-2)?.summary,
    'Not recorded in QuickBooks: that date is in closed books',
  );
  const after = closed.seen[0] as JsonObject;
  assert.deepEqual(after.quickBooks, { notRecorded: 'that date is in closed books' });
  assert.equal(after.chart, undefined, 'the chart left behind');
  assert.ok(after.document, 'the document kept, for its details');
  const incomplete = world({
    answer: bill(),
    state: { vendor: undefined } as unknown as JsonObject,
  });
  assert.deepEqual(await incomplete.run(), {
    outcome: 'failed',
    failureReason: 'Something went wrong. Try again.',
  });
});

test('a statement: compared, the run done with no approval, its comparison the state the output carries', async () => {
  const { run, seen } = world({ answer: statement(), vendor: { ...VENDOR, balanceCents: 68_654 } });
  const result = await run();
  assert.equal(result.outcome, 'success');
  assert.equal((seen[0] as JsonObject).route, 'statement');
  assert.deepEqual((seen[0] as JsonObject).listedNotInQuickBooks, [
    'HOS-1031',
    'HOS-1042',
    'HOS-1050',
  ]);
});

test('in v2: decide is step 17 of the 24, after the nine lookups whose records it reads and before the steps an approval resumes at', () => {
  const automation = define(manifests);
  assert.equal(automation.steps.indexOf('decide'), 16);
  assert.deepEqual(manifests[0]?.pipeline.map((step) => step.id).slice(6), [
    'verify-read',
    'find-vendor',
    'find-vendor-company',
    'find-similar-vendors',
    'find-customer-name',
    'find-employee-name',
    'find-duplicate-number',
    'find-duplicate-amount',
    'find-related',
    'find-other-record',
    'decide',
    'confirm-company',
    'confirm-vendor',
    'create-vendor',
    'confirm-no-duplicate',
    'create-record',
    'save-details',
    'notify',
  ]);
  assert.equal(manifests[0]?.pipeline.length, 24);
});
