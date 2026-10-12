import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { DECIDE_SENTENCES } from '../src/decide/fails.js';
import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import { lines } from './fixtures.js';
import {
  PAID,
  REF,
  lineOf,
  queriesOf,
  routeRun,
  sampleBill,
  samplePurchase,
  type RouteRun,
} from './lookups-world.js';

/**
 * Steps 14–17 per document type (the plan's §5): which lookups run, which say "Not checked" when no
 * number QuickBooks could hold was read (G4-4), which are skipped; an answer at its bound (D6); and
 * a statement's missing numbers. What each keeps is `lookup-records.test.ts`'s.
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

const NO_NUMBER = 'Not checked by number: no number was read';
const LONG_NUMBER =
  'Not checked by number: the number is longer than the 21 characters QuickBooks holds';
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

test('a vendor credit: its number, its total and date, its original bill; a vendor not in QuickBooks: nothing, and decide fails F5', async () => {
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
  assert.deepEqual(world.result, { outcome: 'failed', failureReason: DECIDE_SENTENCES.F5 });
});

test('a statement: the listed numbers and the open bills; none listed, the open bills alone; a vendor not in QuickBooks: nothing, and decide fails F6', async () => {
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
  assert.deepEqual(world.result, { outcome: 'failed', failureReason: DECIDE_SENTENCES.F6 });
  assert.deepEqual(Object.keys(queriesOf(world)), ['find-vendor', 'find-vendor-company']);
});

test('paid personally: the day’s entries or the contractor’s bills, and the company charge; a number only on a bill document', async () => {
  for (const paid of [PAID.employee, PAID.owner, PAID.contractor]) {
    assert.deepEqual(
      await usesOf({ answer: receipt(), ...paid }),
      uses('skip', 'run', 'run', 'skip'),
    );
    assert.deepEqual(await usesOf({ answer: bill(), ...paid }), uses('run', 'run', 'run', 'skip'));
  }
  assert.deepEqual(
    await usesOf({ answer: bill({ documentNumber: null }), ...PAID.employee }),
    uses(NO_NUMBER, 'run', 'run', 'skip'),
  );
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
  assert.equal(
    world.result.held.reason,
    'Possible duplicate: Harrowgate Office Supply, HOS-1042, $413.34',
  );
  assert.match(lineOf(world, 'find-duplicate-number') ?? '', /; maybe more$/u);
  assert.match(lineOf(world, 'decide') ?? '', /possible duplicate: too many to check/u);
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

test("a bill's expenses with its number, by how each was paid and to whom — no payee, a card refund — three at most, 'maybe more' kept (decision 6, G4-5)", async () => {
  const check = samplePurchase('139', REF.checking, {
    PaymentType: 'Check',
    DocNumber: 'HOS-1042',
    TxnDate: '2026-08-02',
    TotalAmt: 1200,
    EntityRef: { type: 'Vendor', ...REF.other },
  });
  const cash = samplePurchase('140', REF.checking, {
    PaymentType: 'Cash',
    DocNumber: 'HOS-1042',
    TxnDate: '2026-08-03',
    TotalAmt: 413.34,
  });
  const refund = samplePurchase('141', REF.visa, {
    DocNumber: 'hos-1042',
    TxnDate: '2026-08-04',
    TotalAmt: 20,
    Credit: true,
    EntityRef: { type: 'Vendor', ...REF.tidewell },
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
  assert.equal(
    await relatedLine([cash, refund]),
    "Expenses with number 'HOS-1042': Id 140 (Cash, no payee, 2026-08-03, $413.34); Id 141 (CreditCard refund from Tidewell Hardware, 2026-08-04, $20.00)",
  );
  // A payment type Intuit does not list is not shown as given.
  assert.equal(
    await relatedLine([{ ...check, PaymentType: 'Wire' }]),
    "Expenses with number 'HOS-1042': Id 139 (Expense to Pacific Gas, 2026-08-02, $1,200.00)",
  );
  // A full answer: the payees shortened first, so the line keeps 200 characters and "maybe more".
  assert.equal(
    await relatedLine([check, cash, refund]),
    "Expenses with number 'HOS-1042': Id 139 (Check to Pacifi…, 2026-08-02, $1,200.00); Id 140 (Cash, no payee, 2026-08-03, $413.34); Id 141 (CreditCard refund from Tidewe…, 2026-08-04, $20.00); maybe more",
  );
});

test('a row decide could not weigh — a bill without its vendor — fails as an unexpected answer', async () => {
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
  assert.deepEqual(world.result, {
    outcome: 'failed',
    failureReason:
      'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
  });
  assert.deepEqual(lines(world.platform).at(-1), [
    'find-duplicate-number',
    'failed',
    'Number not searched (unexpected_answer)',
  ]);
});

test("a statement's line lists the invoice numbers QuickBooks lacks as far as 200 characters go, then +N more; the output, every one", async () => {
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
  const line = lineOf(world, 'find-duplicate-number') ?? '';
  assert.ok(line.length <= 200, line);
  assert.match(line, /^Listed invoices not in QuickBooks: HOS-2001, HOS-2002, .* \+\d+ more$/u);
  assert.ok(world.result.outcome === 'success');
  const output = world.result.output as { statement: { listedNotInQuickBooks: string[] } };
  assert.deepEqual(
    output.statement.listedNotInQuickBooks,
    listed.slice(1).map((row) => row.reference),
  );
});
