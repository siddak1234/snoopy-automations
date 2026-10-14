import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOLD_ORDER, limitCentsOf, reasonLine } from '../src/decide/holds.js';
import { bill, check, creditNote, documentOf, receipt, sampleAnswer } from './check-world.js';
import {
  VENDOR,
  agreed,
  billRow,
  chartWith,
  decide,
  expenseRow,
  found,
  heldOf,
  holdCodes,
  type DecideSetUp,
} from './decide-world.js';

/**
 * decide's holds (the plan's §2.4, in v2's words, §2.6): every hold alone with its phrase, all of
 * them in ONE hold in the plan's order, the approval's reason their phrases joined by commas, the
 * first letter capitalised, at most 200 characters, and the approval limit.
 */

/** The receipt's seller, linked as a vendor. */
const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };
const phrases = (setUp: DecideSetUp) => heldOf(decide(setUp)).holds.map((hold) => hold.phrase);

test("the nineteen reasons, in the spec's order", () => {
  assert.deepEqual(HOLD_ORDER, [
    'over_limit',
    'new_vendor',
    'possible_duplicate',
    'may_be_statement',
    'matches_bill',
    'company_charge_found',
    'payment_method',
    'paid_from_pick',
    'earlier_balance',
    'refund_method_not_shown',
    'tip_added',
    'amounts_mismatch',
    'reads_disagree',
    'second_check_not_made',
    'unclear_fields',
    'not_cross_checked',
    'new_vendor_no_currency',
    'name_in_use',
    'currency_unrecognised',
  ]);
});

test('each hold alone, with its phrase (§2.6)', () => {
  const document = documentOf(check(bill()));
  const oneBank = chartWith('35', '41', '42');
  const cases: [string, DecideSetUp, string[]][] = [
    [
      'over the limit',
      { answer: bill(), config: { holdAboveAmount: 400 } },
      ['over the $400 limit'],
    ],
    ['new vendor', { answer: bill(), vendor: { status: 'new' } }, ['new vendor']],
    [
      'new vendor, similar names',
      { answer: bill(), vendor: { status: 'new' }, similarVendors: ['A Co', 'B Co'] },
      ['new vendor, 2 similar names'],
    ],
    [
      'possible duplicate',
      { answer: bill(), lookups: { amountLookup: found(billRow()) } },
      ['may already be in QuickBooks'],
    ],
    [
      'may be a statement',
      { answer: bill(), vendor: { ...VENDOR, balanceCents: 41334 } },
      ['may be a statement'],
    ],
    [
      'matches an open bill',
      {
        answer: receipt(),
        vendor: TIDEWELL,
        lookups: {
          numberLookup: found(billRow({ vendorId: '9', docNumber: '55120', totalCents: 6063 })),
        },
      },
      ['matches an open bill'],
    ],
    [
      'matches a paid bill',
      {
        answer: receipt(),
        vendor: TIDEWELL,
        lookups: {
          numberLookup: found(
            billRow({ vendorId: '9', docNumber: '55120', totalCents: 6063, balanceCents: 0 }),
          ),
        },
      },
      ['matches a paid bill'],
    ],
    [
      'a bank or card charge',
      { answer: receipt(), vendor: TIDEWELL, lookups: { amountLookup: found(expenseRow()) } },
      ['a bank or card charge matches'],
    ],
    [
      'payment method not shown',
      { answer: receipt({ paymentMethod: 'not_shown' }), vendor: TIDEWELL, chart: oneBank },
      ['payment method not shown'],
    ],
    [
      'paid from, asked',
      { answer: receipt({ paymentMethod: 'cash' }), vendor: TIDEWELL },
      ['paid from Checking?'],
    ],
    [
      'earlier balance',
      { answer: sampleAnswer('utility-statement-balance') },
      ['earlier balance also due'],
    ],
    [
      'refund method',
      { answer: creditNote({ refundMethod: 'not_shown' }) },
      ['refund method not shown'],
    ],
    [
      'tip added',
      {
        answer: sampleAnswer('restaurant-tip-under-total'),
        vendor: TIDEWELL,
        chart: chartWith('35', '41'),
      },
      ['tip added to the total'],
    ],
    ['amounts', { answer: bill({ total: 413.36 }) }, ["totals don't add up"]],
    [
      'reads disagree',
      {
        answer: bill(),
        verification: {
          ...agreed(document),
          differences: [
            { field: 'total', first: '$413.34', second: '$431.34' },
            { field: 'documentDate', first: '2026-09-14', second: '2026-09-15' },
          ],
          totalPicked: 'first',
        },
      },
      ['two reads differ: total, date'],
    ],
    [
      'second read',
      { answer: bill(), verification: { status: 'not_made', reason: 'no_model_left' } },
      ['second read not made'],
    ],
    [
      'unclear',
      { answer: bill({ uncertainFields: ['documentDate', 'total', 'dueDate'] }) },
      ['unclear: total, date +1'],
    ],
    [
      'not cross-checked',
      { answer: bill({ subtotal: null, lineItems: [] }) },
      ['total not checked'],
    ],
    ['currency not recognised', { answer: bill({ currency: 'US$' }) }, ['currency not recognised']],
  ];
  for (const [label, setUp, expected] of cases) assert.deepEqual(phrases(setUp), expected, label);
  // The two only a new vendor's bill has, beside "new vendor".
  assert.deepEqual(phrases({ answer: bill({ currency: null }), vendor: { status: 'new' } }), [
    'new vendor',
    'no currency shown, USD used',
  ]);
  for (const clash of [{ customerNameClash: 'match' }, { employeeNameClash: 'match' }] as const) {
    assert.deepEqual(phrases({ answer: bill(), vendor: { status: 'new' }, ...clash }), [
      'new vendor',
      'name used by a customer or employee',
    ]);
  }
});

test("every reason that applies, in one hold, in the spec's order; the reason their phrases, capitalised, ended, at most 200", () => {
  const many = heldOf(
    decide({
      answer: bill({
        vendorName: 'N'.repeat(480),
        currency: null,
        total: 999,
        amountDue: 1200,
        uncertainFields: ['documentDate'],
        listedItems: [{ reference: 'HOS-1031', amount: 380, kind: 'invoice' }],
      }),
      vendor: { status: 'new' },
      customerNameClash: 'match',
      similarVendors: ['Harrowgate Office Supplies', 'Harrowgate Supply'],
      lookups: { amountLookup: { reachedMax: true, records: [] } },
      verification: { status: 'not_made', reason: 'no_answer' },
    }),
  );
  assert.deepEqual(
    many.holds.map((hold) => hold.code),
    [
      'over_limit',
      'new_vendor',
      'possible_duplicate',
      'may_be_statement',
      'earlier_balance',
      'amounts_mismatch',
      'second_check_not_made',
      'unclear_fields',
      'new_vendor_no_currency',
      'name_in_use',
    ],
  );
  assert.equal(
    many.reason,
    "Over the $500 limit, new vendor, 2 similar names, may already be in QuickBooks, may be a statement, earlier balance also due, totals don't add up, second read not made, unclear: date.",
  );
  assert.ok(many.reason.length <= 200, String(many.reason.length));
  assert.equal(many.saved.holdReasons.length, 10, 'the saved data carries them all');
  // The spec's own example.
  assert.equal(
    reasonLine([
      { code: 'over_limit', phrase: 'over the $500 limit' },
      { code: 'new_vendor', phrase: 'new vendor' },
    ]),
    'Over the $500 limit, new vendor.',
  );
  // One phrase longer than the line alone: shortened, never empty.
  const long = reasonLine([{ code: 'paid_from_pick', phrase: `paid from ${'A'.repeat(300)}?` }]);
  assert.ok(long.length <= 200 && long.startsWith('Paid from AAA') && long.endsWith('.'));
  assert.equal(
    reasonLine([{ code: 'paid_from_pick', phrase: 'paid from Checking?' }]),
    'Paid from Checking?',
  );
});

test('the approval limit: strictly over it holds; 500 when missing, null or not a number; read exactly to the cent', () => {
  const over = (total: number, config: Record<string, unknown>) =>
    holdCodes(
      decide({
        answer: bill({ total, subtotal: null, tax: null, shipping: null, lineItems: [] }),
        config,
      }),
    ).includes('over_limit');
  assert.ok(!over(500, {}), '$500.00 is not over $500');
  assert.ok(over(500.01, {}));
  for (const holdAboveAmount of [undefined, null, 'abc', -1, Number.NaN]) {
    assert.equal(limitCentsOf({ holdAboveAmount }), 50_000, String(holdAboveAmount));
  }
  assert.equal(limitCentsOf({ holdAboveAmount: 499.995 }), 49_999);
  assert.ok(!over(500, { holdAboveAmount: 500.005 }));
  assert.ok(over(500.01, { holdAboveAmount: 500.005 }));
  assert.ok(over(0.01, { holdAboveAmount: 0 }), 'a limit of 0 holds everything');
  assert.deepEqual(phrases({ answer: bill(), config: { holdAboveAmount: 400.5 } }), [
    'over the $400.50 limit',
  ]);
});
