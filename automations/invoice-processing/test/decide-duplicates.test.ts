import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchesOf } from '../src/decide/matches.js';
import { readDecideState } from '../src/decide/contract.js';
import { bill, creditNote, receipt, sampleAnswer } from './check-world.js';
import {
  VENDOR,
  billRow,
  decide,
  decideState,
  expenseRow,
  found,
  journalRow,
  vendorCreditRow,
  type DecideSetUp,
} from './decide-world.js';

/**
 * "Possible duplicate", per type (the plan's §2.4, §5; D5, D6, D21, D22, D32): what each lookup's
 * records mean on each path — compared in code by vendor, account, window and lines — the
 * bank-feed window's edges on the account the receipt is paid from ("a bank or card charge
 * matches"), and the same purchase met as another kind of record.
 */

const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };
const matches = (setUp: DecideSetUp) => {
  const state = readDecideState(decideState(setUp));
  assert.ok(state);
  return matchesOf(state);
};
const duplicates = (setUp: DecideSetUp) => matches(setUp).duplicates;

test("a bill: the same vendor's bill with this number, a bill with this total and date, an expense with this number, an expense near it (D32)", () => {
  assert.deepEqual(duplicates({ answer: bill(), lookups: { numberLookup: found(billRow()) } }), [
    'a bill with this number',
  ]);
  // Another vendor's bill with the number: no hold, and the number goes in the memo.
  const other = matches({
    answer: bill(),
    lookups: { numberLookup: found(billRow({ vendorId: '88' })) },
  });
  assert.deepEqual([other.duplicates, other.numberTaken], [[], true]);
  const plan = decide({
    answer: bill(),
    lookups: { numberLookup: found(billRow({ vendorId: '88' })) },
  });
  assert.ok(plan.outcome === 'ok' && plan.saved.plan.docNumber === null);
  // A new vendor: any bill with the number (D5).
  assert.deepEqual(
    duplicates({
      answer: bill(),
      vendor: { status: 'new' },
      lookups: { numberLookup: found(billRow({ vendorId: '88' })) },
    }),
    ['a bill with this number'],
  );
  // Numbers compared as QuickBooks compares them: without case.
  assert.deepEqual(
    duplicates({
      answer: bill(),
      lookups: { numberLookup: found(billRow({ docNumber: 'hos-1042' })) },
    }),
    ['a bill with this number'],
  );
  assert.deepEqual(
    duplicates({ answer: bill(), lookups: { amountLookup: found(billRow({ docNumber: null })) } }),
    ['a bill for this total and date'],
  );
  assert.deepEqual(
    duplicates({
      answer: bill(),
      lookups: { amountLookup: found(billRow({ txnDate: '2026-09-13' })) },
    }),
    [],
  );
  assert.deepEqual(
    duplicates({ answer: bill(), lookups: { amountLookup: found(billRow({ vendorId: '88' })) } }),
    [],
    "another vendor's, for a matched vendor",
  );
  assert.deepEqual(
    duplicates({
      answer: bill(),
      lookups: { relatedLookup: found(expenseRow({ docNumber: 'HOS-1042' })) },
    }),
    ['an expense with this number'],
  );
  // D32: an expense for the total from 1 day before the bill's date to 20 days after its due date.
  const near = (txnDate: string, answer = bill()) =>
    duplicates({
      answer,
      lookups: { otherRecordLookup: found(expenseRow({ totalCents: 41334, txnDate })) },
    });
  assert.deepEqual(near('2026-09-12'), [], '2 days before');
  assert.deepEqual(near('2026-09-13'), ['an expense for this amount'], '1 day before');
  assert.deepEqual(
    near('2026-11-03'),
    ['an expense for this amount'],
    '20 days after the due date',
  );
  assert.deepEqual(near('2026-11-04'), [], '21 days after');
  const undated = bill({ dueDate: null, paymentTermsDays: null });
  assert.deepEqual(
    near('2026-10-04', undated),
    ['an expense for this amount'],
    '20 days after its date, with no due date',
  );
  assert.deepEqual(near('2026-10-05', undated), []);
});

test('a company receipt: the bank-feed check on the account it is paid from (D21), at its edges', () => {
  const feed = (txnDate: string, changes = {}) =>
    matches({
      answer: receipt(),
      vendor: TIDEWELL,
      lookups: { amountLookup: found(expenseRow({ txnDate, ...changes })) },
    }).companyCharges;
  assert.equal(feed('2026-09-25'), 0, '2 days before');
  assert.equal(feed('2026-09-26'), 1, '1 day before');
  assert.equal(feed('2026-10-17'), 1, '20 days after');
  assert.equal(feed('2026-10-18'), 0, '21 days after');
  assert.equal(feed('2026-09-27', { accountId: '41' }), 0, 'another card: not the one picked');
  assert.equal(feed('2026-09-27', { credit: true }), 0, 'a refund');
  assert.equal(feed('2026-09-27', { totalCents: 6064 }), 0, 'another amount');
  // Another vendor's bill for this amount in the window — a contractor's reimbursement, say.
  assert.deepEqual(
    duplicates({
      answer: receipt(),
      vendor: TIDEWELL,
      lookups: {
        relatedLookup: found(billRow({ vendorId: '88', totalCents: 6063, txnDate: '2026-09-28' })),
      },
    }),
    ["another vendor's bill for this amount"],
  );
  assert.deepEqual(
    duplicates({
      answer: receipt(),
      vendor: TIDEWELL,
      lookups: {
        relatedLookup: found(billRow({ vendorId: '88', totalCents: 6063, txnDate: '2026-10-30' })),
      },
    }),
    [],
  );
  // D32: a reimbursement already recorded for it.
  assert.deepEqual(
    duplicates({
      answer: receipt(),
      vendor: TIDEWELL,
      lookups: { otherRecordLookup: found(journalRow(6063, '120')) },
    }),
    ['a reimbursement for this amount'],
  );
});

test("a card refund: the card feed's refunds in the window, and a vendor credit with its number", () => {
  const answer = sampleAnswer('card-refund');
  const refund = (txnDate: string, credit = true) =>
    matches({
      answer,
      lookups: { amountLookup: found(expenseRow({ txnDate, totalCents: 2372, credit })) },
    }).companyCharges;
  assert.equal(refund('2026-09-30'), 0, '2 days before');
  assert.equal(refund('2026-10-01'), 1, '1 day before');
  assert.equal(refund('2026-10-22'), 1, '20 days after');
  assert.equal(refund('2026-10-23'), 0, '21 days after');
  assert.equal(refund('2026-10-02', false), 0, 'a charge, not a refund');
  assert.deepEqual(
    duplicates({
      answer,
      lookups: { numberLookup: found(vendorCreditRow({ docNumber: 'R-6603', vendorId: '88' })) },
    }),
    ['a vendor credit with this number'],
  );
});

test("a vendor credit: this vendor's credit with its number or its total and date; another's number only keeps the number out", () => {
  assert.deepEqual(
    duplicates({ answer: creditNote(), lookups: { numberLookup: found(vendorCreditRow()) } }),
    ['a vendor credit with this number'],
  );
  const other = matches({
    answer: creditNote(),
    lookups: { numberLookup: found(vendorCreditRow({ vendorId: '88' })) },
  });
  assert.deepEqual([other.duplicates, other.numberTaken], [[], true]);
  assert.deepEqual(
    duplicates({
      answer: creditNote(),
      lookups: { amountLookup: found(vendorCreditRow({ docNumber: null })) },
    }),
    ['a vendor credit for this total and date'],
  );
});

test('a lookup that reached its maximum may hide a match: a possible duplicate, "too many to check" (D6)', () => {
  for (const key of [
    'numberLookup',
    'amountLookup',
    'relatedLookup',
    'otherRecordLookup',
  ] as const) {
    assert.deepEqual(
      duplicates({ answer: bill(), lookups: { [key]: { reachedMax: true, records: [] } } }),
      ['too many to check'],
      key,
    );
  }
});
