import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_REFUSALS, type ScriptedAnswer } from '@autom8x/automation-kit/testing';

import { callsOf, lines, setUp } from './fixtures.js';

/**
 * The connection and busy cases, the same at each of the three QuickBooks steps: each
 * ends with the kit's sentence, nothing after the step runs, no model call is made, and
 * every call the step made is its one request under its one key.
 */

const STEPS = [
  { stepId: 'read-company', operation: 'companyInfo.get', what: 'QuickBooks company not checked' },
  {
    stepId: 'read-preferences',
    operation: 'preferences.get',
    what: 'QuickBooks settings not read',
  },
  {
    stepId: 'find-account',
    operation: 'query.run',
    what: 'Expense account "Utilities:Electric" not resolved',
  },
] as const;

const RECONNECT = 'Reconnect QuickBooks in Connections, then run it again.';
const BUSY = 'QuickBooks is busy; run it again in a few minutes.';

const CASES: {
  name: string;
  script: (operation: string) => ScriptedAnswer[];
  sentence: string;
  reason: string;
  calls: number;
  waits?: number[];
}[] = [
  {
    name: 'no live connection',
    script: () => [{ refuse: PROVIDER_REFUSALS.notConnected() }],
    sentence: RECONNECT,
    reason: 'qb_not_connected',
    calls: 1,
  },
  {
    name: 'QuickBooks 401',
    script: () => [{ status: 401 }],
    sentence: RECONNECT,
    reason: 'qb_reauthorize',
    calls: 1,
  },
  {
    name: 'QuickBooks 403',
    script: () => [{ status: 403 }],
    sentence:
      'QuickBooks refused access to this company. Reconnect QuickBooks in Connections as a company admin, then run it again.',
    reason: 'qb_forbidden',
    calls: 1,
  },
  {
    name: 'the accounting scope missing',
    script: (operation) => [
      { refuse: PROVIDER_REFUSALS.badRequest(operation, 'insufficient_scope') },
    ],
    sentence:
      'QuickBooks was connected without accounting access. Reconnect QuickBooks in Connections, then run it again.',
    reason: 'qb_missing_scope',
    calls: 1,
  },
  {
    name: 'Connections not configured',
    script: (operation) => [{ refuse: PROVIDER_REFUSALS.notConfigured(operation) }],
    sentence:
      'QuickBooks calls are not available on Autom8x right now. Nothing was created; run it again later.',
    reason: 'qb_not_configured',
    calls: 1,
  },
  {
    name: 'the provider undeclared',
    script: () => [{ refuse: PROVIDER_REFUSALS.providerNotDeclared() }],
    sentence: 'Autom8x could not ask QuickBooks (provider_not_declared). Nothing was created.',
    reason: 'platform_refused provider_not_declared',
    calls: 1,
  },
  {
    name: '429 three times',
    script: () => [{ status: 429 }, { status: 429 }, { status: 429 }],
    sentence: BUSY,
    reason: 'qb_busy 429',
    calls: 3,
    waits: [60_000, 60_000],
  },
  {
    name: '500 twice',
    script: () => [{ status: 500 }, { status: 500 }],
    sentence: BUSY,
    reason: 'qb_busy 500',
    calls: 2,
  },
  {
    name: 'a 425',
    script: () => [{ status: 425 }],
    sentence: BUSY,
    reason: 'qb_busy 425',
    calls: 1,
  },
];

for (const { stepId, operation, what } of STEPS) {
  test(`${stepId}: every connection and busy case ends with its sentence`, async () => {
    for (const { name, script, sentence, reason, calls, waits } of CASES) {
      const world = setUp();
      world.simulator.script(operation, script(operation));
      const result = await world.run();
      assert.deepEqual(
        result,
        { outcome: 'failed', failureReason: sentence },
        `${stepId}: ${name}`,
      );
      const reported = lines(world.platform);
      assert.deepEqual(reported.at(-1), [stepId, 'failed', `${what} (${reason})`], name);
      assert.equal(reported.at(-1)?.[0], stepId, 'nothing after the step runs');
      assert.deepEqual(world.platform.modelCalls, [], 'none of the allowance is spent');
      const sent = callsOf(world.platform, world.request, stepId);
      assert.equal(sent.length, calls, name);
      assert.equal(new Set(sent.map((call) => JSON.stringify(call))).size, 1, 'one request');
      assert.ok(sent.every((call) => call.operation === operation));
      assert.deepEqual(world.waits, waits ?? [], name);
    }
  });

  test(`${stepId}: 429, 429, then an answer continues after two minute-long waits`, async () => {
    const world = setUp();
    world.simulator.script(operation, [{ status: 429 }, { status: 429 }, { status: 200 }]);
    assert.equal((await world.run()).outcome, 'success');
    assert.deepEqual(world.waits, [60_000, 60_000]);
    assert.equal(callsOf(world.platform, world.request, stepId).length, 3);
  });

  test(`${stepId}: a 429 with less than six minutes left fails at once`, async () => {
    const world = setUp({ deadlineInMs: 5 * 60_000 });
    world.simulator.script(operation, [{ status: 429 }, { status: 200 }]);
    assert.deepEqual(await world.run(), { outcome: 'failed', failureReason: BUSY });
    assert.deepEqual(world.waits, []);
    assert.equal(callsOf(world.platform, world.request, stepId).length, 1);
  });
}
