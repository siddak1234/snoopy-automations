import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROVIDER_REFUSALS,
  faultAnswer,
  type ScriptedAnswer,
} from '@autom8x/automation-kit/testing';
import type { JsonObject, RunResult } from '@autom8x/automation-sdk';
import type { ProblemInput } from '@autom8x/automation-sdk/testing';

import { UNCONFIRMED_LINE } from '../src/quickbooks-path.js';
import { RESULTS } from '../src/words.js';
import { bill, receipt } from './check-world.js';
import { PAID } from './lookups-world.js';
import { approve, firstRun, noTimeToRepeat, outputOf, writesOf } from './writes-world.js';

/**
 * The writes' retry in real time (the owner's "Retry the creates", 2026-10-12): a create whose
 * answer was lost is repeated by the SDK's step retry under the step's one key — so the platform
 * sends the same `requestid` — and QuickBooks answers it with the first record (sandbox S6), never a
 * second. The SDK's 10-second floor is not a clock a suite can replace, so each test that repeats
 * a create waits it, once, for every case at the same time; with no time left for that wait, the
 * run's `recover` ends the step "QuickBooks didn't confirm", the details saved (decision 6). A repeat
 * the platform refuses after a lost answer says "didn't confirm" too, never "not recorded": the lost
 * attempt may have made the record (Gate 25's AUT-38-1).
 */

const HELD = { ...PAID.company.config, holdAboveAmount: 0 };
const summaryOf = (result: RunResult) =>
  result.outcome === 'success' ? result.summary : JSON.stringify(result);

test('a create whose answer was lost is repeated 10 s later under the same key, and QuickBooks answers the first record: one vendor, one bill, one expense', async () => {
  // A new vendor's bill: create-vendor's answer lost before Connections recorded it.
  const vendorRun = await firstRun({ answer: bill(), bare: true });
  vendorRun.simulator.script('vendor.create', [{ lost: 'before_record' }]);
  // A company receipt's expense: create-record's answer lost after Connections recorded it.
  const expenseRun = await firstRun({ answer: receipt(), config: HELD });
  expenseRun.simulator.script('purchase.create', [{ lost: 'after_record' }]);
  // A bill whose create reached nothing at all: a 502 naming no reason, then made on the repeat.
  const billRun = await firstRun({ answer: bill(), config: HELD });
  billRun.simulator.script('bill.create', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]);
  const purchasesBefore = expenseRun.simulator.company.purchases.length;

  const started = Date.now();
  const [vendored, expensed, billed] = await Promise.all([
    approve(vendorRun),
    approve(expenseRun),
    approve(billRun),
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 10_000 && elapsed < 15_000, `one 10-second wait, not more: ${elapsed} ms`);

  // The vendor: two requests, the same bytes; QuickBooks made one vendor, and answered it twice.
  const vendorCalls = vendored.providerCalls.filter((call) => call.operation === 'vendor.create');
  assert.equal(vendorCalls.length, 2);
  assert.deepEqual(vendorCalls[1], vendorCalls[0], 'the same request under the same key');
  assert.deepEqual(
    vendorRun.simulator.calls
      .filter((call) => call.operation === 'vendor.create')
      .map((call) => call.outcome),
    ['lost', 'answered'],
  );
  assert.equal(vendorRun.simulator.company.vendors.length, 1);
  assert.deepEqual(
    vendored.steps.find(([stepId]) => stepId === 'create-approved-vendors'),
    ['create-approved-vendors', 'ok', 'Vendor added (after 2 attempts)'],
  );
  assert.deepEqual(outputOf(vendored.result).newVendor, {
    how: 'created',
    id: '1001',
    displayName: 'Harrowgate Office Supply',
  });
  assert.deepEqual(
    writesOf(vendored.providerCalls).map(([operation]) => operation),
    ['vendor.create', 'vendor.create', 'bill.create'],
  );

  // The expense: the repeat answered from Connections' record, one expense.
  const expenseCalls = writesOf(expensed.providerCalls);
  assert.deepEqual(
    expenseCalls.map(([operation]) => operation),
    ['purchase.create', 'purchase.create'],
  );
  assert.deepEqual(expenseCalls[1], expenseCalls[0]);
  assert.equal(expenseRun.simulator.calls.at(-1)?.outcome, 'replayed');
  assert.equal(expenseRun.simulator.company.purchases.length, purchasesBefore + 1);
  assert.match(
    expensed.steps.find(([stepId]) => stepId === 'create-approved-records')?.[2] ?? '',
    / \(after 2 attempts\)$/u,
  );
  assert.equal((outputOf(expensed.result).record as JsonObject).id, '1001');

  // The bill: nothing reached QuickBooks the first time; the repeat made it.
  assert.equal(writesOf(billed.providerCalls).length, 2);
  assert.equal(billRun.simulator.company.bills.length, 1);
  assert.equal(billed.result.outcome, 'success');
});

/** The failures the SDK repeats: no answer — lost before or after Connections recorded it — or a reasonless 502. */
const TRANSIENT: readonly [string, ScriptedAnswer][] = [
  ['an answer lost after QuickBooks made it', { lost: 'before_record' }],
  ['an answer lost after the platform recorded it', { lost: 'after_record' }],
  ['a reasonless 502 before QuickBooks', { refuse: PROVIDER_REFUSALS.noAnswer() }],
];

test("with no time left to repeat it, a create that got no answer: QuickBooks didn't confirm it — the details saved, one request", async () => {
  for (const [label, script] of TRANSIENT) {
    const first = await firstRun({ answer: bill(), config: HELD });
    first.simulator.script('bill.create', [script]);
    const approved = await approve(first, { deadline: noTimeToRepeat() });
    assert.equal(summaryOf(approved.result), RESULTS.unconfirmed, label);
    assert.deepEqual(
      approved.steps.find(([stepId]) => stepId === 'create-approved-records'),
      ['create-approved-records', 'failed', UNCONFIRMED_LINE],
      label,
    );
    assert.equal(writesOf(approved.providerCalls).length, 1, `${label}: one request`);
    const made = label.startsWith('an answer lost') ? 1 : 0;
    assert.equal(first.simulator.company.bills.length, made, `${label}: what QuickBooks made`);
  }
});

test("with no time left to repeat it, a new vendor that got no answer: QuickBooks didn't confirm it, the bill never sent", async () => {
  for (const [label, script] of TRANSIENT) {
    const first = await firstRun({ answer: bill(), bare: true });
    first.simulator.script('vendor.create', [script]);
    const approved = await approve(first, { deadline: noTimeToRepeat() });
    assert.equal(summaryOf(approved.result), RESULTS.unconfirmed, label);
    assert.deepEqual(
      approved.steps.find(([stepId]) => stepId === 'create-approved-vendors'),
      ['create-approved-vendors', 'failed', UNCONFIRMED_LINE],
      label,
    );
    assert.deepEqual(
      writesOf(approved.providerCalls).map(([operation]) => operation),
      ['vendor.create'],
      label,
    );
  }
});

/**
 * The platform refusing a create — certain on its first answer, nothing having reached QuickBooks —
 * with the reason it is not recorded for, and the word a repeat's "didn't confirm" names in the log:
 * no live connection (the connection retired while the run waited), the Edge's flood valve with no
 * time left to wait it out, a 400, and a 403 at the deadline.
 */
const REFUSED: readonly [string, (operation: string) => ProblemInput, string, string][] = [
  [
    'no live connection (404)',
    () => PROVIDER_REFUSALS.notConnected(),
    "QuickBooks isn't connected",
    'qb_not_connected',
  ],
  [
    "the Edge's flood valve (429)",
    () => ({ status: 429, code: 'TOO_MANY_REQUESTS', detail: 'Too many requests' }),
    "QuickBooks didn't answer",
    'platform_busy',
  ],
  [
    'a 400',
    (operation) => PROVIDER_REFUSALS.badRequest(operation, 'refused_field'),
    "QuickBooks didn't answer",
    'refused_field',
  ],
  [
    'a 403 at the deadline',
    () => ({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'x',
      details: { reason: 'deadline_exceeded' },
    }),
    "QuickBooks didn't answer",
    'deadline_exceeded',
  ],
];

/**
 * A repeat's answer, each certain had it come first: the platform's refusals above, and QuickBooks
 * refusing the record itself (Fault 6210, a closed period), each with the word the repeat's "did
 * not confirm" names.
 */
const REPEATED: readonly [string, (operation: string) => ScriptedAnswer, string][] = [
  ...REFUSED.map(
    ([name, problem, , word]): [string, (operation: string) => ScriptedAnswer, string] => [
      name,
      (operation) => ({ refuse: problem(operation) }),
      word,
    ],
  ),
  [
    'QuickBooks refusing it (Fault 6210)',
    () => ({ status: 400, body: faultAnswer('6210') }),
    '6210',
  ],
];

/** Each write a step repeats: its operation, and a first run that reaches it. */
const WRITES = [
  {
    stepId: 'create-approved-records',
    operation: 'bill.create',
    run: () => firstRun({ answer: bill(), config: HELD }),
  },
  {
    stepId: 'create-approved-vendors',
    operation: 'vendor.create',
    run: () => firstRun({ answer: bill(), bare: true }),
  },
] as const;

test('a create whose answer was lost, its repeat refused — 404, 429, 400, 403, a Fault — is "didn\'t confirm", never "not recorded": QuickBooks made it', async () => {
  // Every case at once: one 10-second wait.
  const cases = await Promise.all(
    REPEATED.flatMap(([name, answer, word]) =>
      WRITES.map(async (write) => {
        const first = await write.run();
        // QuickBooks makes it and the answer is lost; the repeat is refused.
        first.simulator.script(write.operation, [
          { lost: 'before_record' },
          answer(write.operation),
        ]);
        return { name, write, first, approved: await approve(first), word };
      }),
    ),
  );
  for (const { name, write, first, approved } of cases) {
    const label = `${write.stepId}, ${name}`;
    assert.equal(summaryOf(approved.result), RESULTS.unconfirmed, label);
    assert.deepEqual(
      approved.steps.find(([stepId]) => stepId === write.stepId),
      [write.stepId, 'failed', `${UNCONFIRMED_LINE} (after 2 attempts)`],
      label,
    );
    const writes = writesOf(approved.providerCalls);
    assert.deepEqual(
      writes.map(([operation]) => operation),
      [write.operation, write.operation],
      `${label}: the bill is never sent after a vendor not confirmed`,
    );
    assert.deepEqual(writes[1], writes[0], `${label}: the same request under the same key`);
    const made =
      write.stepId === 'create-approved-records'
        ? first.simulator.company.bills
        : first.simulator.company.vendors;
    assert.equal(made.length, 1, `${label}: what the lost attempt made`);
  }
});

test('a create refused on its first answer is still certain: nothing reached QuickBooks, one request, not recorded', async () => {
  for (const [name, problem, reason] of REFUSED) {
    for (const write of WRITES) {
      const first = await write.run();
      first.simulator.script(write.operation, [{ refuse: problem(write.operation) }]);
      const approved = await approve(first);
      const label = `${write.stepId}, ${name}`;
      assert.equal(summaryOf(approved.result), RESULTS.notRecorded(reason), label);
      assert.equal(writesOf(approved.providerCalls).length, 1, `${label}: one request`);
      assert.doesNotMatch(
        approved.steps.find(([stepId]) => stepId === write.stepId)?.[2] ?? '',
        /attempts/u,
        label,
      );
    }
  }
});
