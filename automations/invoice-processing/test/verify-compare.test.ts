import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { secondReadOf, type SecondRead } from '../src/checks/answers.js';
import type { CheckInput } from '../src/checks/check.js';
import { COMPARED_FIELDS } from '../src/checks/fields.js';
import { compareReads, recheckedWith } from '../src/reads/compare.js';
import type { DocumentState } from '../src/state.js';
import {
  bill,
  check,
  creditNote,
  documentOf,
  receipt,
  sampleAnswer,
  statement,
} from './check-world.js';
import { secondAnswer } from './fixtures.js';

/**
 * The agreement gate (the plan's §4 table; Group 2's D3–D4, Group 3's D8–D9): the fields each
 * route compares, exact after the same cleaning — the seller roughly — spend type disputed but
 * never held, a statement's type alone, and the arithmetic tie-break with its re-check.
 */

function second(answer: JsonObject, changes: JsonObject = {}): SecondRead {
  const read = secondReadOf(secondAnswer(answer, changes));
  assert.ok(read, 'a second read of the schema');
  return read;
}

function compared(answer: JsonObject, changes: JsonObject, options: Partial<CheckInput> = {}) {
  const document = documentOf(check(answer, options));
  return { document, comparison: compareReads(document, second(answer, changes)) };
}

const differs = (answer: JsonObject, changes: JsonObject, options: Partial<CheckInput> = {}) =>
  compared(answer, changes, options).comparison.differences.map((difference) => difference.field);

test("the fields each route compares: the plan's §4 table", () => {
  const core = [
    'documentType',
    'vendorName',
    'documentNumber',
    'documentDate',
    'currency',
    'total',
  ];
  assert.deepEqual(COMPARED_FIELDS.bill, [...core, 'dueDate', 'amountDue', 'spendType']);
  assert.deepEqual(COMPARED_FIELDS.company_receipt, [
    ...core,
    'amountDue',
    'paymentMethod',
    'cardLast4',
    'cashBackPrinted',
    'spendType',
  ]);
  assert.deepEqual(COMPARED_FIELDS.vendor_credit, [...core, 'refundMethod', 'spendType']);
  assert.deepEqual(COMPARED_FIELDS.card_refund, [
    ...core,
    'cardLast4',
    'refundMethod',
    'spendType',
  ]);
  assert.deepEqual(COMPARED_FIELDS.statement, ['documentType']);
});

test('two reads of the same document agree on every route', () => {
  const cases: [JsonObject, Partial<CheckInput>?][] = [
    [bill()],
    [receipt()],
    [creditNote()],
    [sampleAnswer('card-refund')],
    [statement()],
  ];
  for (const [answer, options] of cases) {
    const { document, comparison } = compared(answer, {}, options);
    assert.deepEqual(comparison.differences, [], document.route);
    assert.deepEqual([comparison.totalPicked, comparison.spendTypeDisputed], [null, false]);
    assert.deepEqual(comparison.compared, COMPARED_FIELDS[document.route]);
  }
});

test('each field a route writes holds when the reads part; a field it does not write is never compared', () => {
  assert.deepEqual(differs(bill(), { vendorName: 'Harrowgate Office Supplies' }), ['vendorName']);
  assert.deepEqual(differs(bill(), { documentNumber: 'HOS-1043' }), ['documentNumber']);
  assert.deepEqual(differs(bill(), { documentDate: '2026-09-15' }), ['documentDate']);
  assert.deepEqual(differs(bill(), { currency: null }), ['currency']);
  assert.deepEqual(differs(bill(), { dueDate: null }), ['dueDate']);
  assert.deepEqual(differs(bill(), { amountDue: 413.34 }), ['amountDue']);
  assert.deepEqual(differs(bill(), { documentType: 'receipt' }), ['documentType']);
  // A bill does not write a payment method, card digits or cash back.
  assert.deepEqual(
    differs(bill(), { paymentMethod: 'cash', cardLast4: '9999', cashBackPrinted: true }),
    [],
  );
  assert.deepEqual(differs(receipt(), { paymentMethod: 'cash' }), ['paymentMethod']);
  assert.deepEqual(differs(receipt(), { cardLast4: '9999' }), ['cardLast4']);
  assert.deepEqual(differs(receipt(), { cashBackPrinted: true }), ['cashBackPrinted']);
  // A receipt has no due date to compare.
  assert.deepEqual(differs(receipt(), { dueDate: '2026-10-30' }), []);
  assert.deepEqual(differs(creditNote(), { refundMethod: 'refund_to_card' }), ['refundMethod']);
  assert.deepEqual(differs(creditNote(), { cardLast4: '4417' }), [], 'a vendor credit has no card');
  assert.deepEqual(differs(sampleAnswer('card-refund'), { cardLast4: '1111' }), ['cardLast4']);
  // A statement: its type alone.
  assert.deepEqual(differs(statement(), { vendorName: 'Somebody Else', total: 1 }), []);
  assert.deepEqual(differs(statement(), { documentType: 'bill' }), ['documentType']);
});

test('exact after the same cleaning: case, spaces and signs that cleaning settles are not differences', () => {
  assert.deepEqual(
    differs(bill(), {
      vendorName: '  HARROWGATE office supply, inc. ',
      documentNumber: ' HOS-1042 ',
      documentDate: ' 2026-09-14 ',
      currency: 'usd',
      total: 413.340000001,
    }),
    [],
  );
  assert.deepEqual(differs(receipt(), { cardLast4: ' 4417 ' }), []);
  // A credit read with or without its minus sign is the same credit.
  assert.deepEqual(differs(creditNote(), { total: 203.2 }), []);
  assert.deepEqual(differs(creditNote(), { refundMethod: 'credit_on_account' }), []);
  // On a credit note, "not applicable" is a refund method not shown.
  assert.deepEqual(
    differs(creditNote({ refundMethod: 'not_shown' }), { refundMethod: 'not_applicable' }),
    [],
  );
  // A due date from the terms is no printed one: read 2's none agrees.
  assert.deepEqual(differs(bill({ dueDate: null, paymentTermsDays: 30 }), { dueDate: null }), []);
  // Unclear on both sides is the same unclear; the number's case is not cleaned away.
  assert.deepEqual(differs(receipt({ cardLast4: '**17' }), { cardLast4: 'xx17' }), []);
  assert.deepEqual(differs(bill(), { documentNumber: 'hos-1042' }), ['documentNumber']);
  assert.deepEqual(differs(bill(), { currency: 'US$' }), ['currency']);
});

test('spend type disputed: the default category is used, and the run is not held for it (D27)', () => {
  const { comparison } = compared(bill(), { spendType: 'materials' });
  assert.deepEqual([comparison.differences, comparison.spendTypeDisputed], [[], true]);
});

test('where they part, both values as a person reads them', () => {
  const { comparison } = compared(receipt(), {
    total: 66.63,
    documentDate: '2026-02-30',
    paymentMethod: 'bank_transfer',
    documentType: 'credit_note',
  });
  assert.deepEqual(comparison.differences, [
    { field: 'documentType', first: 'receipt', second: 'credit note' },
    { field: 'documentDate', first: '2026-09-27', second: 'not a valid date' },
    { field: 'total', first: '$60.63', second: '$66.63' },
    { field: 'paymentMethod', first: 'card', second: 'bank transfer' },
  ]);
  const statementType = compared(statement(), { documentType: 'supplier_statement' }).comparison;
  assert.deepEqual(statementType.differences, []);
  const none = compared(bill(), { vendorName: null, total: 1e22 }).comparison;
  assert.deepEqual(none.differences, [
    { field: 'vendorName', first: 'Harrowgate Office Supply', second: 'none' },
    { field: 'total', first: '$413.34', second: 'too large to read' },
  ]);
});

test("the tie-break (D4): the totals differ — the second read's is recorded only when it alone adds up", () => {
  // The first read misread its total; the second's adds up to the parts and lines.
  const misread = bill({ total: 431.34 });
  const picked = compared(misread, { total: 413.34 }).comparison;
  assert.deepEqual([picked.totalPicked, picked.secondTotalCents], ['second', 41334]);
  // The first read's adds up: it stands.
  const kept = compared(bill(), { total: 431.34 }).comparison;
  assert.deepEqual([kept.totalPicked, kept.secondTotalCents], ['first', null]);
  // Nothing to add up: the first read's, as designed.
  const bare = bill({ subtotal: null, tax: null, shipping: null, lineItems: [] });
  assert.equal(compared(bare, { total: 413.35 }).comparison.totalPicked, 'first');
  // The second read gave none.
  assert.equal(compared(misread, { total: null }).comparison.totalPicked, 'first');
  // A receipt: the second total adds up WITH the tip; the first does neither way.
  const tipped = sampleAnswer('restaurant-tip-written-total', { total: 50 });
  assert.equal(compared(tipped, { total: 54.47 }).comparison.totalPicked, 'second');
  // A first total printed before the tip adds up too — without it: it stands.
  const before = sampleAnswer('restaurant-tip-written-total', { total: 45.47 });
  assert.equal(compared(before, { total: 54.47 }).comparison.totalPicked, 'first');
});

test('the re-check after the tie-break (D9): the arithmetic follows the recorded total, and a recording rule it meets is said', () => {
  const misread: DocumentState = documentOf(check(bill({ total: 431.34 })));
  assert.ok(misread.findings.includes('amounts_mismatch'));
  const rechecked = recheckedWith(misread, 41334);
  assert.equal(rechecked.rule, undefined);
  assert.deepEqual(
    [rechecked.document.totalCents, rechecked.document.amountCents, rechecked.document.findings],
    [41334, 41334, []],
  );
  assert.deepEqual(
    [rechecked.document.arithmetic.parts, rechecked.document.arithmetic.lines],
    ['passed', 'passed'],
  );
  // Every other value stays the first read's.
  assert.deepEqual(
    { ...rechecked.document, totalCents: 0, amountCents: 0, findings: [], arithmetic: null },
    {
      ...misread,
      totalCents: 0,
      amountCents: 0,
      findings: [],
      arithmetic: null,
    },
  );
  // A receipt's tip follows: the second total printed before it, the tip added and held.
  const receiptMisread = documentOf(
    check(sampleAnswer('restaurant-tip-under-total', { total: 23.48 })),
  );
  const tip = recheckedWith(receiptMisread, 3248);
  assert.equal(tip.rule, undefined);
  assert.deepEqual(
    [tip.document.tip, tip.document.amountCents, tip.document.findings],
    ['added', 3848, ['tip_added']],
  );
  // An amount due now below the recorded charges: C15, which keeps it out of QuickBooks; the
  // document still follows the new total, for its details.
  const due = documentOf(check(bill({ total: 400, amountDue: 400, subtotal: 370.75 })));
  const stopped = recheckedWith(due, 41334);
  assert.deepEqual([stopped.rule, stopped.document.totalCents], ['C15', 41334]);
  // An earlier balance follows the new total.
  const earlier = documentOf(check(bill({ total: 400, amountDue: 500 })));
  const followed = recheckedWith(earlier, 41334);
  assert.equal(followed.rule, undefined);
  assert.equal(followed.document.earlierBalanceCents, 8666);
});
