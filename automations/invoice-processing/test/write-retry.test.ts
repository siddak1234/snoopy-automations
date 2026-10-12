import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_REFUSALS, type ScriptedAnswer } from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';

import { AFTER_APPROVAL_SENTENCES } from '../src/writes/sentences.js';
import { bill, receipt } from './check-world.js';
import { PAID } from './lookups-world.js';
import { approve, firstRun, noTimeToRepeat, outputOf, writesOf } from './writes-world.js';

/**
 * The writes' retry in real time (the owner's "Retry the creates", 2026-10-12): a create whose
 * answer was lost is repeated by the SDK's step retry under the step's one key — so the platform
 * sends the same `requestid` — and QuickBooks answers it with the first record (sandbox S6), never a
 * second. The SDK's 10-second floor is not a clock a suite can replace, so the first test waits it,
 * once, for every case at the same time; with no time left for that wait, the run ends with the
 * step's own "did not confirm" sentence, registered on what the write threw.
 */

const HELD = { ...PAID.company.config, holdAboveAmount: 0 };

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
    vendored.steps.find(([stepId]) => stepId === 'create-vendor'),
    [
      'create-vendor',
      'ok',
      "Added vendor 'Harrowgate Office Supply' to QuickBooks (Id 1001) (after 2 attempts)",
    ],
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
    expensed.steps.find(([stepId]) => stepId === 'create-record')?.[2] ?? '',
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

test('with no time left to repeat it, a create that got no answer ends "did not confirm" in create-record’s own sentence: one request', async () => {
  for (const [label, script] of TRANSIENT) {
    const first = await firstRun({ answer: bill(), config: HELD });
    first.simulator.script('bill.create', [script]);
    const approved = await approve(first, { deadline: noTimeToRepeat() });
    assert.deepEqual(
      approved.result,
      {
        outcome: 'failed',
        failureReason:
          'QuickBooks did not confirm whether the bill was created. Check QuickBooks before running this again.',
      },
      label,
    );
    assert.deepEqual(
      approved.steps.at(-1),
      ['create-record', 'failed', 'The create-record step failed'],
      label,
    );
    assert.equal(writesOf(approved.providerCalls).length, 1, `${label}: one request`);
    const made = label.startsWith('an answer lost') ? 1 : 0;
    assert.equal(first.simulator.company.bills.length, made, `${label}: what QuickBooks made`);
  }
});

test('with no time left to repeat it, a new vendor that got no answer ends "did not confirm" in create-vendor’s own sentence, the bill never sent', async () => {
  for (const [label, script] of TRANSIENT) {
    const first = await firstRun({ answer: bill(), bare: true });
    first.simulator.script('vendor.create', [script]);
    const approved = await approve(first, { deadline: noTimeToRepeat() });
    assert.deepEqual(
      approved.result,
      { outcome: 'failed', failureReason: AFTER_APPROVAL_SENTENCES.vendor_unconfirmed },
      label,
    );
    assert.deepEqual(
      approved.steps.at(-1),
      ['create-vendor', 'failed', 'The create-vendor step failed'],
      label,
    );
    assert.deepEqual(
      writesOf(approved.providerCalls).map(([operation]) => operation),
      ['vendor.create'],
      label,
    );
  }
});
