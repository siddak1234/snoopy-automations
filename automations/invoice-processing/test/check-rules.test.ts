import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { CheckInput } from '../src/checks/check.js';
import {
  CHECK_RULE_ORDER,
  DOCUMENT_RULES,
  RECORDING_RULES,
  type CheckRule,
} from '../src/checks/rules.js';
import { NOT_RECORDED } from '../src/quickbooks-path.js';
import { DOUBTS } from '../src/run/words.js';
import {
  NONE_PATH,
  bill,
  check,
  creditNote,
  documentOf,
  receipt,
  ruleOf,
  statement,
} from './check-world.js';

/**
 * The checks' rules (the plan's §2.3, as v2's §2.6 splits them and v3 keeps them): the rules a
 * document cannot be used under as read, each holding it for a second read and, still unclear, for
 * review in the words below (B4) — never failing the run; C1–C5 gone (AM1, AM8); the rules
 * QuickBooks cannot record it under, each a reason the details are saved with, weighed on the
 * QuickBooks path alone; each rule met by one answer, in its place in the order; the first of each
 * kind wins.
 */

test("the rules v2 keeps, in the plan's order, each with the spec's words", () => {
  const v2 = [6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 21, 22, 23, 24, 25, 26, 28];
  assert.deepEqual(
    CHECK_RULE_ORDER,
    v2.map((n) => `C${n}`),
  );
  assert.deepEqual([...DOCUMENT_RULES], ['C6', 'C8', 'C11', 'C21', 'C22', 'C26']);
  assert.deepEqual(Object.keys(RECORDING_RULES), [
    'C9',
    'C10',
    'C12',
    'C13',
    'C14',
    'C15',
    'C16',
    'C17',
    'C19',
    'C23',
    'C24',
    'C25',
    'C28',
  ]);
  // B4's waiting reasons, word for word.
  assert.deepEqual(
    DOCUMENT_RULES.map((rule) => DOUBTS[rule]),
    [
      'pages may be missing',
      "the seller's name can't be read",
      "the total can't be read",
      "the date can't be read",
      "the date isn't a real date",
      'nothing on this statement can be read',
    ],
  );
  assert.deepEqual(
    Object.values(RECORDING_RULES).map((reason) => NOT_RECORDED[reason]),
    [
      "the vendor's name is too long",
      'your own company issued it',
      'the total is zero',
      'the total is too large',
      'the number is too long',
      'part may already be paid',
      'it includes cash back',
      'money is still owed',
      'refunded by check or cash',
      "it's dated in the future",
      "the due date can't be read",
      'the due date is before the date',
      'unclear if the total includes the tip',
    ],
  );
});

/** Each rule, one answer — or several — that meets it first. */
const CASES: readonly (readonly [CheckRule, JsonObject, Partial<CheckInput>?])[] = [
  ['C6', bill({ pagesMissing: true })],
  ['C8', bill({ vendorName: null })],
  ['C8', bill({ vendorName: ' \n ' })],
  ['C8', bill({ vendorName: '​' })],
  ['C9', bill({ vendorName: 'A'.repeat(501) })],
  ['C10', bill({ vendorName: 'SAMPLE  BAKERY' })],
  ['C10', bill({ vendorName: 'sample bakery llc' })],
  ['C11', bill({ total: null })],
  ['C12', bill({ total: 0, subtotal: null, lineItems: [] })],
  ['C12', bill({ total: -5 })],
  ['C12', receipt({ total: -60.63 })],
  ['C12', bill({ total: -1e22 })],
  ['C13', bill({ total: 10_000_000_000 })],
  ['C13', bill({ total: 1e21 })],
  [
    'C13',
    receipt({
      subtotal: 9_999_999_999.99,
      tax: null,
      total: 9_999_999_999.99,
      tip: 5,
      lineItems: [],
    }),
  ],
  ['C14', bill({ documentNumber: 'N'.repeat(101) })],
  ['C15', bill({ amountDue: 400 })],
  ['C15', bill({ amountDue: 0 })],
  ['C16', receipt({ cashBackPrinted: true })],
  ['C17', receipt({ amountDue: 5 })],
  ['C19', creditNote({ refundMethod: 'refund_by_check_or_cash' })],
  ['C21', bill({ documentDate: null })],
  ['C22', bill({ documentDate: '2026-02-30' })],
  ['C22', bill({ documentDate: '1999-12-31' })],
  ['C22', bill({ documentDate: '2026-1-05' })],
  ['C23', bill({ documentDate: '2026-10-13', dueDate: '2026-11-13' })],
  ['C24', bill({ dueDate: '2026-13-01' })],
  ['C25', bill({ dueDate: '2026-09-01' })],
  ['C26', statement({ listedItems: [], total: null })],
  ['C28', receipt({ subtotal: null, tax: null, lineItems: [], tip: 7 })],
];

test('each rule is met by its answer, and only it, in its place in the order', () => {
  const met = new Set<string>();
  for (const [rule, answer, options] of CASES) {
    assert.equal(
      ruleOf(check(answer, options)),
      rule,
      `${rule}: ${JSON.stringify(answer).slice(0, 80)}`,
    );
    met.add(rule);
  }
  assert.deepEqual([...met], CHECK_RULE_ORDER, 'every rule met, in order');
});

test('the first match of each kind wins, and a document that cannot be used wins over one QuickBooks cannot take', () => {
  // One document's read counts one document, whatever the file holds (C5 is gone, AM1).
  assert.equal(ruleOf(check(bill({ documentCount: 3 }))), 'ok');
  // No total and no date: the total first.
  assert.equal(ruleOf(check(bill({ total: null, documentDate: null }))), 'C11');
  // Refunded by check, and no total: the total, which no path can use.
  assert.equal(
    ruleOf(check(creditNote({ refundMethod: 'refund_by_check_or_cash', total: null }))),
    'C11',
  );
  // A statement with nothing to read: C26.
  assert.equal(ruleOf(check(statement({ listedItems: [], total: null }))), 'C26');
  // The seller's name past 500 and the company's own: the length first.
  assert.equal(ruleOf(check(bill({ vendorName: `Sample Bakery ${'x'.repeat(500)}` }))), 'C9');
  // Cash back and no date: the date, which no path can use, over what QuickBooks cannot take.
  assert.equal(ruleOf(check(receipt({ cashBackPrinted: true, documentDate: null }))), 'C21');
});

test('with the vendor "None" no recording rule is weighed: the document is kept as read', () => {
  for (const [rule, answer] of CASES) {
    const outcome = check(answer, NONE_PATH);
    if ((DOCUMENT_RULES as readonly string[]).includes(rule)) {
      assert.equal(ruleOf(outcome), rule, `${rule} fails on either path`);
    } else {
      assert.equal(ruleOf(outcome), 'ok', `${rule} is QuickBooks' alone`);
    }
  }
});

test('the edges each rule leaves alone', () => {
  // C10 compares cleaned names without case, and nothing more: "Sample Bakery, LLC" is another.
  assert.equal(ruleOf(check(bill({ vendorName: 'Sample Bakery, LLC' }))), 'ok');
  assert.equal(ruleOf(check(bill(), { legalName: null })), 'ok');
  // C14: 100 characters are read; only 1–21 can be QuickBooks' own number.
  const hundred = documentOf(check(bill({ documentNumber: 'N'.repeat(100) })));
  assert.equal(hundred.numberUsable, false);
  assert.equal(documentOf(check(bill({ documentNumber: 'N'.repeat(21) }))).numberUsable, true);
  // C15: an amount due equal to the charges, or none printed.
  assert.equal(ruleOf(check(bill({ amountDue: 413.34 }))), 'ok');
  assert.equal(ruleOf(check(bill({ amountDue: null }))), 'ok');
  // C17: a receipt showing nothing left to pay.
  assert.equal(ruleOf(check(receipt({ amountDue: 0 }))), 'ok');
  // C23: tomorrow passes (time zones), two days ahead fails.
  assert.equal(ruleOf(check(bill({ documentDate: '2026-10-12', dueDate: null }))), 'ok');
  // C24 and C25 are a bill's: a receipt's printed due date is not read.
  assert.equal(ruleOf(check(receipt({ dueDate: '2026-13-01' }))), 'ok');
  assert.equal(ruleOf(check(bill({ dueDate: '2026-09-14' }))), 'ok', 'due the same day');
  // C26: rows, or a balance, are enough to compare.
  assert.equal(ruleOf(check(statement({ listedItems: [] }))), 'ok');
  assert.equal(ruleOf(check(statement({ total: null }))), 'ok');
  // C21–C23 are a record's: a statement needs no date.
  assert.equal(ruleOf(check(statement({ documentDate: null }))), 'ok');
});

test('an answer that is not the schema ends as could-not-be-read: a field missing, or of another type', () => {
  const answer = bill();
  const broken: JsonObject[] = [
    {},
    { ...answer, documentType: 'invoice' },
    { ...answer, documentCount: 1.5 },
    { ...answer, total: '413.34' },
    { ...answer, lineItems: [{ amount: 'x' }] },
    { ...answer, listedItems: [{ reference: 'A', amount: 1, kind: 'refund' }] },
    { ...answer, uncertainFields: 'total' },
    { ...answer, paymentTermsDays: '30' },
  ];
  const { cashBackPrinted: _dropped, ...withoutCashBack } = answer;
  for (const value of [...broken, withoutCashBack, null, 'bill']) {
    assert.equal(ruleOf(check(value)), 'answer_unusable', JSON.stringify(value)?.slice(0, 60));
  }
});
