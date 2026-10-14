import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { Decision } from '../src/decide/decide.js';
import { SAVED_MAXIMUM_BYTES, savedBytes } from '../src/decide/saved.js';
import { bill, check, creditNote, documentOf, receipt, sampleAnswer } from './check-world.js';
import { CHART } from './extract-world.js';
import {
  VENDOR,
  agreed,
  billRow,
  chartWith,
  decide,
  found,
  type DecideSetUp,
} from './decide-world.js';
import { SAMPLES } from './sample-maker/samples.js';

/**
 * The record decide plans and saves for after approval (the plan's §2.6, §2.8; v2's §2.5): built
 * once, one shape for held and straight through — the operation, payment type, the category and
 * what it was paid from, each picked from the company's chart (no setting names one), payee,
 * amount, number or memo and currency rule per path; never a line, a row or the model's words;
 * refused over 32 KiB.
 */

const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };

function saved(decision: Decision) {
  assert.ok(decision.outcome === 'ok' || decision.outcome === 'held', decision.outcome);
  return decision.saved;
}
const plan = (setUp: DecideSetUp) => saved(decide(setUp)).plan;

test('a bill: bill.create to the vendor, its due date, its number when QuickBooks can take it, one line to the category picked', () => {
  assert.deepEqual(plan({ answer: bill() }), {
    operation: 'bill.create',
    record: 'bill',
    paymentType: null,
    credit: false,
    printStatus: null,
    accounts: {
      category: { id: '64', name: 'Office Supplies', why: 'its name' },
      paidFrom: null,
    },
    payee: { kind: 'vendor', id: '7', name: 'Harrowgate Office Supply' },
    amountCents: 41334,
    date: '2026-09-14',
    dueDate: '2026-10-14',
    docNumber: 'HOS-1042',
    memo: '',
    lineDescription: 'Bill HOS-1042 from Harrowgate Office Supply',
    currencyRef: null,
  });
  // Past 21 characters, or another vendor's bill has it: the number goes in the memo.
  const long = plan({ answer: bill({ documentNumber: 'N'.repeat(22) }) });
  assert.deepEqual([long.docNumber, long.memo], [null, `Number ${'N'.repeat(22)}.`]);
  const taken = plan({
    answer: bill(),
    lookups: { numberLookup: found(billRow({ vendorId: '88' })) },
  });
  assert.equal(taken.docNumber, null);
  // A new vendor: created with its printed name.
  assert.deepEqual(plan({ answer: bill(), vendor: { status: 'new' } }).payee, {
    kind: 'new_vendor',
    name: 'Harrowgate Office Supply',
    printedName: 'Harrowgate Office Supply',
    nameInUseBy: null,
  });
  // Multicurrency on: CurrencyRef USD on every write.
  assert.equal(
    plan({ answer: bill(), preferences: { multiCurrencyEnabled: true } }).currencyRef,
    'USD',
  );
});

test('a company receipt: an expense from the account picked — CreditCard from a card, Check for a check from a bank, else Cash — never a number', () => {
  const card = plan({ answer: receipt(), vendor: TIDEWELL });
  assert.deepEqual(
    [
      card.operation,
      card.record,
      card.paymentType,
      card.printStatus,
      card.accounts.paidFrom,
      card.docNumber,
    ],
    ['purchase.create', 'expense', 'CreditCard', null, { id: '42', name: 'Visa 4417' }, null],
    'the card named with the printed last four',
  );
  assert.deepEqual(card.payee, { kind: 'vendor', id: '9', name: 'Tidewell Hardware' });
  assert.equal(card.memo, `Receipt 55120 from Tidewell Hardware.`);
  const oneBank = chartWith('35');
  const check = plan({
    answer: receipt({ paymentMethod: 'check' }),
    vendor: TIDEWELL,
    chart: oneBank,
  });
  assert.deepEqual(
    [check.paymentType, check.printStatus, check.accounts.paidFrom],
    ['Check', 'NotSet', { id: '35', name: 'Checking' }],
  );
  for (const method of ['card', 'cash', 'bank_transfer', 'not_shown', 'other']) {
    const bank = plan({
      answer: receipt({ paymentMethod: method }),
      vendor: TIDEWELL,
      chart: oneBank,
    });
    assert.deepEqual([bank.paymentType, bank.printStatus], ['Cash', null], method);
  }
  // A seller that is no vendor: no payee, the seller in the memo and the line (D20).
  assert.deepEqual(plan({ answer: receipt(), vendor: { status: 'new' } }).payee, { kind: 'none' });
  // A tip added: the amount carries it.
  assert.equal(
    plan({
      answer: sampleAnswer('restaurant-tip-under-total'),
      vendor: { status: 'new' },
      chart: chartWith('35', '41'),
    }).amountCents,
    3848,
  );
});

test('a card refund: an expense with Credit true on the card; a vendor credit: its number only with the own-numbers setting on', () => {
  const refund = plan({ answer: sampleAnswer('card-refund'), vendor: { status: 'new' } });
  assert.deepEqual(
    [
      refund.operation,
      refund.record,
      refund.credit,
      refund.paymentType,
      refund.payee,
      refund.memo,
      refund.accounts.paidFrom,
    ],
    [
      'purchase.create',
      'card_refund',
      true,
      'CreditCard',
      { kind: 'none' },
      `Refund R-6603 from Tidewell Hardware.`,
      { id: '42', name: 'Visa 4417' },
    ],
  );
  const credit = plan({ answer: creditNote() });
  assert.deepEqual(
    [credit.operation, credit.record, credit.docNumber, credit.accounts.paidFrom],
    ['vendorCredit.create', 'vendor_credit', null, null],
  );
  assert.equal(credit.memo, `Number CM-0077. Credits invoice HOS-1042.`);
  const numbered = plan({ answer: creditNote(), preferences: { purchaseCustomTxnNumbers: true } });
  assert.deepEqual([numbered.docNumber, numbered.memo], ['CM-0077', `Credits invoice HOS-1042.`]);
});

test("the category (§2.5): by name, by detail type, else Uncategorized Expense — also for other, unclear or disputed; a credit's original bill first", () => {
  const category = (setUp: DecideSetUp) => plan(setUp).accounts.category;
  assert.deepEqual(category({ answer: bill() }), {
    id: '64',
    name: 'Office Supplies',
    why: 'its name',
  });
  assert.deepEqual(category({ answer: bill({ spendType: 'travel' }) }), {
    id: '301',
    name: 'Travel',
    why: 'its name',
  });
  const uncategorized = { id: '300', name: 'Uncategorized Expense', why: 'uncategorized' };
  assert.deepEqual(category({ answer: bill({ spendType: 'other' }) }), uncategorized);
  assert.deepEqual(
    category({ answer: bill({ uncertainFields: ['spendType'] }) }),
    uncategorized,
    'unclear',
  );
  const document = documentOf(check(bill()));
  assert.deepEqual(
    category({ answer: bill(), verification: { ...agreed(document), spendTypeDisputed: true } }),
    uncategorized,
    'disputed',
  );
  // No name on the lists: the one account of the detail type.
  const renamed = {
    ...CHART,
    categories: CHART.categories.map((account) =>
      account.id === '301' ? { ...account, name: 'Trips', fullName: 'Trips' } : account,
    ),
  };
  assert.deepEqual(category({ answer: bill({ spendType: 'travel' }), chart: renamed }), {
    id: '301',
    name: 'Trips',
    why: 'its detail type',
  });
  assert.deepEqual(
    category({
      answer: creditNote(),
      lookups: {
        relatedLookup: found(billRow({ lineAccounts: [{ id: '80', name: 'Cost of Goods Sold' }] })),
      },
    }),
    { id: '80', name: 'Cost of Goods Sold', why: 'the original bill used it' },
  );
  // A bill of two accounts, or another vendor's: the spend type decides.
  const twoAccounts = billRow({
    lineAccounts: [
      { id: '80', name: 'A' },
      { id: '64', name: 'B' },
    ],
  });
  assert.equal(
    category({ answer: creditNote(), lookups: { relatedLookup: found(twoAccounts) } }).id,
    '64',
  );
  assert.equal(
    category({
      answer: creditNote(),
      lookups: { relatedLookup: found(billRow({ vendorId: '88' })) },
    }).why,
    'its name',
  );
});

test('no account could take it — no Uncategorized Expense, no bank or card, a refund with no card — and it is not recorded', () => {
  const none = { ...CHART, categories: [], uncategorized: null };
  assert.deepEqual(decide({ answer: bill({ spendType: 'other' }), chart: none }), {
    outcome: 'not_recorded',
    reason: 'no_uncategorized',
  });
  assert.deepEqual(decide({ answer: receipt(), vendor: TIDEWELL, chart: chartWith() }), {
    outcome: 'not_recorded',
    reason: 'no_paying_account',
  });
  assert.deepEqual(
    decide({ answer: sampleAnswer('card-refund'), vendor: TIDEWELL, chart: chartWith('35') }),
    { outcome: 'not_recorded', reason: 'refund_needs_card' },
  );
});

test("the saved data: one shape held or straight through, never a line, a row or the model's words; the read kept for its details", () => {
  const straight = saved(decide({ answer: bill() }));
  const heldOne = saved(decide({ answer: bill(), config: { holdAboveAmount: 0 } }));
  assert.deepEqual(Object.keys(heldOne), Object.keys(straight));
  assert.deepEqual(heldOne.holdReasons, ['over_limit']);
  assert.deepEqual(straight.holdReasons, []);
  assert.deepEqual(Object.keys(straight), [
    'v',
    'documentType',
    'route',
    'seller',
    'documentNumber',
    'plan',
    'read',
    'receipt',
    'credit',
    'duplicates',
    'recheck',
    'holdReasons',
    'company',
    'preferences',
    'artifactId',
    'modelServed',
  ]);
  assert.equal(straight.v, 2);
  assert.deepEqual(straight.read, {
    documentType: 'bill',
    seller: 'Harrowgate Office Supply',
    number: 'HOS-1042',
    date: '2026-09-14',
    dueDate: '2026-10-14',
    currency: 'USD',
    totalCents: 41334,
    taxCents: 3059,
    spendType: 'office_supplies',
    paymentMethod: 'not_shown',
    cardLast4: null,
  });
  assert.deepEqual(straight.modelServed, {
    first: 'anthropic/claude-haiku-4.5',
    second: 'google/gemini-3.1-flash-lite',
  });
  const tipped = saved(
    decide({
      answer: sampleAnswer('restaurant-tip-under-total'),
      chart: chartWith('35', '41'),
    }),
  );
  assert.deepEqual(tipped.receipt, {
    paymentMethod: 'card',
    tipCents: 600,
    tipAdded: true,
    cardLast4: '3346',
  });
  const credit = saved(
    decide({ answer: creditNote(), lookups: { relatedLookup: found(billRow()) } }),
  );
  assert.deepEqual(credit.credit, { refundMethod: 'credit_on_account', originalBillId: '151' });
  // Not a line, a statement row, an answer field the record does not carry, nor the chart.
  for (const value of [straight, tipped, credit]) {
    const text = JSON.stringify(value);
    for (const absent of [
      'lineItems',
      'listedItems',
      'uncertainFields',
      'extraction',
      'arithmetic',
      'unclearFields',
      '"rows"',
      'Uncategorized Expense',
    ]) {
      assert.ok(!text.includes(absent), absent);
    }
  }
});

test('the saved data stays small with the longest names, and over 32 KiB the run fails cleanly', () => {
  const long = saved(
    decide({
      answer: bill({ vendorName: 'V'.repeat(500), documentNumber: 'N'.repeat(100) }),
      vendor: { status: 'new' },
      company: { name: 'C'.repeat(1_024), legalName: 'L'.repeat(1_024) },
    }),
  );
  assert.ok(savedBytes(long) < 12 * 1024, String(savedBytes(long)));
  assert.equal(SAVED_MAXIMUM_BYTES, 32_768);
  // Ids QuickBooks would never hand one run in such numbers: the guard that should never fire.
  const ids = Array.from({ length: 3_000 }, (_, index) =>
    billRow({
      id: `B${String(index).padStart(11, '0')}`,
      vendorId: '88',
      docNumber: null,
      txnDate: '2026-01-01',
    }),
  );
  const big = decide({ answer: bill(), lookups: { amountLookup: found(...ids) } });
  assert.deepEqual(big, { outcome: 'failed', failure: 'saved_too_large' });
});

test("the planted marker: no sample's reaches a reason or the saved data, on any path", () => {
  let decided = 0;
  for (const sample of SAMPLES) {
    const outcome = check(sample.answer);
    if (outcome.outcome === 'failed' || outcome.recordingRule !== undefined) continue;
    for (const config of [{}, { holdAboveAmount: 0 }]) {
      const said = JSON.stringify(decide({ answer: sample.answer as JsonObject, config }));
      assert.ok(!said.includes(sample.marker), `${sample.name}: the marker`);
      decided += 1;
    }
  }
  assert.equal(decided, 40, 'the 20 samples QuickBooks could record, each straight and held');
});
