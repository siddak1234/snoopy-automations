import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { bill, creditNote, sampleAnswer } from './check-world.js';
import {
  TIDEWELL,
  approve,
  documentsOf,
  documentsRun,
  statuses,
  type Run,
} from './documents-world.js';
import { QUICKBOOKS, documentAnswer } from './fixtures.js';
import { REF, sampleBill } from './lookups-world.js';

/**
 * Two documents in one file with the same seller, date and total (the session's spec, B1): the
 * later one waits, "same as document 1" — and after the one approval, only a real copy is kept
 * out of QuickBooks, by the ONE duplicate rule (Gate 25's R5d; PR #47's review): two copies of one
 * bill or receipt make one record; two bills with their own numbers, a bill and its credit note,
 * or a receipt and its refund make two.
 */

/** The held run's reason. */
const reasonOf = (result: RunResult) =>
  (result as Extract<RunResult, { outcome: 'held' }>).held.reason;

/** The continuation's QuickBooks writes, by operation. */
const writesIn = (approved: Awaited<ReturnType<typeof approve>>) =>
  approved.providerCalls
    .map((call) => call.operation)
    .filter((operation) => operation.endsWith('.create'));

/** The step's line in the continuation. */
const lineIn = (approved: Awaited<ReturnType<typeof approve>>, stepId: string) =>
  approved.steps.find(([id]) => id === stepId)?.[2];

/** Two copies of one purchase, both waiting: after the one approval, ONE record (Gate 25's R5d). */
async function bothWaitThenOne(first: Run) {
  assert.deepEqual(statuses(first.result), ['waiting', 'waiting']);
  const approved = await approve(first);
  assert.equal(approved.result.outcome, 'success', JSON.stringify(approved.result).slice(0, 400));
  assert.deepEqual(statuses(approved.result), ['recorded', 'not_recorded']);
  assert.equal(
    documentsOf(approved.result)[1]?.statusText,
    'Saved. Not recorded in QuickBooks: same as document 1',
  );
  assert.equal(
    lineIn(approved, 'create-approved-records'),
    '1 recorded in QuickBooks, 1 not recorded',
  );
  return approved;
}

test('the same bill twice in one file from a new vendor: one approval, then one vendor and ONE bill, the copy "same as document 1" (Gate 25\'s R5d)', async () => {
  const twice = documentAnswer(bill(), { numberLabel: 'Invoice #' });
  const first = await documentsRun({ documents: [twice, { ...twice }], bare: true });
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  assert.match(
    reasonOf(first.result),
    /^Document 1: new vendor.*Document 2: new vendor.*same as document 1\.$/u,
  );
  const approved = await bothWaitThenOne(first);
  assert.deepEqual(writesIn(approved), ['vendor.create', 'bill.create']);
  assert.equal(first.simulator.company.bills.length, 1, 'one bill in QuickBooks');
  assert.equal(first.simulator.company.vendors.length, 1, 'one vendor');
});

test('two copies of one receipt over the limit: one approval, then ONE expense, the copy "same as document 1" (Gate 25\'s R5d)', async () => {
  const first = await documentsRun({
    documents: [TIDEWELL, { ...TIDEWELL }],
    config: { ...QUICKBOOKS, holdAboveAmount: 50 },
  });
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  assert.equal(
    reasonOf(first.result),
    'Document 1: over the $50 limit. Document 2: over the $50 limit, same as document 1.',
  );
  const before = first.simulator.company.purchases.length;
  const approved = await bothWaitThenOne(first);
  assert.deepEqual(writesIn(approved), ['purchase.create']);
  assert.equal(first.simulator.company.purchases.length, before + 1, 'one expense in QuickBooks');
});

test('a receipt recorded in the first run and its copy waiting: after approval the copy is kept out as already in QuickBooks, and nothing is written', async () => {
  const first = await documentsRun({ documents: [TIDEWELL, { ...TIDEWELL }] });
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  assert.deepEqual(statuses(first.result), ['recorded', 'waiting']);
  assert.equal(reasonOf(first.result), 'Document 2: same as document 1.');
  const approved = await approve(first);
  assert.deepEqual(statuses(approved.result), ['recorded', 'not_recorded']);
  assert.equal(
    documentsOf(approved.result)[1]?.statusText,
    'Saved. Not recorded in QuickBooks: may already be in QuickBooks',
  );
  assert.equal(
    lineIn(approved, 'confirm-no-duplicates'),
    'Not recorded in QuickBooks: may already be in QuickBooks',
  );
  assert.deepEqual(writesIn(approved), []);
});

/** Bill HOS-1042 from Harrowgate, and HOS-2077 of the same date and total: two bills, no copy. */
const HOS_1042 = documentAnswer(bill(), { numberLabel: 'Invoice #' });
const HOS_2077 = documentAnswer(bill({ documentNumber: 'HOS-2077' }), { numberLabel: 'Invoice #' });

/** The bills QuickBooks holds, by number. */
const billNumbers = (run: Run) => run.simulator.company.bills.map((row) => row.DocNumber);

test('two bills from one seller with the same date and total but their own numbers are both recorded, both waiting or the first recorded first (PR #47 review)', async () => {
  // A new vendor: both wait.
  const waiting = await documentsRun({ documents: [HOS_1042, HOS_2077], bare: true });
  assert.match(reasonOf(waiting.result), /Document 2: new vendor.*same as document 1\.$/u);
  const both = await approve(waiting);
  assert.deepEqual(statuses(both.result), ['recorded', 'recorded']);
  assert.deepEqual(writesIn(both), ['vendor.create', 'bill.create', 'bill.create']);
  assert.deepEqual(billNumbers(waiting), ['HOS-1042', 'HOS-2077']);
  // A known vendor: the first recorded in the first run, the second waiting.
  const first = await documentsRun({ documents: [HOS_1042, HOS_2077] });
  assert.deepEqual(statuses(first.result), ['recorded', 'waiting']);
  assert.equal(reasonOf(first.result), 'Document 2: same as document 1.');
  const after = await approve(first);
  assert.deepEqual(statuses(after.result), ['recorded', 'recorded']);
  assert.deepEqual(writesIn(after), ['bill.create']);
  assert.deepEqual(billNumbers(first), ['HOS-1042', 'HOS-2077']);
});

test('a bill and its full credit note from one seller on the same day are both recorded (PR #47 review)', async () => {
  const credit = documentAnswer(
    creditNote({
      documentDate: '2026-09-14',
      subtotal: -413.34,
      tax: null,
      discount: null,
      total: -413.34,
      originalInvoiceNumber: 'HOS-0999',
      lineItems: [{ amount: -413.34 }],
    }),
    { numberLabel: 'Credit memo #' },
  );
  const first = await documentsRun({
    documents: [HOS_1042, credit],
    company: (sim) =>
      sim.company.bills.push(
        sampleBill('140', REF.harrowgate, { DocNumber: 'HOS-0999', TxnDate: '2026-08-14' }),
      ),
  });
  assert.deepEqual(statuses(first.result), ['recorded', 'waiting']);
  assert.match(reasonOf(first.result), /same as document 1\.$/u);
  const after = await approve(first);
  assert.deepEqual(statuses(after.result), ['recorded', 'recorded']);
  assert.deepEqual(writesIn(after), ['vendorCredit.create']);
  assert.equal(documentsOf(after.result)[1]?.recordedIn?.recordType, 'vendor credit');
});

test('a receipt and its refund to the card on the same day are both recorded (PR #47 review)', async () => {
  const refund = documentAnswer(
    sampleAnswer('card-refund', {
      documentDate: '2026-09-27',
      subtotal: -57.47,
      tax: -3.16,
      total: -60.63,
      originalInvoiceNumber: '55120',
      lineItems: [{ amount: -34.99 }, { amount: -9.49 }, { amount: -12.99 }],
    }),
  );
  const first = await documentsRun({ documents: [TIDEWELL, refund], config: QUICKBOOKS });
  assert.deepEqual(statuses(first.result), ['recorded', 'waiting']);
  assert.equal(reasonOf(first.result), 'Document 2: same as document 1.');
  const before = first.simulator.company.purchases.length;
  const after = await approve(first);
  assert.deepEqual(statuses(after.result), ['recorded', 'recorded']);
  assert.deepEqual(writesIn(after), ['purchase.create']);
  const [expense, cardRefund] = first.simulator.company.purchases.slice(before - 1);
  assert.deepEqual(
    [expense?.Credit ?? false, (cardRefund as JsonObject | undefined)?.Credit],
    [false, true],
  );
});
