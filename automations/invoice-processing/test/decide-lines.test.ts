import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { Difference } from '../src/state.js';
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
  VENDOR,
  VISA,
  agreed,
  billRow,
  decide,
  found,
  heldOf,
  type DecideSetUp,
} from './decide-world.js';

/**
 * decide's lines beside the approval (the plan's §2.4 and §2.7; ip-review
 * design-checks-rules-and-approval.json cross_cutting[5]; D27): what the approval's reason line
 * gives up to '+N more' is named in decide's line before anything else, the two reads' values and
 * what is recorded next, and the category ends decide's line, held or straight through — every
 * line within 200 characters.
 */

/** The receipt's seller, linked as a vendor. */
const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };

/**
 * Each hold's phrase or detail in the reason line or decide's line — but for `unnamed`, which
 * decide's line counts as '+N more' — and the category last in decide's line; every line within 200.
 */
function assertEveryHoldShown(held: ReturnType<typeof heldOf>, unnamed = 0) {
  const lines = `${held.reason}\n${held.summary}`.toLowerCase();
  const missing = held.holds.filter(
    (hold) =>
      !lines.includes(hold.phrase.toLowerCase()) && !lines.includes(hold.detail.toLowerCase()),
  );
  assert.equal(
    missing.length,
    unnamed,
    `in neither line: ${missing.map((hold) => hold.code).join(', ')} | ${held.reason} | ${held.summary}`,
  );
  const counted = /; \+(\d+) more; category /u.exec(held.summary);
  assert.equal(Number(counted?.[1] ?? 0), unnamed, held.summary);
  assert.match(held.summary, /; category [^;]+ \([^;]+\)$|^Held: category /u, held.summary);
  for (const line of [held.reason, held.summary, held.heldReason]) assert.ok(line.length <= 200);
}

test('reads that disagree on a 110-character seller: both values cut to 40, what is recorded, and the category, within 200', () => {
  const first =
    'Harrowgate Office Supply and Stationery Wholesale Distributors of Fine Paper Goods and Things Incorporated Ltd';
  const second =
    'Harrowmore Office Supply and Stationery Wholesale Distributors of Fine Paper Goods and Things Incorporated Ltd';
  assert.deepEqual([first.length, second.length], [110, 110]);
  const answer = bill({ vendorName: first });
  const held = heldOf(
    decide({
      answer,
      verification: {
        ...agreed(documentOf(check(answer))),
        differences: [{ field: 'vendorName', first, second }],
      },
    }),
  );
  assert.equal(
    held.reason,
    'Reads disagree on seller: Harrowgate Office Supply, HOS-1042, $413.34',
  );
  assert.equal(
    held.summary,
    'Held: reads disagree: seller Harrowgate Office Supply and Stationery… vs Harrowmore Office Supply and Stationery…; the first read recorded; category Office Supplies (office supplies)',
  );
  assertEveryHoldShown(held);
});

test("three reasons, the reads' among them: their two values and what is recorded are kept ahead of the other details, and every reason is named", () => {
  const document = documentOf(check(bill()));
  const reads = (differences: Difference[]) =>
    heldOf(
      decide({
        answer: bill(),
        config: { holdAboveAmount: 100 },
        lookups: { amountLookup: found(billRow({ id: '999', docNumber: 'X-1' })) },
        verification: {
          ...agreed(document),
          differences,
          totalPicked: 'first',
        },
      }),
    );
  const number: Difference = { field: 'documentNumber', first: 'HOS-1042', second: 'HOS-1043' };
  const total: Difference = { field: 'total', first: '$413.34', second: '$431.34' };
  const three = reads([number, total]);
  assert.deepEqual(
    three.holds.map((hold) => hold.code),
    ['over_limit', 'possible_duplicate', 'reads_disagree'],
  );
  assert.equal(
    three.summary,
    'Held: $413.34 is over the $100 limit; possible duplicate; reads disagree: number HOS-1042 vs HOS-1043, total $413.34 vs $431.34; the first read recorded; category Office Supplies (office supplies)',
  );
  assertEveryHoldShown(three);
  // A third field: two fields' values, then how many more.
  const more = reads([
    number,
    total,
    { field: 'documentDate', first: '2026-09-14', second: '2026-09-15' },
  ]);
  assert.equal(
    more.holds[2]?.detail,
    'reads disagree: number HOS-1042 vs HOS-1043, total $413.34 vs $431.34 +1 more; the first read recorded',
  );
  assertEveryHoldShown(more);
});

test("nine reasons on a receipt: more given up than a line can hold beside the category, so decide's line names what fits and counts the rest", () => {
  const paidFrom = { id: '35', fullyQualifiedName: 'Business Checking', accountType: 'Bank' };
  const answer = receipt({
    paymentMethod: 'other',
    currency: 'US$',
    subtotal: 50,
    uncertainFields: ['total', 'documentDate', 'documentNumber'],
  });
  const held = heldOf(
    decide({
      answer,
      check: { paidFrom },
      vendor: TIDEWELL,
      config: { holdAboveAmount: 0, companyCardLast4: '9999' },
      verification: {
        ...agreed(documentOf(check(answer, { paidFrom }))),
        differences: [
          { field: 'documentDate', first: '2026-09-27', second: '2026-09-28' },
          { field: 'paymentMethod', first: 'other', second: 'cash' },
          { field: 'total', first: '$60.63', second: '$66.03' },
        ],
        totalPicked: 'first',
      },
      lookups: {
        amountLookup: { reachedMax: true, records: [] },
        numberLookup: found(
          billRow({ vendorId: '9', docNumber: '55120', totalCents: 6063, balanceCents: 0 }),
        ),
      },
    }),
  );
  assert.equal(held.holds.length, 9);
  assert.equal(
    held.reason,
    "Over the $0 limit; possible duplicate; matches bill 55120, already paid; card ending 4417 isn't the company card; +5 more: Tidewell Hardware, $60.63 from Business Checking",
  );
  // The five given up: four named, the category's name and why shortened for them, one counted.
  assert.equal(
    held.summary,
    "Held: paid by other means, recorded from Business Checking; amounts don't add up; reads disagree on date, payment method +1; unclear: total, number +1; +1 more; category Utilities:E… (no category…)",
  );
  assertEveryHoldShown(held, 1);
  assert.equal(held.saved.holdReasons.length, 9, 'the saved data carries every reason');
});

test("every path, every mix of the common reasons: each hold in the reason line or decide's line, the category always last in decide's, every line within 200", () => {
  const document = (answer: JsonObject, more: DecideSetUp['check'] = {}) =>
    documentOf(check(answer, { paidFrom: VISA, ...more }));
  const paths: [string, DecideSetUp][] = [
    [
      'new vendor',
      {
        answer: bill({ listedItems: [{ reference: 'HOS-1031', amount: 380, kind: 'invoice' }] }),
        vendor: { status: 'new' },
        customerNameClash: 'match',
        similarVendors: ['Harrowgate Supply'],
      },
    ],
    [
      'bill',
      {
        answer: sampleAnswer('utility-statement-balance'),
        vendor: { ...VENDOR, displayName: 'Example County Water District' },
      },
    ],
    [
      'receipt',
      {
        answer: receipt({ paymentMethod: 'other' }),
        vendor: TIDEWELL,
        config: { companyCardLast4: '9999' },
        lookups: {
          numberLookup: found(
            billRow({ vendorId: '9', docNumber: '55120', totalCents: 6063, balanceCents: 0 }),
          ),
        },
      },
    ],
    [
      'card refund',
      {
        answer: sampleAnswer('card-refund'),
        vendor: TIDEWELL,
        config: { companyCardLast4: '9999' },
      },
    ],
    ['vendor credit', { answer: creditNote({ refundMethod: 'not_shown' }) }],
    [
      'employee',
      {
        answer: sampleAnswer('restaurant-tip-under-total'),
        check: paidBy('employee', { paidFrom: null }),
        config: { companyCardLast4: '3346' },
        company: { payrollFeature: true },
      },
    ],
    ['owner', { answer: receipt(), check: paidBy('owner', { paidFrom: null }) }],
    [
      'contractor',
      {
        answer: receipt(),
        check: paidBy('not_employee', { paidFrom: null }),
        vendor: { ...VENDOR, displayName: 'Samuel Lee Consulting', vendor1099: false },
      },
    ],
  ];
  let held = 0;
  for (const [label, path] of paths) {
    const base = document(path.answer, path.check);
    for (const limit of [0, 1_000_000]) {
      for (const currency of [null, 'US$']) {
        for (const unclear of [[], ['total', 'documentDate', 'documentNumber']]) {
          for (const second of ['agrees', 'differs', 'not made'] as const) {
            for (const full of [false, true]) {
              const answer = { ...path.answer, currency, uncertainFields: unclear };
              const verification =
                second === 'not made'
                  ? ({ status: 'not_made', reason: 'no_model_left' } as const)
                  : {
                      ...agreed(base),
                      differences:
                        second === 'agrees'
                          ? []
                          : [
                              {
                                field: 'vendorName' as const,
                                first: base.seller,
                                second: `${base.seller} Wholesale`,
                              },
                              { field: 'total' as const, first: '$1.00', second: '$2.00' },
                            ],
                      totalPicked: second === 'agrees' ? null : ('first' as const),
                    };
              const decision = decide({
                ...path,
                answer,
                config: { ...path.config, holdAboveAmount: limit },
                verification,
                lookups: {
                  ...path.lookups,
                  ...(full ? { amountLookup: { reachedMax: true, records: [] } } : {}),
                },
              });
              if (decision.outcome === 'ok') continue;
              held += 1;
              const one = heldOf(decision);
              assertEveryHoldShown(one);
              assert.ok(one.holds.length >= 1, label);
            }
          }
        }
      }
    }
  }
  assert.ok(held >= 300, String(held));
});

test("straight through, decide's line ends with the category whatever it leaves out; its names share the room, the amounts and the words around them whole", () => {
  const ok = (setUp: DecideSetUp) => {
    const decision = decide(setUp);
    assert.equal(decision.outcome, 'ok');
    return decision.outcome === 'ok' ? decision.summary : '';
  };
  assert.equal(
    ok({ answer: bill() }),
    'No reason to hold: $413.34 within the $500 limit, Harrowgate Office Supply matched by display name, no duplicate; creating the bill; category Office Supplies (office supplies)',
  );
  assert.equal(
    ok({ answer: bill({ documentNumber: 'N'.repeat(30) }), preferences: { bookCloseDate: null } }),
    'No reason to hold: $413.34 within the $500 limit, Harrowgate Office Supply matched by display name, no duplicate; creating the bill; number kept in the memo; category Office Supplies (office supplies)',
  );
  const long = {
    answer: creditNote(),
    vendor: {
      ...VENDOR,
      displayName: 'Harrowgate Office Supply and Stationery Wholesale Distributors',
    },
    accounts: {
      categories: {
        office_supplies: {
          id: '64',
          fullyQualifiedName: 'Office Expenses:Stationery and Printer Supplies',
          accountType: 'Expense',
        },
      },
    },
  };
  assert.equal(
    ok({ ...long, config: { holdAboveAmount: 1_000_000 } }),
    'No reason to hold: $203.20 within the $1,000,000 limit, Harrowgate Office Supply and Stationer… matched by display name, no duplicate; category Office Expenses:Stationery and Printe… (office supplies)',
  );
  assert.equal(
    ok({
      ...long,
      answer: creditNote({ spendType: 'software_and_subscriptions' }),
      config: { holdAboveAmount: 9_999_999_999.99 },
      accounts: { defaultCategory: long.accounts.categories.office_supplies },
    }),
    'No reason to hold: $203.20 within the $9,999,999,999.99 limit, Harrowgate Office Supply and… matched by display name, no duplicate; category Office Expenses:Stationery… (no category set for softwar…)',
  );
});
