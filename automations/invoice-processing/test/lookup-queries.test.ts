import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { VendorState } from '../src/decide/contract.js';
import { listedInvoiceNumbers } from '../src/decide/lookup-uses.js';
import {
  MAX_RESULTS,
  amountSearch,
  customerByName,
  employeeByName,
  feedWindow,
  numberSearch,
  otherRecordSearch,
  relatedSearch,
  similarVendorsQuery,
  vendorByCompanyName,
  vendorByName,
} from '../src/lookups/queries.js';
import { distinctiveWord } from '../src/lookups/similar.js';
import {
  bill,
  check,
  creditNote,
  documentOf,
  paidBy,
  receipt,
  sampleAnswer,
  statement,
} from './check-world.js';
import { VENDOR } from './decide-world.js';

/**
 * Every query the lookups send, held to its fixed text per document type (the plan's §5;
 * ip-review design-quickbooks-lookups.json cross_cutting[0]), under both of sandbox S4's answers,
 * with the bounds each asks for, and the values quoted as Intuit reads them.
 */

const doc = (answer: JsonObject, options = {}) => documentOf(check(answer, options));
const NEW: VendorState = { status: 'new' };
const TIDEWELL: VendorState = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };

test('the name lookups: by display name — and the name QuickBooks gives an inactive vendor — at most 2 a form, and by company name, at most 2, active or not; a new vendor’s checks at most 1; similar names by one word, at most 3', () => {
  assert.equal(
    vendorByName('Harrowgate Office Supply'),
    "SELECT * FROM Vendor WHERE DisplayName IN ('Harrowgate Office Supply', 'Harrowgate Office Supply (deleted)') AND Active IN (true, false) MAXRESULTS 4",
  );
  assert.equal(
    vendorByCompanyName('Acme Supplies, Inc.'),
    "SELECT * FROM Vendor WHERE CompanyName = 'Acme Supplies, Inc.' AND Active IN (true, false) MAXRESULTS 2",
  );
  assert.equal(
    customerByName('Acme Supplies'),
    "SELECT * FROM Customer WHERE DisplayName = 'Acme Supplies' AND Active IN (true, false) MAXRESULTS 1",
  );
  assert.equal(
    employeeByName('Sam Lee'),
    "SELECT * FROM Employee WHERE DisplayName = 'Sam Lee' AND Active IN (true, false) MAXRESULTS 1",
  );
  assert.equal(
    similarVendorsQuery('acme'),
    "SELECT * FROM Vendor WHERE DisplayName LIKE '%acme%' AND Active IN (true, false) MAXRESULTS 3",
  );
  assert.deepEqual(MAX_RESULTS, {
    vendor: 2,
    nameClash: 1,
    similar: 3,
    records: 3,
    journalEntries: 10,
    windowExpenses: 50,
    openBills: 40,
  });
});

test("a name is escaped as Intuit reads it: O'Brien & Sons, a backslash written four times, a double quote (sandbox G4–5)", () => {
  assert.equal(
    vendorByName("O'Brien & Sons"),
    "SELECT * FROM Vendor WHERE DisplayName IN ('O\\'Brien & Sons', 'O\\'Brien & Sons (deleted)') AND Active IN (true, false) MAXRESULTS 4",
  );
  assert.equal(
    vendorByName('A\\B Supply'),
    "SELECT * FROM Vendor WHERE DisplayName IN ('A\\\\\\\\B Supply', 'A\\\\\\\\B Supply (deleted)') AND Active IN (true, false) MAXRESULTS 4",
  );
  assert.ok(vendorByName('Say "Hi" Co').includes(`'Say "Hi" Co'`));
  assert.ok(
    numberSearch(doc(bill({ documentNumber: "O'B-7\\" })), VENDOR).query.includes(
      "DocNumber = 'O\\'B-7\\\\\\\\'",
    ),
  );
});

test('the similar-names word: the first distinctive word, legal forms and fillers dropped', () => {
  const cases: [string, string | null][] = [
    ['Acme Supplies, Inc.', 'acme'],
    ['The Home Depot', 'home'],
    ["O'Brien Plumbing LLC", 'brien'],
    ['Amazon.com Services LLC', 'amazon'],
    ['3M Company', '3m'],
    ['A & B Co', null],
    ['Société Générale', 'société'],
    // Digits alone are passed over for a word, and taken only as the fallback of 2 or more.
    ['2024 Acme Ltd', 'acme'],
    ['2024 Holdings Ltd', '2024'],
  ];
  for (const [name, word] of cases) assert.equal(distinctiveWord(name), word, name);
});

test('a bill: its number among all bills, its total and date from the vendor (any vendor when new), an expense with its number, an expense near its dates (D32)', () => {
  const document = doc(bill());
  assert.deepEqual(numberSearch(document, VENDOR), {
    entity: 'Bill',
    maxResults: 3,
    query: "SELECT * FROM Bill WHERE DocNumber = 'HOS-1042' MAXRESULTS 3",
  });
  assert.equal(
    amountSearch(document, VENDOR, 'amount').query,
    "SELECT * FROM Bill WHERE TotalAmt = '413.34' AND TxnDate = '2026-09-14' AND VendorRef = '7' MAXRESULTS 3",
  );
  assert.equal(
    amountSearch(document, NEW, 'amount').query,
    "SELECT * FROM Bill WHERE TotalAmt = '413.34' AND TxnDate = '2026-09-14' MAXRESULTS 3",
  );
  assert.equal(
    relatedSearch(document, VENDOR, 'amount').query,
    "SELECT * FROM Purchase WHERE DocNumber = 'HOS-1042' MAXRESULTS 3",
  );
  // From 1 day before its date to 20 days after its due date (2026-10-14).
  assert.equal(
    otherRecordSearch(document).query,
    "SELECT * FROM Purchase WHERE TotalAmt = '413.34' AND TxnDate >= '2026-09-13' AND TxnDate <= '2026-11-03' MAXRESULTS 3",
  );
  // No due date: 20 days after its date.
  assert.equal(
    otherRecordSearch(doc(bill({ dueDate: null, paymentTermsDays: null }))).query,
    "SELECT * FROM Purchase WHERE TotalAmt = '413.34' AND TxnDate >= '2026-09-13' AND TxnDate <= '2026-10-04' MAXRESULTS 3",
  );
});

test('a company receipt: the seller’s bill with its number, the bank-feed expenses (D21; S4), a bill for its total, newest first, and a reimbursement in the window (D32)', () => {
  const document = doc(receipt());
  assert.equal(
    numberSearch(document, TIDEWELL).query,
    "SELECT * FROM Bill WHERE DocNumber = '55120' AND VendorRef = '9' MAXRESULTS 3",
  );
  assert.deepEqual(feedWindow('2026-09-27'), { from: '2026-09-26', to: '2026-10-17' });
  assert.equal(
    amountSearch(document, TIDEWELL, 'amount').query,
    "SELECT * FROM Purchase WHERE TotalAmt = '60.63' AND TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' MAXRESULTS 3",
  );
  assert.deepEqual(amountSearch(document, NEW, 'window'), {
    entity: 'Purchase',
    maxResults: 50,
    query:
      "SELECT * FROM Purchase WHERE TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' ORDERBY TxnDate DESC MAXRESULTS 50",
  });
  assert.equal(
    relatedSearch(document, NEW, 'amount').query,
    "SELECT * FROM Bill WHERE TotalAmt = '60.63' ORDERBY TxnDate DESC MAXRESULTS 3",
  );
  assert.equal(
    otherRecordSearch(document).query,
    "SELECT * FROM JournalEntry WHERE TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' MAXRESULTS 10",
  );
});

test('a card refund: vendor credits with its number, the card feed (D21; S4), and the original bill from the linked vendor', () => {
  const document = doc(sampleAnswer('card-refund'));
  assert.equal(
    numberSearch(document, TIDEWELL).query,
    "SELECT * FROM VendorCredit WHERE DocNumber = 'R-6603' MAXRESULTS 3",
  );
  assert.equal(
    amountSearch(document, TIDEWELL, 'amount').query,
    "SELECT * FROM Purchase WHERE TotalAmt = '23.72' AND TxnDate >= '2026-10-01' AND TxnDate <= '2026-10-22' MAXRESULTS 3",
  );
  assert.equal(
    amountSearch(document, TIDEWELL, 'window').query,
    "SELECT * FROM Purchase WHERE TxnDate >= '2026-10-01' AND TxnDate <= '2026-10-22' ORDERBY TxnDate DESC MAXRESULTS 50",
  );
  assert.equal(
    relatedSearch(document, TIDEWELL, 'amount').query,
    "SELECT * FROM Bill WHERE DocNumber = '55120' AND VendorRef = '9' MAXRESULTS 3",
  );
});

test("a vendor credit: its number and its total and date among vendor credits — the vendor compared in code — and the original bill from the vendor, by a number a bill's could be", () => {
  const document = doc(creditNote());
  assert.equal(
    numberSearch(document, VENDOR).query,
    "SELECT * FROM VendorCredit WHERE DocNumber = 'CM-0077' MAXRESULTS 3",
  );
  assert.equal(
    amountSearch(document, VENDOR, 'amount').query,
    "SELECT * FROM VendorCredit WHERE TotalAmt = '203.20' AND TxnDate = '2026-09-22' MAXRESULTS 3",
  );
  assert.equal(
    relatedSearch(document, VENDOR, 'amount').query,
    "SELECT * FROM Bill WHERE DocNumber = 'HOS-1042' AND VendorRef = '7' MAXRESULTS 3",
  );
  // 21 characters, the most a bill's number holds; a longer one is never searched (`lookupUses`).
  const most = 'L'.repeat(21);
  assert.equal(
    relatedSearch(doc(creditNote({ originalInvoiceNumber: most })), VENDOR, 'amount').query,
    `SELECT * FROM Bill WHERE DocNumber = '${most}' AND VendorRef = '7' MAXRESULTS 3`,
  );
});

test('paid personally: a bill document’s number; an employee’s or owner’s entries on the day; a contractor’s bills; the company charge (hold 7; S4)', () => {
  const employee = doc(receipt(), paidBy('employee', { paidFrom: null }));
  assert.equal(
    amountSearch(employee, null, 'amount').query,
    "SELECT * FROM JournalEntry WHERE TxnDate = '2026-09-27' MAXRESULTS 10",
  );
  assert.equal(
    relatedSearch(employee, null, 'amount').query,
    "SELECT * FROM Purchase WHERE TotalAmt = '60.63' AND TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' MAXRESULTS 3",
  );
  assert.equal(
    relatedSearch(employee, null, 'window').query,
    "SELECT * FROM Purchase WHERE TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' ORDERBY TxnDate DESC MAXRESULTS 50",
  );
  const owner = doc(bill(), paidBy('owner', { paidFrom: null }));
  assert.equal(
    numberSearch(owner, null).query,
    "SELECT * FROM Bill WHERE DocNumber = 'HOS-1042' MAXRESULTS 3",
  );
  const samLee: VendorState = { ...VENDOR, id: '31', displayName: 'Sam Lee', vendor1099: true };
  const contractor = doc(receipt(), paidBy('not_employee', { paidFrom: null }));
  assert.equal(
    amountSearch(contractor, samLee, 'amount').query,
    "SELECT * FROM Bill WHERE TotalAmt = '60.63' AND TxnDate = '2026-09-27' AND VendorRef = '31' MAXRESULTS 3",
  );
});

test("a statement: this vendor's bills among the listed invoice numbers, each once, one row more than numbers; and its open bills", () => {
  const document = doc(statement());
  assert.deepEqual(numberSearch(document, VENDOR), {
    entity: 'Bill',
    maxResults: 4,
    query:
      "SELECT * FROM Bill WHERE DocNumber IN ('HOS-1031', 'HOS-1042', 'HOS-1050') AND VendorRef = '7' MAXRESULTS 4",
  });
  assert.deepEqual(amountSearch(document, VENDOR, 'amount'), {
    entity: 'Bill',
    maxResults: 40,
    query: "SELECT * FROM Bill WHERE Balance > '0.00' AND VendorRef = '7' MAXRESULTS 40",
  });
  // A number listed twice, in two cases, is asked for once: Intuit compares without case.
  const twice = statement({
    listedItems: [
      { reference: 'HOS-1031', amount: 380, kind: 'invoice' },
      { reference: 'hos-1031', amount: 380, kind: 'invoice' },
      { reference: 'PMT-1', amount: -380, kind: 'payment' },
    ],
    total: 380,
  });
  assert.deepEqual(listedInvoiceNumbers(doc(twice)), ['HOS-1031']);
  assert.equal(
    numberSearch(doc(twice), VENDOR).query,
    "SELECT * FROM Bill WHERE DocNumber IN ('HOS-1031') AND VendorRef = '7' MAXRESULTS 2",
  );
  // A listed number longer than a bill's 21 characters is left out: no bill can have it.
  const long = `HOS-${'0'.repeat(18)}42`;
  const withLong = statement({
    listedItems: [
      { reference: 'HOS-1031', amount: 380, kind: 'invoice' },
      { reference: long, amount: 10, kind: 'invoice' },
      { reference: 'O'.repeat(21), amount: 10, kind: 'invoice' },
    ],
    total: 400,
  });
  assert.equal(
    numberSearch(doc(withLong), VENDOR).query,
    `SELECT * FROM Bill WHERE DocNumber IN ('HOS-1031', '${'O'.repeat(21)}') AND VendorRef = '7' MAXRESULTS 3`,
  );
  // Forty listed invoices: forty numbers and 41 rows, within one answer (sandbox S9).
  const forty = statement({
    listedItems: Array.from({ length: 40 }, (_, index) => ({
      reference: `HOS-${2000 + index}`,
      amount: 10,
      kind: 'invoice',
    })),
    listedItemsComplete: false,
    total: 400,
  });
  assert.equal(numberSearch(doc(forty), VENDOR).maxResults, 41);
});

test('no query holds OR, and no transaction search asks for Active', () => {
  const documents = [
    doc(bill()),
    doc(receipt()),
    doc(sampleAnswer('card-refund')),
    doc(creditNote()),
    doc(statement()),
  ];
  const queries = [
    ...documents.flatMap((document) => [
      numberSearch(document, VENDOR).query,
      amountSearch(document, VENDOR, 'amount').query,
      amountSearch(document, VENDOR, 'window').query,
    ]),
    otherRecordSearch(documents[0]!).query,
    otherRecordSearch(documents[1]!).query,
  ];
  for (const query of queries) {
    assert.ok(!/\bOR\b/u.test(query), query);
    assert.ok(!query.includes('Active'), query);
  }
});
