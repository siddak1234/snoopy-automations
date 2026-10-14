import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { RESULTS } from '../src/words.js';
import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import { lines } from './fixtures.js';
import {
  REF,
  lineOf,
  queriesOf,
  routeRun,
  sampleBill,
  samplePurchase,
  type RouteRun,
} from './lookups-world.js';

/**
 * The record lookups per document type (the plan's §5): which run, which search nothing when no
 * number QuickBooks could hold was read (G4-4), which are skipped; an answer at its bound (D6); and
 * a statement's missing numbers. What each keeps is `lookup-records.test.ts`'s. Lines (§3.E): `No
 * duplicate`, `Possible duplicate`; a statement's, what was checked.
 */

const RECORD_STEPS = [
  'find-duplicate-number',
  'find-duplicate-amount',
  'find-related',
  'find-other-record',
] as const;

/** Each record step's use in a run: 'run' (a query), its "Not checked" line, or 'skip'. */
async function usesOf(run: RouteRun): Promise<Record<string, string>> {
  const world = await routeRun({ through: 'find-other-record', ...run });
  const sent = queriesOf(world);
  return Object.fromEntries(
    RECORD_STEPS.map((stepId) => [
      stepId,
      sent[stepId] !== undefined ? 'run' : (lineOf(world, stepId) ?? 'skip'),
    ]),
  );
}

/** A lookup with no number QuickBooks could hold searches nothing, so finds nothing. */
const NO_NUMBER = 'No duplicate';
const LONG_NUMBER = 'No duplicate';
const summaryOf = (result: RunResult) =>
  result.outcome === 'success' ? result.summary : JSON.stringify(result);
const uses = (number: string, amount: string, related: string, other: string) => ({
  'find-duplicate-number': number,
  'find-duplicate-amount': amount,
  'find-related': related,
  'find-other-record': other,
});

test('a bill: all four; no number, or one past 21 characters: the number lookups say "Not checked"', async () => {
  assert.deepEqual(await usesOf({ answer: bill() }), uses('run', 'run', 'run', 'run'));
  assert.deepEqual(
    await usesOf({ answer: bill({ documentNumber: null }) }),
    uses(NO_NUMBER, 'run', NO_NUMBER, 'run'),
  );
  assert.deepEqual(
    await usesOf({ answer: bill({ documentNumber: 'N'.repeat(22) }) }),
    uses(LONG_NUMBER, 'run', LONG_NUMBER, 'run'),
  );
  // A new vendor's too: any vendor's bills.
  assert.deepEqual(await usesOf({ answer: bill(), bare: true }), uses('run', 'run', 'run', 'run'));
});

test('a company receipt: the number lookup only for a seller that is a vendor; the others always', async () => {
  assert.deepEqual(await usesOf({ answer: receipt() }), uses('run', 'run', 'run', 'run'));
  assert.deepEqual(
    await usesOf({ answer: receipt(), bare: true }),
    uses('skip', 'run', 'run', 'run'),
  );
  assert.deepEqual(
    await usesOf({ answer: receipt({ documentNumber: null }) }),
    uses(NO_NUMBER, 'run', 'run', 'run'),
  );
});

test('a card refund: its number and the card feed; the original bill only from a linked vendor; no other-record lookup', async () => {
  const refund = sampleAnswer('card-refund');
  assert.deepEqual(await usesOf({ answer: refund }), uses('run', 'run', 'run', 'skip'));
  assert.deepEqual(
    await usesOf({ answer: refund, bare: true }),
    uses('run', 'run', 'skip', 'skip'),
  );
  assert.deepEqual(
    await usesOf({ answer: { ...refund, originalInvoiceNumber: null } }),
    uses('run', 'run', 'skip', 'skip'),
  );
});

test('a vendor credit: its number, its total and date, its original bill; a vendor not in QuickBooks: nothing, and decide does not record it (F5)', async () => {
  assert.deepEqual(await usesOf({ answer: creditNote() }), uses('run', 'run', 'run', 'skip'));
  assert.deepEqual(
    await usesOf({ answer: creditNote({ originalInvoiceNumber: null }) }),
    uses('run', 'run', 'skip', 'skip'),
  );
  assert.deepEqual(
    await usesOf({ answer: creditNote(), bare: true }),
    uses('skip', 'skip', 'skip', 'skip'),
  );
  const world = await routeRun({ answer: creditNote(), bare: true });
  assert.equal(
    summaryOf(world.result),
    RESULTS.notRecorded('credit notes need an existing vendor'),
  );
});

test('a statement: the listed numbers and the open bills; none listed, the open bills alone; a vendor not in QuickBooks: nothing, and decide does not compare it (F6)', async () => {
  assert.deepEqual(await usesOf({ answer: statement() }), uses('run', 'run', 'skip', 'skip'));
  assert.deepEqual(
    await usesOf({
      answer: statement({
        listedItems: [{ reference: 'Balance forward', amount: 686.54, kind: 'balance_forward' }],
      }),
    }),
    uses('skip', 'run', 'skip', 'skip'),
  );
  const world = await routeRun({ answer: statement(), bare: true });
  assert.equal(summaryOf(world.result), RESULTS.notRecorded("the vendor isn't in QuickBooks"));
  assert.deepEqual(Object.keys(queriesOf(world)), ['find-vendor', 'find-vendor-company']);
});

test("three bills with the number, none the vendor's: reachedMax, so decide holds a possible duplicate (G4-3, D6)", async () => {
  const world = await routeRun({
    answer: bill(),
    company: (sim) =>
      sim.company.bills.push(
        ...['21', '22', '23'].map((id) => sampleBill(id, REF.other, { DocNumber: 'HOS-1042' })),
      ),
  });
  assert.ok(world.result.outcome === 'held');
  assert.equal(world.result.held.reason, 'May already be in QuickBooks.');
  assert.equal(lineOf(world, 'find-duplicate-number'), 'Possible duplicate');
  assert.equal(lineOf(world, 'decide'), 'Waiting for approval');
  // Two of them: no hold — the number goes in the memo.
  const two = await routeRun({
    answer: bill(),
    company: (sim) =>
      sim.company.bills.push(
        ...['21', '22'].map((id) => sampleBill(id, REF.other, { DocNumber: 'HOS-1042' })),
      ),
  });
  assert.equal(two.result.outcome, 'success');
});

test("a bill's expense with its number is a possible duplicate (decision 6, G4-5); none, no duplicate", async () => {
  const cash = samplePurchase('140', REF.checking, {
    PaymentType: 'Cash',
    DocNumber: 'HOS-1042',
    TxnDate: '2026-08-03',
    TotalAmt: 413.34,
  });
  const relatedLine = async (purchases: JsonObject[]) =>
    lineOf(
      await routeRun({
        answer: bill(),
        through: 'find-related',
        company: (sim) => sim.company.purchases.push(...purchases),
      }),
      'find-related',
    );
  assert.equal(await relatedLine([cash]), 'Possible duplicate');
  assert.equal(await relatedLine([]), 'No duplicate');
});

test('a row decide could not weigh — a bill without its vendor — is an answer QuickBooks gave unusably: not recorded, the details saved', async () => {
  const world = await routeRun({
    answer: bill(),
    company: (sim) =>
      sim.company.bills.push({
        Id: '5',
        DocNumber: 'HOS-1042',
        TxnDate: '2026-09-01',
        TotalAmt: 1,
        Balance: 1,
      }),
  });
  assert.equal(summaryOf(world.result), RESULTS.notRecorded("QuickBooks didn't answer"));
  assert.deepEqual(
    lines(world.platform).find(([stepId]) => stepId === 'find-duplicate-number'),
    ['find-duplicate-number', 'failed', "Not recorded in QuickBooks: QuickBooks didn't answer"],
  );
});

test("a statement's lookup says what it checked; the output lists every invoice number QuickBooks lacks", async () => {
  const listed = Array.from({ length: 40 }, (_, index) => ({
    reference: `HOS-${2000 + index}`,
    amount: 10,
    kind: 'invoice',
  }));
  const world = await routeRun({
    answer: statement({ listedItems: listed, listedItemsComplete: true, total: 400 }),
    company: (sim) =>
      sim.company.bills.push(
        sampleBill('70', REF.harrowgate, { DocNumber: 'hos-2000', Balance: 0 }),
      ),
  });
  assert.equal(lineOf(world, 'find-duplicate-number'), 'Number checked');
  assert.equal(lineOf(world, 'find-duplicate-amount'), 'Amount checked');
  assert.ok(world.result.outcome === 'success');
  const output = world.result.output as { statement: { listedNotInQuickBooks: string[] } };
  assert.deepEqual(
    output.statement.listedNotInQuickBooks,
    listed.slice(1).map((row) => row.reference),
  );
});
