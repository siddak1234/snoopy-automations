import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { bill, receipt, sampleAnswer } from './check-world.js';
import {
  PAID,
  REF,
  lineOf,
  routeRun,
  sampleBill,
  sampleJournalEntry,
  samplePurchase,
} from './lookups-world.js';

/**
 * The same purchase met as another kind of record, through the whole run on the simulator (the
 * plan's §2.9; D22, D32) — each of the five held, with what the approver reads.
 */

const held = (result: RunResult) => {
  assert.equal(result.outcome, 'held', JSON.stringify(result).slice(0, 300));
  return (result as Extract<RunResult, { outcome: 'held' }>).held;
};

test('a bill created and paid, then its payment confirmation uploaded: held "already paid"', async () => {
  const world = await routeRun({
    answer: sampleAnswer('paid-invoice'),
    ...PAID.bank,
    company: (sim) =>
      sim.company.bills.push(
        sampleBill('170', REF.wrenfield, {
          DocNumber: 'LH-2609',
          TxnDate: '2026-09-02',
          TotalAmt: 480,
          Balance: 0,
        }),
      ),
  });
  const hold = held(world.result);
  assert.equal(
    hold.reason,
    'Matches bill LH-2609, already paid: Wrenfield & Pike Bookkeeping, $480.00 from Checking',
  );
  assert.equal(
    world.platform.steps.find((step) => step.stepId === 'decide')?.heldReason,
    'Approve only if this is a different purchase. Bill LH-2609 for this amount is already recorded and paid.',
  );
});

test('an open bill, then a receipt for it: held, the hold 6 wording', async () => {
  const world = await routeRun({
    answer: receipt(),
    company: (sim) =>
      sim.company.bills.push(
        sampleBill('171', REF.tidewell, {
          DocNumber: 'TH-88',
          TxnDate: '2026-09-20',
          TotalAmt: 60.63,
        }),
      ),
  });
  const hold = held(world.result);
  assert.equal(hold.reason, 'Matches open bill TH-88: Tidewell Hardware, $60.63 from Company Visa');
  assert.equal(
    world.platform.steps.find((step) => step.stepId === 'decide')?.heldReason,
    'Approve only if this is a different purchase. If it pays bill TH-88, reject it and record the payment in Pay bills.',
  );
  assert.equal(
    lineOf(world, 'find-related'),
    'Bills for $60.63, newest first: Id 171 (this vendor, 2026-09-20, $60.63, open)',
  );
});

test("a receipt recorded, then the supplier's invoice uploaded: held as a possible duplicate (D32)", async () => {
  const world = await routeRun({
    answer: bill(),
    company: (sim) =>
      sim.company.purchases.push(
        samplePurchase('205', REF.visa, { TxnDate: '2026-09-20', TotalAmt: 413.34 }),
      ),
  });
  const hold = held(world.result);
  assert.deepEqual((hold.state as JsonObject).holdReasons, ['possible_duplicate']);
  assert.match(lineOf(world, 'decide') ?? '', /possible duplicate: an expense for this amount/u);
  assert.deepEqual(((hold.state as JsonObject).duplicates as JsonObject).expenseIds, ['205']);
});

test("an employee's reimbursement recorded, then the same receipt uploaded as the company's: held (D32)", async () => {
  const world = await routeRun({
    answer: receipt(),
    company: (sim) =>
      sim.company.journalEntries.push(
        sampleJournalEntry(
          '402',
          60.63,
          { debit: REF.electric, credit: REF.teamOwed },
          { TxnDate: '2026-09-27' },
          { Type: 'Employee', EntityRef: { value: '55', name: 'Robin Example' } },
        ),
      ),
  });
  const hold = held(world.result);
  assert.deepEqual((hold.state as JsonObject).holdReasons, ['possible_duplicate']);
  assert.match(
    lineOf(world, 'decide') ?? '',
    /possible duplicate: a reimbursement for this amount/u,
  );
});

test("a contractor's reimbursement bill, then the same receipt: held", async () => {
  const world = await routeRun({
    answer: receipt(),
    company: (sim) =>
      sim.company.bills.push(
        sampleBill('172', REF.samLee, { TxnDate: '2026-09-28', TotalAmt: 60.63 }),
      ),
  });
  const hold = held(world.result);
  assert.deepEqual((hold.state as JsonObject).holdReasons, ['possible_duplicate']);
  assert.match(
    lineOf(world, 'decide') ?? '',
    /possible duplicate: another vendor's bill for this amount/u,
  );
});
