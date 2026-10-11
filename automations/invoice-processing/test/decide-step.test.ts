import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineAutomation, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';
import { decide as decideStep } from '../src/decide/step.js';
import { bill, paidBy, receipt, statement } from './check-world.js';
import { RUN_ID, VENDOR, decideState, type DecideSetUp } from './decide-world.js';
import { manifests } from './fixtures.js';

/**
 * decide as a step on the SDK's runner — not in v1's pipeline until Group 4's lookups are: one
 * held result at most, failed with the fixed sentence, a statement compared and done, and an
 * approval resuming after decide with the saved plan.
 */

/** decide between a seed and the step after it, as the pipeline will hold it. */
function world(setUp: DecideSetUp, input: JsonObject = {}) {
  const seen: JsonObject[] = [];
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [
      {
        templateId: TEMPLATE_ID,
        version: 1,
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
    templateVersion: 1,
    config: setUp.config ?? {},
    input,
  });
  return { platform, request, seen, run: () => automation.execute(request, platform), automation };
}

test('held: one result, held at decide, its reason line, the wording under its line, the saved plan', async () => {
  const { platform, run } = world(
    { answer: receipt(), check: paidBy('employee', { paidFrom: null }) },
    { paidPersonally: true },
  );
  const result = await run();
  assert.equal(result.outcome, 'held');
  assert.ok(result.outcome === 'held');
  assert.equal(result.held.stepId, 'decide');
  assert.equal(result.held.reason, 'Paid personally: Robin Example paid Tidewell Hardware, $60.63');
  const line = platform.steps.at(-1);
  assert.deepEqual(
    [line?.stepId, line?.outcome, line?.heldReason],
    [
      'decide',
      'held',
      'Approve to record this expense and that the company owes Robin Example $60.63',
    ],
  );
  assert.equal((result.held.state as JsonObject).v, 1);
  assert.deepEqual((result.held.state as JsonObject).holdReasons, ['paid_personally']);
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

test('straight through: ok, the state replaced by the saved plan; a fail: the fixed sentence', async () => {
  const straight = world({ answer: bill() });
  const result = await straight.run();
  assert.equal(result.outcome, 'success');
  assert.equal((straight.seen[0] as JsonObject).route, 'bill');
  assert.ok(
    straight.platform.steps
      .find((step) => step.stepId === 'decide')
      ?.summary.startsWith('No reason to hold'),
  );
  const closed = world({ answer: bill(), preferences: { bookCloseDate: '2026-12-31' } });
  assert.deepEqual(await closed.run(), {
    outcome: 'failed',
    failureReason: "The document's date is in a period closed in QuickBooks. Nothing was created.",
  });
  assert.deepEqual(closed.platform.steps.at(-1)?.summary, 'Not recorded (period_closed)');
  const incomplete = world({
    answer: bill(),
    state: { vendor: undefined } as unknown as JsonObject,
  });
  assert.equal((await incomplete.run()).outcome, 'failed');
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

test('not in v1 yet: the manifest and the automation stop at verify-read, and decide is not a step the container runs', () => {
  const automation = define(manifests);
  assert.deepEqual(automation.steps.at(-1), 'verify-read');
  assert.ok(!automation.steps.includes('decide'));
  assert.deepEqual(
    manifests[0]?.pipeline.map((step) => step.id),
    [
      'receive',
      'read-company',
      'read-preferences',
      'find-accounts',
      'find-payer',
      'extract',
      'check-document',
      'verify-read',
    ],
  );
});
