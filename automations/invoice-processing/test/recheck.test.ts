import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FoundRecord } from '../src/decide/contract.js';
import { readDecideState } from '../src/decide/contract.js';
import { isDuplicate } from '../src/decide/duplicate-rule.js';
import { matchesOf } from '../src/decide/matches.js';
import { recheckLookup, recheckOf } from '../src/decide/recheck.js';
import { amountSearch, numberSearch } from '../src/lookups/queries.js';
import { bill, creditNote, paidBy, receipt, sampleAnswer } from './check-world.js';
import {
  CHECKING,
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
 * the lookup step sent, one row more — and, for every record a lookup can find, decide's "possible
 * duplicate" and the re-check's verdict the same.
 */

const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };
const stateOf = (setUp: DecideSetUp) => {
  const state = readDecideState(decideState(setUp));
  assert.ok(state);
  return state;
};

const PATHS: readonly [string, DecideSetUp, 'numberLookup' | 'amountLookup', string][] = [
  [
    'a bill with a number QuickBooks can hold: by its number',
    { answer: bill() },
    'numberLookup',
    "SELECT * FROM Bill WHERE DocNumber = 'HOS-1042' MAXRESULTS 4",
  ],
  [
    'a bill with a number past 21 characters: by its total and date, from its vendor',
    { answer: bill({ documentNumber: 'N'.repeat(22) }) },
    'amountLookup',
    "SELECT * FROM Bill WHERE TotalAmt = '413.34' AND TxnDate = '2026-09-14' AND VendorRef = '7' MAXRESULTS 4",
  ],
  [
    "a new vendor's bill with no number: by its total and date, from any vendor",
    { answer: bill({ documentNumber: null }), vendor: { status: 'new' } },
    'amountLookup',
    "SELECT * FROM Bill WHERE TotalAmt = '413.34' AND TxnDate = '2026-09-14' MAXRESULTS 4",
  ],
  [
    'a company receipt: the bank-feed check (D21)',
    { answer: receipt(), vendor: TIDEWELL },
    'amountLookup',
    "SELECT * FROM Purchase WHERE TotalAmt = '60.63' AND TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' MAXRESULTS 4",
  ],
  [
    'a card refund: the bank-feed check on the card',
    { answer: sampleAnswer('card-refund'), vendor: TIDEWELL },
    'amountLookup',
    "SELECT * FROM Purchase WHERE TotalAmt = '23.72' AND TxnDate >= '2026-10-01' AND TxnDate <= '2026-10-22' MAXRESULTS 4",
  ],
  [
    'a vendor credit with its number',
    { answer: creditNote() },
    'numberLookup',
    "SELECT * FROM VendorCredit WHERE DocNumber = 'CM-0077' MAXRESULTS 4",
  ],
  [
    'a vendor credit with none',
    { answer: creditNote({ documentNumber: null }) },
    'amountLookup',
    "SELECT * FROM VendorCredit WHERE TotalAmt = '203.20' AND TxnDate = '2026-09-22' MAXRESULTS 4",
  ],
  [
    "an employee's: the day's journal entries",
    { answer: receipt(), check: paidBy('employee', { paidFrom: null }) },
    'amountLookup',
    "SELECT * FROM JournalEntry WHERE TxnDate = '2026-09-27' MAXRESULTS 11",
  ],
  [
    "an owner's: the day's journal entries",
    { answer: receipt(), check: paidBy('owner', { paidFrom: null }) },
    'amountLookup',
    "SELECT * FROM JournalEntry WHERE TxnDate = '2026-09-27' MAXRESULTS 11",
  ],
  [
    "a contractor's: the bills to them for its total and date",
    {
      answer: bill(),
      check: paidBy('not_employee', { paidFrom: null }),
      vendor: { ...VENDOR, id: '31', displayName: 'Sam Lee' },
    },
    'amountLookup',
    "SELECT * FROM Bill WHERE TotalAmt = '413.34' AND TxnDate = '2026-09-14' AND VendorRef = '31' MAXRESULTS 4",
  ],
];

test("each path's re-check: its own duplicate lookup, the text the lookup step sent with one row more", () => {
  for (const [label, setUp, lookup, query] of PATHS) {
    const state = stateOf(setUp);
    const recheck = recheckOf(state, 'amount');
    assert.deepEqual([recheck.lookup, recheck.query], [lookup, query], label);
    const sent =
      lookup === 'numberLookup'
        ? numberSearch(state.document, state.vendor)
        : amountSearch(state.document, state.vendor, 'amount');
    assert.equal(recheck.maxResults, sent.maxResults + 1, label);
    assert.equal(
      recheck.query,
      sent.query.replace(/MAXRESULTS \d+$/u, `MAXRESULTS ${sent.maxResults + 1}`),
      label,
    );
  }
  // Sandbox S4's fallback: the window alone, newest first, one row more than its 50.
  const fallback = recheckOf(stateOf({ answer: receipt(), vendor: TIDEWELL }), 'window');
  assert.equal(
    fallback.query,
    "SELECT * FROM Purchase WHERE TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' ORDERBY TxnDate DESC MAXRESULTS 51",
  );
  assert.equal(recheckLookup('company_receipt', true), 'amountLookup');
  assert.equal(recheckLookup('vendor_credit', false), 'amountLookup');
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
  expenseRow({ id: '203', accountId: CHECKING.id }),
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
  // The same vendor's bill for the total and date.
  ['151', '154'],
  // A new vendor's: any vendor's bill for the total and date (D5).
  ['151', '152', '154', '156'],
  // A charge for the amount on the Paid from card, in the window (D21): not a refund, not the bank's.
  ['201'],
  // A refund for the amount on the card, in the window.
  ['202'],
  // The vendor's credit with the number; not another vendor's.
  ['301'],
  // The vendor's credit for the total and date, numbered or not.
  ['301', '302'],
  // An entry that day crediting the amount to Owed to team members under this employee.
  ['401'],
  // An entry that day crediting the amount to the owner's equity account.
  ['402'],
  // A bill to the contractor for the total and date.
  ['156'],
];

test("the one rule's verdicts, per path: which records duplicate the planned one", () => {
  for (const [index, [label, setUp, lookup]] of PATHS.entries()) {
    const facts = recheckOf(stateOf(setUp), 'amount').facts;
    assert.deepEqual(
      RECORDS.filter((record) => isDuplicate(facts, lookup, record)).map((record) => record.id),
      VERDICTS[index],
      label,
    );
  }
});

test("decide's possible duplicate and the re-check's verdict are one rule: for every record, on every path, the same", () => {
  for (const [label, setUp, lookup] of PATHS) {
    for (const record of RECORDS) {
      const state = stateOf({ ...setUp, lookups: { [lookup]: found(record) } });
      const held = matchesOf(state).duplicates.length > 0;
      const facts = recheckOf(state, 'amount').facts;
      assert.equal(
        isDuplicate(facts, lookup, record),
        held,
        `${label}: ${record.kind} ${record.id}`,
      );
    }
  }
});

test("the rule's facts are decide's: the document's number, amount and date, the vendor matched (none for a new one), the account and the person", () => {
  assert.deepEqual(recheckOf(stateOf({ answer: bill(), vendor: { status: 'new' } })).facts, {
    route: 'bill',
    number: 'HOS-1042',
    amountCents: 41334,
    date: '2026-09-14',
    vendorId: null,
    accountId: null,
    employeeId: null,
  });
  assert.deepEqual(
    recheckOf(stateOf({ answer: receipt(), check: paidBy('employee', { paidFrom: null }) })).facts,
    {
      route: 'employee',
      number: '55120',
      amountCents: 6063,
      date: '2026-09-27',
      vendorId: null,
      accountId: '120',
      employeeId: '55',
    },
  );
  assert.equal(recheckOf(stateOf({ answer: receipt(), vendor: TIDEWELL })).facts.accountId, '41');
});
