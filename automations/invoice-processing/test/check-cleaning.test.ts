import assert from 'node:assert/strict';
import { test } from 'node:test';

import { namedFields } from '../src/checks/fields.js';
import { hasWebAddress, roughlySameSeller, sellerKey } from '../src/names.js';
import { bill, check, creditNote, documentOf, paidBy, receipt, statement } from './check-world.js';

/**
 * The cleaning (the plan's §2.2; Group 3's D1–D4): done once, every later step reading only clean
 * values — and what cannot be read cleanly marked unclear where its route uses it, never guessed.
 */

test('the typed bill, cleaned: every value the later steps read, and nothing printed beside a line', () => {
  assert.deepEqual(documentOf(check(bill())), {
    type: 'bill',
    route: 'bill',
    seller: 'Harrowgate Office Supply',
    sellerHasWebAddress: false,
    number: 'HOS-1042',
    numberUsable: true,
    date: '2026-09-14',
    dueDate: '2026-10-14',
    dueDateSource: 'printed',
    termsDiffer: false,
    currency: 'USD',
    currencyUnrecognised: false,
    totalCents: 41334,
    amountCents: 41334,
    amountDueCents: null,
    earlierBalanceCents: null,
    tipCents: null,
    tip: 'none',
    paymentMethod: 'not_shown',
    cardLast4: null,
    cardDigitsUnclear: false,
    cashBackPrinted: false,
    refundMethod: 'not_applicable',
    originalInvoiceNumber: null,
    spendType: 'office_supplies',
    spendTypeUnclear: false,
    listedInvoiceCount: 0,
    statement: null,
    arithmetic: {
      subtotalCents: 37075,
      taxCents: 3059,
      shippingCents: 1200,
      discountCents: null,
      linesCents: 37075,
      signs: null,
      parts: 'passed',
      lines: 'passed',
    },
    findings: [],
    unclearFields: [],
  });
});

test('text: the seller and the numbers cleaned once, as names are', () => {
  const document = documentOf(
    check(
      creditNote({
        vendorName: '  Harrowgate\n Office Supply ',
        documentNumber: '“CM–0077”',
        originalInvoiceNumber: ' HOS‑1042 ',
      }),
    ),
  );
  assert.equal(document.seller, 'Harrowgate Office Supply');
  assert.equal(document.number, '"CM-0077"');
  assert.equal(document.originalInvoiceNumber, 'HOS-1042');
  // An original number past 100 characters is not used, and is unclear.
  const long = documentOf(check(creditNote({ originalInvoiceNumber: 'H'.repeat(101) })));
  assert.equal(long.originalInvoiceNumber, null);
  assert.deepEqual(long.unclearFields, ['originalInvoiceNumber']);
});

test('money: a fraction of a cent is rounded and unclear; a negative part is unclear; out of range is not used', () => {
  const fraction = documentOf(check(bill({ tax: 30.595, total: 413.345 })));
  assert.deepEqual([fraction.arithmetic.taxCents, fraction.totalCents], [3060, 41335]);
  assert.deepEqual(fraction.unclearFields, ['total', 'tax']);
  assert.ok(fraction.findings.includes('unclear_fields'));
  const negative = documentOf(check(bill({ discount: -10, total: 403.34 })));
  assert.deepEqual(negative.unclearFields, ['discount']);
  const negativeTax = documentOf(check(bill({ tax: -30.59, total: 352.16 })));
  assert.deepEqual(negativeTax.unclearFields, ['tax']);
  const huge = documentOf(check(bill({ shipping: 1e22 })));
  assert.equal(huge.arithmetic.shippingCents, null);
  assert.deepEqual(huge.unclearFields, ['shipping']);
});

test('currency: a code on the list kept; anything else not recognised, its text not kept; none printed, none', () => {
  assert.equal(documentOf(check(bill({ currency: 'usd' }))).currency, 'USD');
  const unknown = documentOf(check(bill({ currency: 'US$' })));
  assert.deepEqual([unknown.currency, unknown.currencyUnrecognised], [null, true]);
  assert.ok(unknown.findings.includes('currency_unrecognised'));
  const none = documentOf(check(bill({ currency: null })));
  assert.deepEqual([none.currency, none.currencyUnrecognised, none.findings], [null, false, []]);
});

test("a bill's due date: printed wins, the terms otherwise, else none; terms outside 0–365 are unclear and not used", () => {
  const differ = documentOf(check(bill({ paymentTermsDays: 15 })));
  assert.deepEqual(
    [differ.dueDate, differ.dueDateSource, differ.termsDiffer],
    ['2026-10-14', 'printed', true],
  );
  const terms = documentOf(check(bill({ dueDate: null, paymentTermsDays: 30 })));
  assert.deepEqual([terms.dueDate, terms.dueDateSource], ['2026-10-14', 'terms']);
  const onReceipt = documentOf(check(bill({ dueDate: null, paymentTermsDays: 0 })));
  assert.deepEqual([onReceipt.dueDate, onReceipt.dueDateSource], ['2026-09-14', 'terms']);
  const none = documentOf(check(bill({ dueDate: null, paymentTermsDays: null })));
  assert.deepEqual([none.dueDate, none.dueDateSource], [null, 'none']);
  for (const days of [400, -1, 2.5]) {
    const bad = documentOf(check(bill({ dueDate: null, paymentTermsDays: days })));
    assert.deepEqual(
      [bad.dueDateSource, bad.unclearFields],
      ['none', ['paymentTermsDays']],
      String(days),
    );
  }
  // Only a bill has one.
  assert.deepEqual(documentOf(check(receipt({ dueDate: '2026-10-30' }))).dueDate, null);
});

test('card digits kept only when exactly four; anything else unclear where the route uses them', () => {
  const masked = documentOf(check(receipt({ cardLast4: '****4417' })));
  assert.deepEqual([masked.cardLast4, masked.cardDigitsUnclear], [null, true]);
  assert.deepEqual(masked.unclearFields, ['cardLast4']);
  // A bill does not use card digits: never unclear there.
  assert.deepEqual(documentOf(check(bill({ cardLast4: '44' }))).unclearFields, []);
  const card = documentOf(check(creditNote({ refundMethod: 'refund_to_card', cardLast4: '4417' })));
  assert.equal(card.cardLast4, '4417');
});

test('the unclear list: listed fields that still have a value and that the route uses, once each, in order', () => {
  const listed = documentOf(
    check(
      receipt({
        uncertainFields: [
          'documentDate',
          'total',
          'total',
          'dueDate',
          'paymentMethod',
          'documentType',
        ],
      }),
    ),
  );
  // Listed, but nothing printed: not unclear (a bill uses its amount due).
  assert.deepEqual(
    documentOf(check(bill({ uncertainFields: ['amountDue', 'discount'] }))).unclearFields,
    [],
  );
  // The due date is null on a receipt: not counted. The type always counts.
  assert.deepEqual(listed.unclearFields, [
    'total',
    'documentDate',
    'paymentMethod',
    'documentType',
  ]);
  assert.equal(namedFields(listed.unclearFields), 'total, date +2');
  // A payment method is a company receipt's: paid personally, and on a bill, it is not used.
  assert.deepEqual(
    documentOf(
      check(
        receipt({ uncertainFields: ['paymentMethod'] }),
        paidBy('employee', { paidFrom: null }),
      ),
    ).unclearFields,
    [],
  );
  assert.deepEqual(
    documentOf(check(bill({ uncertainFields: ['paymentMethod', 'tip'] }))).unclearFields,
    [],
  );
  // Spend type is never one: unclear, the default category serves (D27).
  const spend = documentOf(check(bill({ uncertainFields: ['spendType'] })));
  assert.deepEqual([spend.unclearFields, spend.spendTypeUnclear, spend.findings], [[], true, []]);
});

test("a statement's rows: at most 40, references cleaned like a number, a row dropped making the list incomplete", () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      reference: `INV-${index}`,
      amount: 10,
      kind: 'invoice',
    }));
  const forty = documentOf(check(statement({ listedItems: rows(40), total: 400 })));
  assert.deepEqual([forty.statement?.rows.length, forty.statement?.complete], [40, true]);
  const more = documentOf(check(statement({ listedItems: rows(41), total: 410 })));
  assert.deepEqual([more.statement?.rows.length, more.statement?.complete], [40, false]);
  const blank = documentOf(
    check(
      statement({
        listedItems: [
          { reference: '  ', amount: 10, kind: 'invoice' },
          { reference: 'R'.repeat(101), amount: 10, kind: 'invoice' },
          { reference: ' INV–1 ', amount: 10.005, kind: 'invoice' },
        ],
        total: 10,
      }),
    ),
  );
  assert.deepEqual(blank.statement?.rows, [
    { reference: 'INV-1', amountCents: 1001, kind: 'invoice' },
  ]);
  assert.equal(blank.statement?.complete, false);
  // A bill keeps only the count of the invoices it lists (hold 5), never the rows.
  const listing = documentOf(check(bill({ listedItems: rows(3) })));
  assert.deepEqual([listing.listedInvoiceCount, listing.statement], [3, null]);
  assert.ok(listing.findings.includes('lists_other_invoices'));
});

test('a web or e-mail address in the seller is noted (D4); two reads of a name are roughly one', () => {
  for (const name of [
    'Acme https://pay.example',
    'www.acme-supplies.example',
    'billing@acme.example',
    'quillfeather-paper.example',
    // The 'io' suffix has no reserved name (RFC 2606 and 6761 reserve .example, .test, .invalid
    // and .localhost), so it is shown on the placeholder company, Acme.
    'Acme.io Labs',
  ]) {
    assert.ok(hasWebAddress(name), name);
  }
  for (const name of ['Acme Co.', "O'Brien & Daughters", 'St. Mark Supply', 'Co.op Market']) {
    assert.ok(!hasWebAddress(name), name);
  }
  assert.ok(
    documentOf(check(bill({ vendorName: 'quillfeather-paper.example' }))).sellerHasWebAddress,
  );
  assert.equal(sellerKey('The Bluefinch Print & Sign, Inc.'), 'bluefinchprintandsign');
  assert.ok(roughlySameSeller('Bluefinch Print & Sign', 'BLUEFINCH PRINT AND SIGN, INC.'));
  assert.ok(roughlySameSeller('Kestrel Courier Co', 'Kestrel Courier'));
  assert.ok(roughlySameSeller('Café Nord L.L.C.', 'cafe nord llc'));
  assert.ok(!roughlySameSeller('Acme Supplies', 'Acme Supply'));
  assert.ok(!roughlySameSeller('Acme Supplies', 'Apex Supplies'));
  assert.ok(roughlySameSeller('&&', '&&'), 'nothing but punctuation: the text itself');
});
