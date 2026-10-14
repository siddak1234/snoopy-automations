import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DecideState, FoundRecord, LookupState } from '../src/decide/contract.js';
import { readDecideState } from '../src/decide/contract.js';
import { isDuplicate } from '../src/decide/duplicate-rule.js';
import { matchesOf } from '../src/decide/matches.js';
import { recordPlan } from '../src/decide/plan.js';
import { createdBefore, recheckLookup, recheckOf } from '../src/decide/recheck.js';
import type { ExpenseSearch } from '../src/lookups/expense-search.js';
import { amountSearch, numberSearch } from '../src/lookups/queries.js';
import { bill, creditNote, receipt, sampleAnswer } from './check-world.js';
import {
  VENDOR,
  billRow,
  decideState,
  expenseRow,
  found,
  journalRow,
  vendorCreditRow,
  type DecideSetUp,
} from './decide-world.js';

/**
 * The re-check an approval repeats (`src/decide/recheck.ts`), and the ONE rule it shares with decide
 * (`src/decide/duplicate-rule.ts`): per path, the lookup repeated and its text — the very search
 * the lookup step sent, one row more, by number only when the record will carry the number — and,
 * for every record a lookup can find, decide's "possible duplicate" and the re-check's verdict the
 * same; and when a full lookup lets a record QuickBooks made before it go unseen.
 */

const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };
const stateOf = (setUp: DecideSetUp) => {
  const state = readDecideState(decideState(setUp));
  assert.ok(state);
  return state;
};
/** The re-check decide saves for a state, built from the plan it makes. */
const recheckFor = (state: DecideState, how: ExpenseSearch = 'amount') => {
  const planned = recordPlan(state, matchesOf(state));
  assert.ok(planned.kind === 'plan', planned.kind);
  return recheckOf(state, planned.plan, how);
};

const PATHS: readonly [string, DecideSetUp, 'numberLookup' | 'amountLookup', string][] = [
  [
    'a bill with a number QuickBooks can hold: by its number',
    { answer: bill() },
    'numberLookup',
    "SELECT * FROM Bill WHERE DocNumber = 'HOS-1042' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  ],
  [
    "a bill whose number another vendor's bill has: the number goes in the memo, so by its total and date, from its vendor",
    { answer: bill(), lookups: { numberLookup: found(billRow({ id: '152', vendorId: '88' })) } },
    'amountLookup',
    "SELECT * FROM Bill WHERE TotalAmt = '413.34' AND TxnDate = '2026-09-14' AND VendorRef = '7' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  ],
  [
    'a bill with a number past 21 characters: by its total and date, from its vendor',
    { answer: bill({ documentNumber: 'N'.repeat(22) }) },
    'amountLookup',
    "SELECT * FROM Bill WHERE TotalAmt = '413.34' AND TxnDate = '2026-09-14' AND VendorRef = '7' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  ],
  [
    "a new vendor's bill with no number: by its total and date, from any vendor",
    { answer: bill({ documentNumber: null }), vendor: { status: 'new' } },
    'amountLookup',
    "SELECT * FROM Bill WHERE TotalAmt = '413.34' AND TxnDate = '2026-09-14' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  ],
  [
    'a company receipt: the bank-feed check (D21)',
    { answer: receipt(), vendor: TIDEWELL },
    'amountLookup',
    "SELECT * FROM Purchase WHERE TotalAmt = '60.63' AND TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  ],
  [
    'a card refund: the bank-feed check on the card',
    { answer: sampleAnswer('card-refund'), vendor: TIDEWELL },
    'amountLookup',
    "SELECT * FROM Purchase WHERE TotalAmt = '23.72' AND TxnDate >= '2026-10-01' AND TxnDate <= '2026-10-22' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  ],
  [
    'a vendor credit with own numbers on: its number sent, so by it',
    { answer: creditNote(), preferences: { purchaseCustomTxnNumbers: true } },
    'numberLookup',
    "SELECT * FROM VendorCredit WHERE DocNumber = 'CM-0077' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  ],
  [
    'a vendor credit with own numbers not on: its number in the memo — QuickBooks numbers the credit itself — so by its total and date',
    { answer: creditNote() },
    'amountLookup',
    "SELECT * FROM VendorCredit WHERE TotalAmt = '203.20' AND TxnDate = '2026-09-22' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  ],
  [
    'a vendor credit with none',
    { answer: creditNote({ documentNumber: null }) },
    'amountLookup',
    "SELECT * FROM VendorCredit WHERE TotalAmt = '203.20' AND TxnDate = '2026-09-22' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  ],
];

test("each path's re-check: its own duplicate lookup, the text the lookup step sent with one row more, the newest created first", () => {
  for (const [label, setUp, lookup, query] of PATHS) {
    const state = stateOf(setUp);
    const recheck = recheckFor(state);
    assert.deepEqual([recheck.lookup, recheck.query], [lookup, query], label);
    const sent =
      lookup === 'numberLookup'
        ? numberSearch(state.document, state.vendor)
        : amountSearch(state.document, state.vendor, 'amount');
    assert.equal(recheck.maxResults, sent.maxResults + 1, label);
    // The same search: only its order — the newest created first — and its bound differ.
    assert.equal(
      recheck.query,
      sent.query.replace(
        /MAXRESULTS \d+$/u,
        `ORDERBY MetaData.CreateTime DESC MAXRESULTS ${sent.maxResults + 1}`,
      ),
      label,
    );
  }
  // Sandbox S4's fallback: the window alone, one row more than its 50 — the newest created first
  // in place of the lookup's newest dated first, so a charge the feed brought in meanwhile is in it.
  const fallback = recheckFor(stateOf({ answer: receipt(), vendor: TIDEWELL }), 'window');
  assert.equal(
    fallback.query,
    "SELECT * FROM Purchase WHERE TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' ORDERBY MetaData.CreateTime DESC MAXRESULTS 51",
  );
  assert.equal(recheckLookup('company_receipt', true), 'amountLookup');
  assert.equal(recheckLookup('vendor_credit', false), 'amountLookup');
  // Own numbers said off, as unknown: the credit's number in the memo, searched by total and date.
  const off = stateOf({ answer: creditNote(), preferences: { purchaseCustomTxnNumbers: false } });
  assert.equal(recheckFor(off).lookup, 'amountLookup');
});

/** Records a lookup can find, matching and not, for the rule to weigh. */
const RECORDS: readonly FoundRecord[] = [
  billRow(),
  billRow({ id: '152', vendorId: '88' }),
  billRow({ id: '153', docNumber: 'hos-1042', txnDate: '2026-09-01' }),
  billRow({ id: '154', docNumber: null, totalCents: 41334, txnDate: '2026-09-14' }),
  billRow({ id: '155', vendorId: '31', docNumber: null, totalCents: 6063, txnDate: '2026-09-27' }),
  billRow({ id: '156', vendorId: '31', docNumber: null }),
  expenseRow(),
  expenseRow({ id: '202', credit: true, totalCents: 2372, txnDate: '2026-10-02' }),
  expenseRow({ id: '203', accountId: '35' }),
  expenseRow({ id: '204', txnDate: '2026-10-18' }),
  // A refund of the receipt's amount, and a charge of the refund's: each the other kind.
  expenseRow({ id: '205', credit: true }),
  expenseRow({ id: '206', totalCents: 2372, txnDate: '2026-10-02' }),
  vendorCreditRow(),
  vendorCreditRow({ id: '302', docNumber: null }),
  vendorCreditRow({ id: '303', vendorId: '88' }),
  journalRow(6063, '120', {}, { type: 'Employee', id: '55' }),
  journalRow(6063, '125', { id: '402' }),
  journalRow(6063, '120', { id: '403' }, { type: 'Employee', id: '56' }),
  journalRow(6063, '120', { id: '404', txnDate: '2026-09-28' }, { type: 'Employee', id: '55' }),
];

/** Each path's duplicates among `RECORDS`, by Id: the plan's §2.4 "Possible duplicate", per type. */
const VERDICTS: readonly string[][] = [
  // The same vendor's bill with the number, in any case.
  ['151', '153'],
  // Its number in the memo: the same vendor's bill for the total and date.
  ['151', '154'],
  // The same vendor's bill for the total and date.
  ['151', '154'],
  // A new vendor's: any vendor's bill for the total and date (D5).
  ['151', '152', '154', '156'],
  // A charge for the amount on the card it is paid from, in the window (D21): not a refund, not the bank's.
  ['201'],
  // A refund for the amount on the card, in the window.
  ['202'],
  // The vendor's credit with the number; not another vendor's.
  ['301'],
  // Its number in the memo: the vendor's credit for the total and date, numbered or not.
  ['301', '302'],
  // The vendor's credit for the total and date, numbered or not.
  ['301', '302'],
];

test("the one rule's verdicts, per path: which records duplicate the planned one", () => {
  for (const [index, [label, setUp, lookup]] of PATHS.entries()) {
    const facts = recheckFor(stateOf(setUp)).facts;
    assert.deepEqual(
      RECORDS.filter((record) => isDuplicate(facts, lookup, record)).map((record) => record.id),
      VERDICTS[index],
      label,
    );
  }
});

test("decide's hold and the re-check's verdict are one rule: for every record, on every path, the same", () => {
  for (const [label, setUp, lookup] of PATHS) {
    for (const record of RECORDS) {
      const state = stateOf({ ...setUp, lookups: { [lookup]: found(record) } });
      // A receipt's or a refund's bank-feed match holds as "a bank or card charge matches".
      const matches = matchesOf(state);
      const held = matches.duplicates.length > 0 || matches.companyCharges > 0;
      const facts = recheckFor(state).facts;
      assert.equal(
        isDuplicate(facts, lookup, record),
        held,
        `${label}: ${record.kind} ${record.id}`,
      );
    }
  }
});

test("the rule's facts are decide's: the document's number, amount and date, the vendor matched (none for a new one), and the account it is paid from", () => {
  assert.deepEqual(recheckFor(stateOf({ answer: bill(), vendor: { status: 'new' } })).facts, {
    route: 'bill',
    number: 'HOS-1042',
    amountCents: 41334,
    date: '2026-09-14',
    vendorId: null,
    accountId: null,
  });
  assert.equal(recheckFor(stateOf({ answer: receipt(), vendor: TIDEWELL })).facts.accountId, '42');
});

/** QuickBooks' time on an answer, with milliseconds as Intuit writes it. */
const ANSWERED = '2026-10-10T09:00:00.462-07:00';
const answered = (reachedMax: boolean, answeredAt?: string | null): LookupState => ({
  reachedMax,
  records: [],
  ...(answeredAt === undefined ? {} : { answeredAt }),
});

test("the re-check keeps QuickBooks' time on decide's lookup only when that answer was full: then a match made before it was past the bound", () => {
  const receiptWith = (amountLookup: LookupState) =>
    recheckFor(stateOf({ answer: receipt(), vendor: TIDEWELL, lookups: { amountLookup } }));
  assert.equal(receiptWith(answered(true, ANSWERED)).fullAt, ANSWERED);
  assert.equal(receiptWith(answered(false, ANSWERED)).fullAt, null);
  assert.equal(receiptWith(answered(true, null)).fullAt, null);
  assert.equal(receiptWith(answered(true)).fullAt, null);
  // The lookup repeated is the one whose answer counts: a bill's number lookup, its number sent.
  const byNumber = recheckFor(
    stateOf({
      answer: bill(),
      lookups: { numberLookup: answered(true, ANSWERED), amountLookup: answered(false, ANSWERED) },
    }),
  );
  assert.deepEqual([byNumber.lookup, byNumber.fullAt], ['numberLookup', ANSWERED]);
});

test("a row was there before decide's full answer when QuickBooks created it before the second that answer came in; unknown is never before", () => {
  // Each row changed since, after the answer: its creation is what counts, not its last change.
  const row = (CreateTime?: unknown) =>
    CreateTime === undefined
      ? {}
      : { MetaData: { CreateTime, LastUpdatedTime: '2026-10-11T08:00:00-07:00' } };
  assert.equal(createdBefore(row('2026-10-10T08:59:59-07:00'), ANSWERED), true);
  assert.equal(createdBefore(row('2024-01-02T09:00:00-08:00'), ANSWERED), true);
  // The same instant in another offset: 15:59:59Z is 08:59:59 at -07:00.
  assert.equal(createdBefore(row('2026-10-10T15:59:59Z'), ANSWERED), true);
  // CreateTime keeps whole seconds: one in the answer's second may be just after it, so it is new.
  assert.equal(createdBefore(row('2026-10-10T09:00:00-07:00'), ANSWERED), false);
  assert.equal(createdBefore(row('2026-10-10T09:00:01-07:00'), ANSWERED), false);
  // Unknown either way is not before: an unseen match then fails, the safe side.
  for (const unknown of [row(), row(''), row(7), row('2026-10-09'), row('2026-10-09T08:00:00')]) {
    assert.equal(createdBefore(unknown, ANSWERED), false, JSON.stringify(unknown));
  }
  assert.equal(createdBefore(row('2024-01-02T09:00:00-08:00'), null), false);
  assert.equal(createdBefore(row('2024-01-02T09:00:00-08:00'), 'yesterday'), false);
  assert.equal(createdBefore(undefined, ANSWERED), false);
});
