import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_REFUSALS, type ScriptedAnswer } from '@autom8x/automation-kit/testing';

import { callsOf, lines, setUp } from './fixtures.js';

/**
 * The connection and busy cases, the same at each of the three QuickBooks steps before the
 * document is read: each keeps the document out of QuickBooks — "Not recorded in QuickBooks:
 * QuickBooks isn't connected", or "… didn't answer" (the session's decision 6) — no later QuickBooks
 * step runs, the document is still read, and every call the step made is its one request under its
 * one key.
 */

const STEPS: { stepId: string; operation: string }[] = [
  { stepId: 'read-company', operation: 'companyInfo.get' },
  { stepId: 'read-preferences', operation: 'preferences.get' },
  { stepId: 'find-accounts', operation: 'query.run' },
];

const NOT_CONNECTED = "QuickBooks isn't connected";
const NO_ANSWER = "QuickBooks didn't answer";
const QUICKBOOKS_STEPS = ['read-company', 'read-preferences', 'find-accounts'];

const CASES: {
  name: string;
  script: (operation: string) => ScriptedAnswer[];
  reason: string;
  calls: number;
  waits?: number[];
}[] = [
  {
    name: 'no live connection',
    script: () => [{ refuse: PROVIDER_REFUSALS.notConnected() }],
    reason: NOT_CONNECTED,
    calls: 1,
  },
  { name: 'QuickBooks 401', script: () => [{ status: 401 }], reason: NOT_CONNECTED, calls: 1 },
  { name: 'QuickBooks 403', script: () => [{ status: 403 }], reason: NOT_CONNECTED, calls: 1 },
  {
    name: 'the accounting scope missing',
    script: (operation) => [
      { refuse: PROVIDER_REFUSALS.badRequest(operation, 'insufficient_scope') },
    ],
    reason: NOT_CONNECTED,
    calls: 1,
  },
  {
    name: 'Connections not configured',
    script: (operation) => [{ refuse: PROVIDER_REFUSALS.notConfigured(operation) }],
    reason: NO_ANSWER,
    calls: 1,
  },
  {
    name: 'the provider undeclared',
    script: () => [{ refuse: PROVIDER_REFUSALS.providerNotDeclared() }],
    reason: NO_ANSWER,
    calls: 1,
  },
  {
    name: '429 three times',
    script: () => [{ status: 429 }, { status: 429 }, { status: 429 }],
    reason: NO_ANSWER,
    calls: 3,
    waits: [60_000, 60_000],
  },
  {
    name: '500 twice',
    script: () => [{ status: 500 }, { status: 500 }],
    reason: NO_ANSWER,
    calls: 2,
  },
  { name: 'a 425', script: () => [{ status: 425 }], reason: NO_ANSWER, calls: 1 },
];

for (const { stepId, operation } of STEPS) {
  test(`${stepId}: every connection and busy case keeps the document out of QuickBooks, and the run goes on`, async () => {
    for (const { name, script, reason, calls, waits } of CASES) {
      const world = setUp();
      world.simulator.script(operation, script(operation));
      const result = await world.run();
      assert.ok(result.outcome === 'success', `${stepId}: ${name}`);
      assert.deepEqual(result.output?.quickBooks, { notRecorded: reason }, `${stepId}: ${name}`);
      const reported = lines(world.platform);
      assert.deepEqual(
        reported.find(([id]) => id === stepId),
        [stepId, 'failed', `Not recorded in QuickBooks: ${reason}`],
        name,
      );
      const after = QUICKBOOKS_STEPS.slice(QUICKBOOKS_STEPS.indexOf(stepId) + 1);
      assert.ok(
        !reported.some(([id]) => after.includes(id)),
        `${name}: no QuickBooks step after it`,
      );
      assert.equal(world.platform.modelCalls.length, 1, `${name}: the document is still read`);
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
    const result = await world.run();
    assert.ok(result.outcome === 'success');
    assert.equal(result.output?.quickBooks, undefined);
    assert.deepEqual(world.waits, [60_000, 60_000]);
    assert.equal(callsOf(world.platform, world.request, stepId).length, 3);
  });

  test(`${stepId}: a 429 with less than six minutes left does not wait: QuickBooks did not answer`, async () => {
    const world = setUp({ deadlineInMs: 5 * 60_000 });
    world.simulator.script(operation, [{ status: 429 }, { status: 200 }]);
    const result = await world.run();
    assert.ok(result.outcome === 'success');
    assert.deepEqual(result.output?.quickBooks, { notRecorded: NO_ANSWER });
    assert.deepEqual(world.waits, []);
    assert.equal(callsOf(world.platform, world.request, stepId).length, 1);
  });
}
