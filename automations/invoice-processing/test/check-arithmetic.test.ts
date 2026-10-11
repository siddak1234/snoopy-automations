import assert from 'node:assert/strict';
import { test } from 'node:test';

import { amountsOf, totalAgrees } from '../src/checks/arithmetic.js';
import {
  bill,
  check,
  creditNote,
  documentOf,
  receipt,
  ruleOf,
  sampleAnswer,
  statement,
} from './check-world.js';

/**
 * The arithmetic (the plan's §2.5, §2.9 "Arithmetic"), in whole cents within 1¢, in code: the
 * receipts' tip rule, cash back and a balance still owed, the credit sign rule, a utility bill's
 * earlier balance, a statement's own sum, and the parts and lines checks as designed (D2).
 */

const lines = (...amounts: number[]) => amounts.map((amount) => ({ amount }));

test('a receipt with a printed tip, and one with a handwritten tip and total: the total includes it', () => {
  const written = documentOf(check(sampleAnswer('restaurant-tip-written-total')));
  assert.deepEqual(
    [written.tip, written.totalCents, written.amountCents, written.arithmetic.parts],
    ['included', 5447, 5447, 'passed'],
  );
  assert.deepEqual(written.findings, []);
  const printed = documentOf(
    check(receipt({ subtotal: 40, tax: 3.2, tip: 8, total: 51.2, lineItems: lines(40) })),
  );
  assert.deepEqual([printed.tip, printed.amountCents, printed.findings], ['included', 5120, []]);
});

test('a tip written under a total printed before it: the expense is the total plus the tip, and it holds', () => {
  const under = documentOf(check(sampleAnswer('restaurant-tip-under-total')));
  assert.deepEqual(
    [under.tip, under.totalCents, under.tipCents, under.amountCents],
    ['added', 3248, 600, 3848],
  );
  assert.deepEqual(under.findings, ['tip_added']);
  assert.deepEqual([under.arithmetic.parts, under.arithmetic.lines], ['passed', 'passed']);
  // The lines standing in for the subtotal settle it the same way.
  const byLines = documentOf(
    check(
      receipt({ subtotal: null, tax: 2.48, tip: 6, total: 32.48, lineItems: lines(14.5, 6.5, 9) }),
    ),
  );
  assert.deepEqual(
    [byLines.tip, byLines.amountCents, byLines.findings],
    ['added', 3848, ['tip_added']],
  );
});

test('a tip with nothing printed to show whether the total includes it fails (C28); no tip is no question', () => {
  assert.equal(ruleOf(check(sampleAnswer('card-slip-tip-only'))), 'C28');
  const none = documentOf(check(receipt()));
  assert.deepEqual([none.tip, none.amountCents], ['none', 6063]);
  // A tip the parts add up with neither way: amounts don't add up, and the total as read.
  const neither = documentOf(check(receipt({ tip: 4, total: 62 })));
  assert.deepEqual([neither.tip, neither.amountCents], ['neither', 6200]);
  assert.ok(neither.findings.includes('amounts_mismatch'));
  // A tip on a bill is not a receipt's: ignored.
  assert.equal(documentOf(check(bill({ tip: 5 }))).tip, 'none');
});

test('cash back fails (C16); a balance still owed fails (C17)', () => {
  assert.equal(ruleOf(check(sampleAnswer('cash-back-receipt'))), 'C16');
  assert.equal(ruleOf(check(receipt({ amountDue: 60.63 }))), 'C17');
  assert.equal(ruleOf(check(sampleAnswer('paid-invoice'))), 'ok', 'an amount due of 0.00 is paid');
});

test('a credit note printed with minus signs is turned positive, a discount and all, with no false hold', () => {
  const memo = documentOf(check(creditNote()));
  assert.deepEqual(
    [memo.arithmetic.signs, memo.totalCents, memo.amountCents, memo.arithmetic.subtotalCents],
    ['flipped', 20320, 20320, 21390],
  );
  assert.equal(memo.arithmetic.discountCents, 1070, 'the discount stays positive');
  assert.deepEqual([memo.arithmetic.parts, memo.arithmetic.lines], ['passed', 'passed']);
  assert.deepEqual(memo.findings, [], 'no false hold: the discount is not weighed for the sign');
  // Printed positive: as printed.
  const positive = documentOf(
    check(creditNote({ subtotal: 213.9, total: 203.2, lineItems: lines(189, 24.9) })),
  );
  assert.deepEqual(
    [positive.arithmetic.signs, positive.totalCents, positive.findings],
    ['as_printed', 20320, []],
  );
  // The card refund sample: tax and lines negative too.
  const refund = documentOf(check(sampleAnswer('card-refund')));
  assert.deepEqual([refund.route, refund.totalCents, refund.findings], ['card_refund', 2372, []]);
});

test("a credit note with mixed signs: amounts don't add up, its credit taken whole", () => {
  const mixed = documentOf(check(creditNote({ subtotal: 213.9, lineItems: lines(189, 24.9) })));
  assert.equal(mixed.arithmetic.signs, 'mixed');
  assert.equal(mixed.totalCents, 20320, 'the credit, positive');
  assert.deepEqual([mixed.arithmetic.parts, mixed.arithmetic.lines], ['not_run', 'not_run']);
  assert.deepEqual(mixed.findings, ['amounts_mismatch'], 'and not "not cross-checked"');
});

test('a utility bill with an earlier balance holds; with a payment, no hold; part-paid fails (C15)', () => {
  const earlier = documentOf(check(sampleAnswer('utility-statement-balance')));
  assert.deepEqual(
    [earlier.totalCents, earlier.amountCents, earlier.amountDueCents, earlier.earlierBalanceCents],
    [14950, 14950, 20790, 5840],
    "this period's charges are recorded",
  );
  assert.deepEqual(earlier.findings, ['earlier_balance']);
  // The earlier balance paid: the amount due is this period's charges.
  const paid = documentOf(check(sampleAnswer('utility-statement-balance', { amountDue: 149.5 })));
  assert.deepEqual([paid.earlierBalanceCents, paid.findings], [null, []]);
  // Part paid: less due than this period's charges.
  assert.equal(ruleOf(check(sampleAnswer('utility-statement-balance', { amountDue: 100 }))), 'C15');
});

test("a statement's own sum: balance forward + invoices − payments − credits, only when its list is complete", () => {
  const complete = documentOf(check(statement()));
  assert.equal(complete.statement?.complete, true);
  assert.equal(complete.statement?.ownSumCents, 68654);
  assert.equal(complete.totalCents, 68654);
  // Payments and credits subtract whichever sign they were printed with.
  const unsigned = documentOf(
    check(
      statement({
        listedItems: [
          { reference: 'HOS-1031', amount: 380, kind: 'invoice' },
          { reference: 'PMT-1', amount: 100, kind: 'payment' },
          { reference: 'CM-1', amount: 30, kind: 'credit' },
        ],
        total: 250,
      }),
    ),
  );
  assert.equal(unsigned.statement?.ownSumCents, 25000);
  const incomplete = documentOf(check(statement({ listedItemsComplete: false })));
  assert.deepEqual(
    [incomplete.statement?.complete, incomplete.statement?.ownSumCents],
    [false, null],
  );
  // Statements are information only: never a finding, never an unclear field.
  const unclear = documentOf(check(statement({ uncertainFields: ['total', 'listedItems'] })));
  assert.deepEqual([unclear.findings, unclear.unclearFields], [[], []]);
});

test('the parts within 1¢ pass, 2¢ off do not; the lines only when complete, 1 to 40 and every one read', () => {
  assert.equal(documentOf(check(bill({ total: 413.35 }))).arithmetic.parts, 'passed');
  const off = documentOf(check(bill({ total: 413.36 })));
  assert.equal(off.arithmetic.parts, 'missed');
  assert.ok(off.findings.includes('amounts_mismatch'));
  // The lines against the subtotal: 1¢ off passes, 2¢ misses.
  assert.equal(
    documentOf(check(bill({ lineItems: lines(99, 189, 38.25, 19.6, 24.91) }))).arithmetic.lines,
    'passed',
  );
  assert.equal(
    documentOf(check(bill({ lineItems: lines(99, 189, 38.25, 19.6, 24.92) }))).arithmetic.lines,
    'missed',
  );
  for (const changes of [
    { lineItemsComplete: false },
    { lineItems: Array.from({ length: 41 }, () => ({ amount: 1 })) },
    { lineItems: [{ amount: 99 }, { amount: null }] },
    { lineItems: [] },
  ]) {
    assert.equal(
      documentOf(check(bill(changes))).arithmetic.lines,
      'not_run',
      JSON.stringify(changes).slice(0, 40),
    );
  }
  // The lines weigh the subtotal, not the total: a misread total leaves them passing.
  const total = documentOf(check(bill({ total: 420 })));
  assert.deepEqual([total.arithmetic.parts, total.arithmetic.lines], ['missed', 'passed']);
  // Neither check possible: not cross-checked.
  const neither = documentOf(check(bill({ subtotal: null, lineItems: [] })));
  assert.deepEqual(neither.findings, ['not_cross_checked']);
  // Tax printed and no subtotal: the lines stand in for it (D2).
  const standIn = documentOf(
    check(bill({ subtotal: null, tax: 30.59, shipping: 12, total: 413.34 })),
  );
  assert.deepEqual(
    [standIn.arithmetic.parts, standIn.arithmetic.lines, standIn.findings],
    ['not_run', 'passed', []],
  );
});

test('the arithmetic is one function, and a total agrees only when a check that weighs it passed', () => {
  const parts = {
    subtotalCents: 3000,
    taxCents: 248,
    shippingCents: null,
    discountCents: null,
    linesCents: 3000,
  };
  assert.equal(amountsOf('receipt', parts, null, 3248, 600, null).tip, 'added');
  assert.ok(totalAgrees('receipt', parts, null, 3248, 600));
  assert.ok(totalAgrees('receipt', parts, null, 3848, 600));
  assert.ok(!totalAgrees('receipt', parts, null, 4000, 600));
  assert.ok(
    !totalAgrees('bill', { ...parts, subtotalCents: null, linesCents: null }, null, 3248, null),
  );
  assert.ok(!totalAgrees('credit_note', parts, 'mixed', 3248, null));
});
