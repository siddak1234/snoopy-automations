import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expenseLine } from '@autom8x/automation-kit/testing';
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
  sampleJournalEntry,
  samplePurchase,
  stateOf,
  type RouteRun,
} from './lookups-world.js';

/**
 * Steps 14–17 per document type (the plan's §5): which lookups run, which say "Not checked" when no
 * number QuickBooks could hold was read (G4-4), which are skipped; the records each keeps, typed as
 * decide's contract has them; an answer at its bound (D6); and a statement's missing numbers.
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

test("each record is kept as decide's contract types it: a bill, an expense, a vendor credit, a journal entry and its lines", async () => {
  const world = await routeRun({
    answer: receipt(),
    through: 'find-other-record',
    company: (sim) => {
      sim.company.bills.push(
        sampleBill('160', REF.tidewell, {
          DocNumber: '55120',
          TxnDate: '2026-09-20',
          TotalAmt: 60.63,
          Balance: 0,
        }),
      );
      sim.company.purchases.push(
        samplePurchase('201', REF.visa, {
          TxnDate: '2026-09-28',
          TotalAmt: 60.63,
          DocNumber: 'X 1',
        }),
      );
      sim.company.journalEntries.push(
        sampleJournalEntry(
          '401',
          60.63,
          { debit: REF.electric, credit: REF.teamOwed },
          { TxnDate: '2026-09-27' },
          { Type: 'Employee', EntityRef: { value: '55', name: 'Robin Example' } },
        ),
      );
    },
  });
  const state = stateOf(world.result);
  const bill160 = {
    kind: 'bill',
    id: '160',
    vendorId: '9',
    docNumber: '55120',
    txnDate: '2026-09-20',
    totalCents: 6063,
    balanceCents: 0,
    lineAccounts: [{ id: '64', name: 'Office Supplies' }],
  };
  assert.deepEqual(state.numberLookup, { reachedMax: false, records: [bill160] });
  assert.deepEqual(state.relatedLookup, { reachedMax: false, records: [bill160] });
  assert.deepEqual(state.amountLookup, {
    reachedMax: false,
    records: [
      {
        kind: 'expense',
        id: '201',
        accountId: '41',
        txnDate: '2026-09-28',
        totalCents: 6063,
        credit: false,
        docNumber: 'X 1',
      },
    ],
  });
  assert.deepEqual(state.otherRecordLookup, {
    reachedMax: false,
    records: [
      {
        kind: 'journal_entry',
        id: '401',
        txnDate: '2026-09-27',
        lines: [
          { postingType: 'Debit', amountCents: 6063, accountId: '57', entity: null },
          {
            postingType: 'Credit',
            amountCents: 6063,
            accountId: '120',
            entity: { type: 'Employee', id: '55' },
          },
        ],
      },
    ],
  });
  assert.equal(
    lineOf(world, 'find-duplicate-number'),
    "Bills from this vendor with number '55120': Id 160 (this vendor, 2026-09-20, $60.63, paid)",
  );
  assert.equal(
    lineOf(world, 'find-duplicate-amount'),
    'Expenses for $60.63 from 2026-09-26 to 2026-10-17: Id 201 (Company Visa, 2026-09-28, $60.63)',
  );
  assert.equal(
    lineOf(world, 'find-other-record'),
    'Journal entries from 2026-09-26 to 2026-10-17: Id 401 (2026-09-27)',
  );
});

test('a vendor credit kept with its vendor, compared in code; an item line leaves a bill’s accounts unknown', async () => {
  const world = await routeRun({
    answer: creditNote(),
    through: 'find-other-record',
    company: (sim) => {
      sim.company.vendorCredits.push({
        Id: '301',
        VendorRef: REF.other,
        DocNumber: 'CM-0077',
        TxnDate: '2026-09-01',
        TotalAmt: 15,
      });
      sim.company.bills.push(
        sampleBill('151', REF.harrowgate, {
          DocNumber: 'HOS-1042',
          Line: [
            {
              Id: '1',
              Amount: 5,
              DetailType: 'ItemBasedExpenseLineDetail',
              ItemBasedExpenseLineDetail: {},
            },
            // An account line beside the item's: still not "one account the bill used".
            expenseLine(5, { value: '64', name: 'Office Supplies' }),
          ],
        }),
      );
    },
  });
  const state = stateOf(world.result);
  assert.deepEqual((state.numberLookup as JsonObject).records, [
    {
      kind: 'vendor_credit',
      id: '301',
      vendorId: '88',
      docNumber: 'CM-0077',
      txnDate: '2026-09-01',
      totalCents: 1500,
    },
  ]);
  assert.equal(
    lineOf(world, 'find-duplicate-number'),
    "Vendor credits with number 'CM-0077': Id 301 (Pacific Gas, 2026-09-01, $15.00)",
  );
  assert.deepEqual(
    ((state.relatedLookup as JsonObject).records as JsonObject[])[0]?.lineAccounts,
    [],
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
