import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChartAccount, ChartState } from '../src/chart.js';
import {
  CATEGORY_NAMES,
  DETAIL_TYPES,
  firstByName,
  namesDigits,
  normalizedName,
  pickCategory,
  pickPaidFrom,
} from '../src/decide/picks.js';
import { SPEND_TYPES } from '../src/spend-types.js';

/**
 * Guard A4 — the accounts v2 picks from the company's chart, never from a setting (v2's §2.5;
 * decision 1; S11, S12): a category by its name in the spend type's list, else by its detail type,
 * else Uncategorized Expense, else none; what a receipt or a refund was paid from — the card its
 * digits name, the only card, the only bank — else a wait showing the first A→Z, else none.
 */

let next = 100;
const account = (
  name: string,
  type: string,
  detailType: string | null = null,
  fullName = name,
): ChartAccount => ({ id: String((next += 1)), name, fullName, type, detailType });
const expense = (name: string, detailType: string | null = null) =>
  account(name, 'Expense', detailType);
const bank = (name: string) => account(name, 'Bank', 'Checking');
const card = (name: string, fullName = name) => account(name, 'Credit Card', null, fullName);
const UNCATEGORIZED = account('Uncategorized Expense', 'Expense', 'OtherMiscellaneousServiceCost');

function chart(parts: Partial<ChartState> = {}): ChartState {
  return { categories: [], banks: [], cards: [], uncategorized: UNCATEGORIZED, read: 0, ...parts };
}

test('normalizedName: lowercase, & is and, every other mark a space, one space, trimmed', () => {
  assert.equal(normalizedName('Car & Truck'), 'car and truck');
  assert.equal(normalizedName('  Legal_&_Professional   Fees!! '), 'legal and professional fees');
  assert.equal(normalizedName('Repairs/Maintenance'), 'repairs maintenance');
  assert.equal(normalizedName('Café   Meals'), 'café meals');
  // Every list's names are written as normalizedName gives them.
  for (const names of Object.values(CATEGORY_NAMES)) {
    for (const name of names) assert.equal(normalizedName(name), name);
  }
});

test("the lists cover every spend type but 'other', which is always Uncategorized Expense", () => {
  const picked = SPEND_TYPES.filter((type) => type !== 'other');
  assert.deepEqual(Object.keys(CATEGORY_NAMES).sort(), [...picked].sort());
  assert.deepEqual(Object.keys(DETAIL_TYPES).sort(), [...picked].sort());
  const office = expense('Office Supplies');
  assert.deepEqual(pickCategory(chart({ categories: [office] }), 'other', false), {
    kind: 'picked',
    account: UNCATEGORIZED,
    why: 'uncategorized',
  });
});

test('a category by name: the first name in the list that exactly one account carries, by its own name', () => {
  const carAndTruck = expense('Car & Truck');
  const fuel = expense('Fuel');
  assert.deepEqual(
    pickCategory(chart({ categories: [fuel, carAndTruck] }), 'vehicle_and_fuel', false),
    {
      kind: 'picked',
      account: carAndTruck,
      why: 'its name',
    },
  );
  // Two accounts with the first name: the next name in the list is tried.
  const twice = [expense('Car and Truck'), expense('Car & Truck')];
  assert.deepEqual(
    pickCategory(chart({ categories: [...twice, fuel] }), 'vehicle_and_fuel', false),
    { kind: 'picked', account: fuel, why: 'its name' },
  );
  // Its own name, the leaf, is what is compared — not the full name of a sub-account.
  const leaf = account('Software', 'Expense', null, 'Office:Software');
  assert.deepEqual(
    pickCategory(chart({ categories: [leaf] }), 'software_and_subscriptions', false),
    {
      kind: 'picked',
      account: leaf,
      why: 'its name',
    },
  );
  // A name not in the list never picks by name.
  const near = expense('Vehicle costs');
  assert.equal(
    pickCategory(chart({ categories: [near] }), 'vehicle_and_fuel', false).kind,
    'picked',
  );
  assert.deepEqual(pickCategory(chart({ categories: [near] }), 'vehicle_and_fuel', false), {
    kind: 'picked',
    account: UNCATEGORIZED,
    why: 'uncategorized',
  });
});

test('no name: the one account of the detail type, each tried in order; two of one type do not pick', () => {
  const cogs = expense('Job costs', 'SuppliesMaterialsCogs');
  assert.deepEqual(pickCategory(chart({ categories: [cogs] }), 'materials', false), {
    kind: 'picked',
    account: cogs,
    why: 'its detail type',
  });
  const supplies = expense('Stock', 'SuppliesMaterials');
  assert.deepEqual(pickCategory(chart({ categories: [cogs, supplies] }), 'materials', false), {
    kind: 'picked',
    account: supplies,
    why: 'its detail type',
  });
  const two = [expense('Dinners', 'EntertainmentMeals'), expense('Lunches', 'EntertainmentMeals')];
  const travelMeals = expense('On the road', 'TravelMeals');
  assert.deepEqual(pickCategory(chart({ categories: [...two, travelMeals] }), 'meals', false), {
    kind: 'picked',
    account: travelMeals,
    why: 'its detail type',
  });
  assert.equal(pickCategory(chart({ categories: two }), 'meals', false).kind, 'picked');
  assert.equal(
    (pickCategory(chart({ categories: two }), 'meals', false) as { why: string }).why,
    'uncategorized',
  );
});

test('a spend type the reads dispute, or one unclear: Uncategorized Expense; none in the company: none', () => {
  const office = expense('Office Supplies');
  assert.deepEqual(pickCategory(chart({ categories: [office] }), 'office_supplies', true), {
    kind: 'picked',
    account: UNCATEGORIZED,
    why: 'uncategorized',
  });
  assert.deepEqual(
    pickCategory(chart({ categories: [], uncategorized: null }), 'office_supplies', false),
    { kind: 'none' },
  );
  assert.deepEqual(pickCategory(chart({ uncategorized: null }), 'other', false), { kind: 'none' });
});

test('Paid from, paid by card: (a) the one card whose name holds the printed digits as a number of their own, (b) else the only card', () => {
  const visa = card('Visa 4417');
  const amex = card('Amex', 'Cards:Amex 1009');
  const longer = card('Card 144170');
  const receipt = (cardLast4: string | null) =>
    ({ route: 'company_receipt', paymentMethod: 'card', cardLast4 }) as const;
  assert.deepEqual(pickPaidFrom(chart({ cards: [amex, visa, longer] }), receipt('4417')), {
    kind: 'picked',
    account: visa,
  });
  // The digits in the full name count too.
  assert.deepEqual(pickPaidFrom(chart({ cards: [amex, visa] }), receipt('1009')), {
    kind: 'picked',
    account: amex,
  });
  assert.equal(namesDigits('Card 144170', '4417'), false);
  assert.equal(namesDigits('Visa-4417', '4417'), true);
  assert.deepEqual(pickPaidFrom(chart({ cards: [longer] }), receipt('4417')), {
    kind: 'picked',
    account: longer,
  });
  // Several cards and none named: ask, showing the first by full name A→Z (S11).
  assert.deepEqual(pickPaidFrom(chart({ cards: [visa, amex] }), receipt(null)), {
    kind: 'ask',
    account: amex,
  });
  // A card receipt in a company with no card account: (c), the only bank.
  const checking = bank('Checking');
  assert.deepEqual(pickPaidFrom(chart({ banks: [checking] }), receipt('4417')), {
    kind: 'picked',
    account: checking,
  });
});

test('Paid from, any other way: (c) the only bank; several: ask, the first A→Z; none at all: not recorded', () => {
  const checking = bank('Checking');
  const savings = bank('Savings');
  const visa = card('Visa 4417');
  for (const paymentMethod of ['cash', 'check', 'bank_transfer', 'not_shown'] as const) {
    const receipt = { route: 'company_receipt', paymentMethod, cardLast4: null } as const;
    assert.deepEqual(pickPaidFrom(chart({ banks: [checking], cards: [visa] }), receipt), {
      kind: 'picked',
      account: checking,
    });
    assert.deepEqual(pickPaidFrom(chart({ banks: [savings, checking] }), receipt), {
      kind: 'ask',
      account: checking,
    });
    assert.deepEqual(pickPaidFrom(chart(), receipt), { kind: 'none', reason: 'no_paying_account' });
  }
  assert.equal(firstByName([savings, checking])?.name, 'Checking');
});

test('a card refund: only (a) or (b) — never a bank; no card account: refunds need a card account', () => {
  const visa = card('Visa 4417');
  const checking = bank('Checking');
  const refund = (cardLast4: string | null) =>
    ({ route: 'card_refund', paymentMethod: 'not_shown', cardLast4 }) as const;
  assert.deepEqual(pickPaidFrom(chart({ cards: [visa], banks: [checking] }), refund(null)), {
    kind: 'picked',
    account: visa,
  });
  assert.deepEqual(pickPaidFrom(chart({ banks: [checking] }), refund('4417')), {
    kind: 'none',
    reason: 'refund_needs_card',
  });
});
