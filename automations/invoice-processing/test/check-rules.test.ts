import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { CheckInput } from '../src/checks/check.js';
import {
  CHECK_DOCUMENT_REASONS,
  CHECK_DOCUMENT_SENTENCES,
  CHECK_RULE_ORDER,
  type CheckRule,
} from '../src/checks/rules.js';
import {
  CHECKING,
  bill,
  check,
  creditNote,
  documentOf,
  paidBy,
  receipt,
  ruleOf,
  statement,
} from './check-world.js';

/**
 * check-document's fail rules (the plan's §2.3, §2.9 "Fail sentences"): each sentence exact, at
 * most 200 characters and ending "Nothing was created."; each rule met by one answer, in its place
 * in the order; the first match wins.
 */

test('the 28 sentences, word for word as the plan gives them', () => {
  assert.deepEqual(
    CHECK_RULE_ORDER,
    Array.from({ length: 28 }, (_, index) => `C${index + 1}`),
  );
  assert.deepEqual(Object.keys(CHECK_DOCUMENT_SENTENCES), CHECK_RULE_ORDER);
  assert.deepEqual(Object.keys(CHECK_DOCUMENT_REASONS), CHECK_RULE_ORDER);
  const plan: Record<CheckRule, string> = {
    C1: 'This looks like a bank or card statement. Upload each receipt or bill on its own, and use the statement to reconcile in QuickBooks.',
    C2: 'This looks like a quote, not a bill or a receipt.',
    C3: 'This looks like a purchase order, not a bill or a receipt.',
    C4: "This doesn't look like a bill, receipt, credit note or statement.",
    C5: 'This file holds no document or more than one. Upload one bill, receipt, credit note or statement per run.',
    C6: 'Pages of this document are missing. Upload the whole document as one file.',
    C7: "A credit note can't be marked as paid with your own money. Run it again with that switched off.",
    C8: "The seller's name could not be read. Try a clearer photo or the PDF.",
    C9: "The seller's name is longer than QuickBooks allows. Enter this by hand.",
    C10: 'This document was issued by your own company, so there is nothing to record.',
    C11: 'The total could not be read. Try a clearer photo or the PDF.',
    C12: 'The total is zero or less, so there is nothing to record.',
    C13: 'The total is larger than QuickBooks accepts.',
    C14: 'The document number could not be read cleanly. Try a clearer photo or the PDF.',
    C15: "The amount due is less than this bill's charges, so some or all of it may already be paid or credited. Enter it by hand.",
    C16: "This receipt includes cash back, which isn't an expense. Enter it by hand in QuickBooks.",
    C17: "This receipt shows an amount still owed, so it isn't fully paid. Enter it by hand.",
    C18: "Set 'Paid from' in this flow's settings before recording a receipt the company paid, then run it again.",
    C19: 'This credit was refunded by check or cash. Enter it by hand: a bank deposit for an expense, or for a paid bill a vendor credit plus a deposit to A/P, linked in Pay bills.',
    C20: "This is a refund to a card, but 'Paid from' isn't a credit card account. Enter it by hand in QuickBooks.",
    C21: "The document's date could not be read. Try a clearer photo or the PDF.",
    C22: "The document's date is not a valid date. Try a clearer photo or the PDF.",
    C23: 'The document is dated in the future.',
    C24: 'The due date is not a valid date. Try a clearer photo or the PDF.',
    C25: "The due date is before the bill's date.",
    C26: 'Nothing on this statement could be read. Try a clearer photo or the PDF.',
    C27: "The name in 'Who paid' is the seller on this document. Type the name of the person who paid, then run it again.",
    C28: 'A tip is written on this receipt, and nothing on it shows whether the total includes it. Write the final total on it, then upload it again.',
  };
  for (const rule of CHECK_RULE_ORDER) {
    const sentence = CHECK_DOCUMENT_SENTENCES[rule];
    assert.equal(sentence, `${plan[rule]} Nothing was created.`, rule);
    assert.ok(sentence.length <= 200, `${rule}: ${sentence.length}`);
  }
  // The plan counted C19 at 191 characters, its longest.
  assert.equal(CHECK_DOCUMENT_SENTENCES.C19.length, 191);
});

const SAM = { route: 'not_employee' as const, employeeId: null, account: null };

/** Each rule, one answer — or several — that meets it first. */
const CASES: readonly (readonly [CheckRule, JsonObject, Partial<CheckInput>?])[] = [
  ['C1', bill({ documentType: 'bank_statement' })],
  ['C2', bill({ documentType: 'quote' })],
  ['C3', bill({ documentType: 'purchase_order' })],
  ['C4', bill({ documentType: 'other' })],
  ['C5', bill({ documentCount: 0 })],
  ['C5', bill({ documentCount: 2 })],
  ['C6', bill({ pagesMissing: true })],
  ['C7', creditNote(), paidBy('employee')],
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
  ['C18', receipt(), { paidFrom: null }],
  ['C19', creditNote({ refundMethod: 'refund_by_check_or_cash' })],
  ['C20', creditNote({ refundMethod: 'refund_to_card' }), { paidFrom: CHECKING }],
  ['C20', creditNote({ refundMethod: 'refund_to_card' }), { paidFrom: null }],
  ['C21', bill({ documentDate: null })],
  ['C22', bill({ documentDate: '2026-02-30' })],
  ['C22', bill({ documentDate: '1999-12-31' })],
  ['C22', bill({ documentDate: '2026-1-05' })],
  ['C23', bill({ documentDate: '2026-10-13', dueDate: '2026-11-13' })],
  ['C24', bill({ dueDate: '2026-13-01' })],
  ['C25', bill({ dueDate: '2026-09-01' })],
  ['C26', statement({ listedItems: [], total: null })],
  ['C27', bill(), { switchOn: true, payer: { ...SAM, name: 'HARROWGATE  office supply' } }],
  ['C27', receipt(), { switchOn: true, payer: { ...SAM, name: 'tidewell hardware' } }],
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

test('the first match wins', () => {
  // A credit note with the switch on and no seller: C7 comes before C8.
  assert.equal(ruleOf(check(creditNote({ vendorName: null }), paidBy('owner'))), 'C7');
  // A quote holding two documents: the type first.
  assert.equal(ruleOf(check(bill({ documentType: 'quote', documentCount: 2 }))), 'C2');
  // No total and no date: the total first.
  assert.equal(ruleOf(check(bill({ total: null, documentDate: null }))), 'C11');
  // Cash back and no Paid from: cash back first.
  assert.equal(ruleOf(check(receipt({ cashBackPrinted: true }), { paidFrom: null })), 'C16');
  // Refunded by check, and no total: the total first.
  assert.equal(
    ruleOf(check(creditNote({ refundMethod: 'refund_by_check_or_cash', total: null }))),
    'C11',
  );
  // A statement holding two: C5 before C26.
  assert.equal(ruleOf(check(statement({ documentCount: 2, listedItems: [], total: null }))), 'C5');
  // The seller's name past 500 and the company's own: the length first.
  assert.equal(ruleOf(check(bill({ vendorName: `Sample Bakery ${'x'.repeat(500)}` }))), 'C9');
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
  // C18 and C20 only where they apply: the switch on needs no Paid from; a card refund a card.
  assert.equal(ruleOf(check(receipt(), paidBy('employee', { paidFrom: null }))), 'ok');
  assert.equal(ruleOf(check(creditNote({ refundMethod: 'refund_to_card' }))), 'ok');
  // C23: tomorrow passes (time zones), two days ahead fails.
  assert.equal(ruleOf(check(bill({ documentDate: '2026-10-12', dueDate: null }))), 'ok');
  // C24 and C25 are a bill's: a receipt's printed due date is not read.
  assert.equal(ruleOf(check(receipt({ dueDate: '2026-13-01' }))), 'ok');
  assert.equal(ruleOf(check(bill({ dueDate: '2026-09-14' }))), 'ok', 'due the same day');
  // C26: rows, or a balance, are enough to compare.
  assert.equal(ruleOf(check(statement({ listedItems: [] }))), 'ok');
  assert.equal(ruleOf(check(statement({ total: null }))), 'ok');
  // C27 only with the switch on; and a statement ignores the switch.
  assert.equal(ruleOf(check(receipt({ vendorName: 'Sam Lee' }))), 'ok');
  assert.equal(
    ruleOf(check(receipt(), { switchOn: false, payer: { ...SAM, name: 'Tidewell Hardware' } })),
    'ok',
    'the switch off: no one paid personally, whatever was kept',
  );
  assert.equal(
    ruleOf(
      check(statement({ vendorName: 'Sam Lee' }), {
        switchOn: true,
        payer: { ...SAM, name: 'Sam Lee' },
      }),
    ),
    'ok',
  );
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
