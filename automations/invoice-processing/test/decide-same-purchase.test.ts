import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDecideState } from '../src/decide/contract.js';
import { matchesOf } from '../src/decide/matches.js';
import { bill, receipt, sampleAnswer } from './check-world.js';
import {
  VENDOR,
  billRow,
  decide,
  decideState,
  expenseRow,
  found,
  heldOf,
  holdCodes,
  journalRow,
} from './decide-world.js';

/**
 * The same purchase met as another kind of record (the plan's §2.9; D22, D32): a bill's payment
 * confirmation, a receipt for an open bill, a supplier's invoice after its receipt, a receipt
 * after someone's reimbursement for it — each holds — and what the lookups saw, kept.
 */

const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };
const matches = (setUp: Parameters<typeof decideState>[0]) => {
  const state = readDecideState(decideState(setUp));
  assert.ok(state);
  return matchesOf(state);
};

test('the same purchase met as another kind of record holds', () => {
  // A bill created and paid, then its payment confirmation uploaded: "already paid".
  const confirmation = heldOf(
    decide({
      answer: sampleAnswer('paid-invoice'),
      vendor: { ...VENDOR, id: '12', displayName: 'Wrenfield & Pike Bookkeeping' },
      lookups: {
        numberLookup: found(
          billRow({ vendorId: '12', docNumber: 'LH-2609', totalCents: 48000, balanceCents: 0 }),
        ),
      },
    }),
  );
  assert.deepEqual(
    confirmation.holds.map((hold) => hold.phrase),
    ['matches a paid bill', 'paid from Checking?'],
  );
  assert.equal(confirmation.reason, 'Matches a paid bill, paid from Checking?');
  // An open bill, then a receipt for it.
  const open = heldOf(
    decide({
      answer: receipt(),
      vendor: TIDEWELL,
      lookups: {
        relatedLookup: found(billRow({ vendorId: '9', docNumber: 'TH-88', totalCents: 6063 })),
      },
    }),
  );
  assert.deepEqual(
    open.holds.map((hold) => hold.phrase),
    ['matches an open bill'],
  );
  assert.equal(open.reason, 'Matches an open bill.');
  // A receipt recorded first, then the supplier's invoice (D32).
  assert.deepEqual(
    holdCodes(
      decide({
        answer: bill(),
        lookups: {
          otherRecordLookup: found(expenseRow({ totalCents: 41334, txnDate: '2026-09-20' })),
        },
      }),
    ),
    ['possible_duplicate'],
  );
  // Someone's reimbursement recorded, then the same receipt as a company receipt (D32).
  assert.deepEqual(
    holdCodes(
      decide({
        answer: receipt(),
        vendor: TIDEWELL,
        lookups: {
          otherRecordLookup: found(journalRow(6063, '120', {}, { type: 'Employee', id: '55' })),
        },
      }),
    ),
    ['possible_duplicate'],
  );
  // Another vendor's bill for the amount in the window — a reimbursement to a contractor, say.
  assert.deepEqual(
    holdCodes(
      decide({
        answer: receipt(),
        vendor: TIDEWELL,
        lookups: {
          relatedLookup: found(
            billRow({ vendorId: '31', docNumber: null, totalCents: 6063, txnDate: '2026-09-27' }),
          ),
        },
      }),
    ),
    ['possible_duplicate'],
  );
  // A bill from the seller without a number, paid.
  const unnumbered = heldOf(
    decide({
      answer: receipt(),
      vendor: TIDEWELL,
      lookups: {
        relatedLookup: found(
          billRow({ vendorId: '9', docNumber: null, totalCents: 6063, balanceCents: 0 }),
        ),
      },
    }),
  );
  assert.deepEqual(
    unnumbered.holds.map((hold) => hold.phrase),
    ['matches a paid bill'],
  );
  // An open bill and a paid one from the seller: the open one is named.
  const both = heldOf(
    decide({
      answer: receipt(),
      vendor: TIDEWELL,
      lookups: {
        numberLookup: found(
          billRow({
            id: '160',
            vendorId: '9',
            docNumber: '55120',
            totalCents: 7000,
            balanceCents: 0,
          }),
        ),
        relatedLookup: found(
          billRow({ id: '161', vendorId: '9', docNumber: 'TH-90', totalCents: 6063 }),
        ),
      },
    }),
  );
  assert.deepEqual(
    both.holds.map((hold) => hold.phrase),
    ['matches an open bill'],
  );
  // A seller that is no vendor: nothing to match a bill of.
  assert.deepEqual(
    holdCodes(
      decide({
        answer: receipt(),
        vendor: { status: 'new' },
        lookups: {
          relatedLookup: found(billRow({ vendorId: '9', totalCents: 6063, txnDate: '2026-12-01' })),
        },
      }),
    ),
    [],
  );
});

test('what the lookups saw is kept, each record once, by kind', () => {
  const seen = matches({
    answer: bill(),
    lookups: {
      numberLookup: found(billRow({ id: '1', vendorId: '88' })),
      amountLookup: found(
        billRow({ id: '1', vendorId: '88' }),
        billRow({ id: '2', vendorId: '88', docNumber: null }),
      ),
      relatedLookup: found(expenseRow({ id: '3' })),
    },
  }).seen;
  assert.deepEqual(seen, {
    billIds: ['1', '2'],
    expenseIds: ['3'],
    vendorCreditIds: [],
    journalEntryIds: [],
  });
});
