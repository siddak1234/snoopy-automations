import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { bill, receipt, sampleAnswer } from './check-world.js';
import {
  PAID,
  REF,
  lineOf,
  onlyChecking,
  routeRun,
  sampleBill,
  sampleJournalEntry,
  samplePurchase,
} from './lookups-world.js';
import { documentState } from './writes-world.js';

/**
 * The same purchase met as another kind of record, through the whole run on the simulator (the
 * plan's §2.9; D22, D32) — each of the five held, with what the approver reads (v2's §2.6 phrases).
 * v2 makes no journal entry and no reimbursement bill, but a company may hold v1's, or its own.
 */

const held = (result: RunResult) => {
  assert.equal(result.outcome, 'held', JSON.stringify(result).slice(0, 300));
  return (result as Extract<RunResult, { outcome: 'held' }>).held;
};

test('a bill created and paid, then its payment confirmation uploaded: held "already paid"', async () => {
  const world = await routeRun({
    answer: sampleAnswer('paid-invoice'),
    ...PAID.bank,
    // Checking the one account to pay from, as PAID.bank's company; and the bill, paid.
    company: (sim) => {
      onlyChecking(sim);
      sim.company.bills.push(
        sampleBill('170', REF.wrenfield, {
          DocNumber: 'LH-2609',
          TxnDate: '2026-09-02',
          TotalAmt: 480,
          Balance: 0,
        }),
      );
    },
  });
  const hold = held(world.result);
  assert.equal(hold.reason, 'Document 1: matches a paid bill.');
  assert.deepEqual(documentState(hold.state).holdReasons, ['matches_bill']);
  assert.equal(
    world.platform.steps.find((step) => step.stepId === 'ask-approval')?.heldReason,
    'Document 1: matches a paid bill.',
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
  assert.equal(hold.reason, 'Document 1: matches an open bill.');
  assert.equal(lineOf(world, 'find-related')?.split('; ')[0], 'Possible duplicate');
  assert.equal(lineOf(world, 'decide'), 'Waiting for approval');
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
  assert.deepEqual(documentState(hold.state).holdReasons, ['possible_duplicate']);
  assert.equal(hold.reason, 'Document 1: may already be in QuickBooks.');
  assert.deepEqual((documentState(hold.state).duplicates as JsonObject).expenseIds, ['205']);
});

test("an employee's reimbursement recorded (v1's journal entry), then the same receipt uploaded as the company's: held (D32)", async () => {
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
  assert.deepEqual(documentState(hold.state).holdReasons, ['possible_duplicate']);
  assert.deepEqual((documentState(hold.state).duplicates as JsonObject).journalEntryIds, ['402']);
  assert.equal(hold.reason, 'Document 1: may already be in QuickBooks.');
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
  assert.deepEqual(documentState(hold.state).holdReasons, ['possible_duplicate']);
  assert.equal(hold.reason, 'Document 1: may already be in QuickBooks.');
});
