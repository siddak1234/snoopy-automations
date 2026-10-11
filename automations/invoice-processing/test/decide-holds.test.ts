import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOLD_ORDER, limitCentsOf } from '../src/decide/holds.js';
import {
  bill,
  check,
  creditNote,
  documentOf,
  paidBy,
  receipt,
  sampleAnswer,
} from './check-world.js';
import {
  CHECKING,
  VENDOR,
  agreed,
  billRow,
  decide,
  expenseRow,
  found,
  heldOf,
  holdCodes,
  type DecideSetUp,
} from './decide-world.js';

/**
 * decide's holds (the plan's §2.4, §2.9 "Holds"): every hold alone with its phrase, all of them
 * in ONE hold in the plan's order, reimbursements always held, the approval limit, the card check
 * and the payment method against what "Paid from" is.
 */

/** The receipt's seller, linked as a vendor. */
const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };
const phrases = (setUp: DecideSetUp) => heldOf(decide(setUp)).holds.map((hold) => hold.phrase);

test("the twenty reasons, in the plan's order", () => {
  assert.deepEqual(HOLD_ORDER, [
    'paid_personally',
    'over_limit',
    'new_vendor',
    'possible_duplicate',
    'may_be_statement',
    'matches_bill',
    'company_charge_found',
    'card_check',
    'payment_method',
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

test('each hold alone, with its phrase', () => {
  const document = documentOf(check(bill()));
  const cases: [string, DecideSetUp, string[]][] = [
    [
      'paid personally',
      { answer: receipt(), check: paidBy('employee', { paidFrom: null }) },
      ['paid personally'],
    ],
    [
      'over the limit',
      { answer: bill(), config: { holdAboveAmount: 400 } },
      ['over the $400 limit'],
    ],
    ['new vendor', { answer: bill(), vendor: { status: 'new' } }, ['new vendor']],
    [
      'possible duplicate',
      { answer: bill(), lookups: { amountLookup: found(billRow()) } },
      ['possible duplicate'],
    ],
    [
      'may be a statement',
      { answer: bill(), vendor: { ...VENDOR, balanceCents: 41334 } },
      ['may be a statement'],
    ],
    [
      'matches a bill',
      {
        answer: receipt(),
        vendor: TIDEWELL,
        lookups: {
          numberLookup: found(billRow({ vendorId: '9', docNumber: '55120', totalCents: 6063 })),
        },
      },
      ['matches open bill 55120'],
    ],
    [
      'card check',
      { answer: receipt(), vendor: TIDEWELL, config: { companyCardLast4: '9999' } },
      ["card ending 4417 isn't the company card"],
    ],
    [
      'payment method',
      { answer: receipt({ paymentMethod: 'cash' }), vendor: TIDEWELL },
      ['paid in cash, recorded from Company Visa'],
    ],
    [
      'earlier balance',
      { answer: sampleAnswer('utility-statement-balance') },
      ['earlier balance $58.40 also due'],
    ],
    [
      'refund method',
      { answer: creditNote({ refundMethod: 'not_shown' }) },
      ['refund method not shown'],
    ],
    [
      'tip added',
      { answer: sampleAnswer('restaurant-tip-under-total'), vendor: TIDEWELL },
      ['tip of $6.00 added to the printed total'],
    ],
    ['amounts', { answer: bill({ total: 413.36 }) }, ["amounts don't add up"]],
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
      ['reads disagree on total, date'],
    ],
    [
      'second check',
      { answer: bill(), verification: { status: 'not_made', reason: 'no_model_left' } },
      ['second check not made'],
    ],
    [
      'unclear',
      { answer: bill({ uncertainFields: ['documentDate', 'total', 'dueDate'] }) },
      ['unclear: total, date +1'],
    ],
    [
      'not cross-checked',
      { answer: bill({ subtotal: null, lineItems: [] }) },
      ['total not cross-checked'],
    ],
    [
      'currency not recognised',
      { answer: bill({ currency: 'US$' }) },
      ['currency not recognised, USD will be used'],
    ],
  ];
  for (const [label, setUp, expected] of cases) assert.deepEqual(phrases(setUp), expected, label);
  // The two only a new vendor's bill has, beside "new vendor".
  assert.deepEqual(phrases({ answer: bill({ currency: null }), vendor: { status: 'new' } }), [
    'new vendor',
    'no currency printed, USD will be used',
  ]);
  assert.deepEqual(
    phrases({ answer: bill(), vendor: { status: 'new' }, customerNameClash: 'match' }),
    ['new vendor', 'name used by a customer, will be created with (vendor)'],
  );
  assert.deepEqual(
    phrases({ answer: bill(), vendor: { status: 'new' }, employeeNameClash: 'match' }),
    ['new vendor', 'name used by an employee, will be created with (vendor)'],
  );
  // A company charge for a paid-personally amount (hold 7), beside "paid personally".
  assert.deepEqual(
    phrases({
      answer: receipt(),
      check: paidBy('employee', { paidFrom: null }),
      lookups: { relatedLookup: found(expenseRow({ accountId: CHECKING.id })) },
    }),
    ['paid personally', 'a company card or bank charge matches'],
  );
});

test("every reason that applies, in one hold, in the plan's order; the reason line at most 200 with the path's ending", () => {
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
  assert.ok(many.reason.length <= 200, String(many.reason.length));
  assert.match(many.reason, /^Over the \$500 limit; new vendor; possible duplicate; /u);
  assert.match(many.reason, /; \+3 more: N+…, HOS-1042, \$999\.00$/u);
  assert.equal(many.saved.holdReasons.length, 10, 'the saved data carries them all');
  // decide's line names what the reason line gave up to '+3 more', and the category, always.
  assert.equal(
    many.summary,
    'Held: $999.00 is over the $500 limit; unclear: date; no currency printed, USD will be used; name used by a customer, will be created with (vendor); category Office Supplies (office supplies)',
  );
  assert.ok(many.summary.length <= 200);
  // Every reason in one of the two lines (decide-lines.test.ts holds every path to this).
  const said = `${many.reason}\n${many.summary}`.toLowerCase();
  for (const hold of many.holds) {
    const { phrase, detail } = hold;
    assert.ok(
      said.includes(phrase.toLowerCase()) || said.includes(detail.toLowerCase()),
      hold.code,
    );
  }
});

test('a reimbursement always waits for approval, at any amount (D16)', () => {
  for (const payer of ['employee', 'owner', 'not_employee'] as const) {
    const small = receipt({ total: 1, subtotal: null, tax: null, lineItems: [] });
    const held = heldOf(
      decide({
        answer: small,
        check: paidBy(payer, { paidFrom: null }),
        config: { holdAboveAmount: 1_000_000 },
      }),
    );
    assert.equal(held.holds[0]?.code, 'paid_personally', payer);
  }
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
  assert.match(
    phrases({ answer: bill(), config: { holdAboveAmount: 400.5 } })[0]!,
    /^over the \$400\.50 limit$/u,
  );
});

test('the card check (D19): the same digits, other digits, none printed, and paid personally with the company card', () => {
  const card = (
    answer = receipt(),
    config: Record<string, unknown> = {},
    more: Partial<DecideSetUp> = {},
  ) => holdCodes(decide({ answer, vendor: TIDEWELL, config, ...more }));
  assert.deepEqual(card(receipt(), { companyCardLast4: '4417' }), []);
  assert.deepEqual(card(receipt(), { companyCardLast4: '9999' }), ['card_check']);
  assert.deepEqual(card(receipt({ cardLast4: null }), { companyCardLast4: '9999' }), []);
  assert.deepEqual(
    card(receipt(), {}),
    [],
    'no setting: nothing to compare against a card account',
  );
  assert.deepEqual(
    card(receipt(), { companyCardLast4: '44 17' }),
    [],
    'a setting not of four digits never reaches decide, find-accounts fails the run first; here it compares nothing',
  );
  assert.deepEqual(
    phrases({
      answer: receipt(),
      check: paidBy('employee', { paidFrom: null }),
      config: { companyCardLast4: '4417' },
    }),
    ['paid personally', 'card ending 4417 is the company card'],
  );
  assert.deepEqual(
    holdCodes(
      decide({
        answer: receipt(),
        check: paidBy('employee', { paidFrom: null }),
        config: { companyCardLast4: '9999' },
      }),
    ),
    ['paid_personally'],
  );
  // A refund to another card than the company's.
  assert.deepEqual(
    phrases({
      answer: sampleAnswer('card-refund'),
      vendor: TIDEWELL,
      config: { companyCardLast4: '9999' },
    }),
    ["card ending 4417 isn't the company card"],
  );
});

test("the payment method against the Paid from account's kind (D18): every combination", () => {
  const method = (
    paymentMethod: string,
    paidFrom: typeof CHECKING | undefined,
    config: Record<string, unknown> = {},
    more = {},
  ) => {
    const decision = decide({
      answer: receipt({ paymentMethod, ...more }),
      vendor: TIDEWELL,
      config,
      ...(paidFrom ? { check: { paidFrom } } : {}),
    });
    return decision.outcome === 'ok' ? [] : heldOf(decision).holds.map((hold) => hold.phrase);
  };
  // Paid from the company card.
  assert.deepEqual(method('not_shown', undefined), ['payment method not shown']);
  assert.deepEqual(method('cash', undefined), ['paid in cash, recorded from Company Visa']);
  assert.deepEqual(method('other', undefined), ['paid by other means, recorded from Company Visa']);
  assert.deepEqual(method('check', undefined), ['paid by check, recorded from Company Visa']);
  assert.deepEqual(method('bank_transfer', undefined), [
    'paid by bank transfer, recorded from Company Visa',
  ]);
  assert.deepEqual(method('card', undefined), []);
  // Paid from a bank account.
  assert.deepEqual(method('not_shown', CHECKING), ['payment method not shown']);
  assert.deepEqual(method('cash', CHECKING), ['paid in cash, recorded from Checking']);
  assert.deepEqual(method('other', CHECKING), ['paid by other means, recorded from Checking']);
  assert.deepEqual(method('check', CHECKING), []);
  assert.deepEqual(method('bank_transfer', CHECKING), []);
  assert.deepEqual(
    method('card', CHECKING, { companyCardLast4: '4417' }),
    [],
    'the company card, confirmed',
  );
  assert.deepEqual(
    method('card', CHECKING),
    ["card not confirmed as the company's"],
    'no digits setting',
  );
  assert.deepEqual(
    method('card', CHECKING, { companyCardLast4: '4417' }, { cardLast4: null }),
    ["card not confirmed as the company's"],
    'none printed',
  );
  assert.deepEqual(
    method('card', CHECKING, { companyCardLast4: '9999' }),
    ["card ending 4417 isn't the company card"],
    'other digits: the card check says it',
  );
});
