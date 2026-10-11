import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { SAVED_MAXIMUM_BYTES, savedBytes } from '../src/decide/saved.js';
import type { Decision } from '../src/decide/decide.js';
import { CHECKING, bill, creditNote, paidBy, receipt, sampleAnswer } from './check-world.js';
import {
  RUN_ID,
  VENDOR,
  agreed,
  billRow,
  decide,
  found,
  heldOf,
  type DecideSetUp,
} from './decide-world.js';
import { check, documentOf } from './check-world.js';
import { SAMPLES } from './sample-maker/samples.js';

/**
 * The record decide plans and saves for after approval (the plan's §2.6, §2.8; D27): built once,
 * one shape for held and straight through, the operation, payment type, accounts by role, payee,
 * amount, number or memo and currency rule per path; never a line, a row or the model's words;
 * refused over 32 KiB.
 */

const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };
const CREATED = `Created by Autom8x Bills & Receipts, run ${RUN_ID}.`;

function saved(decision: Decision) {
  assert.ok(decision.outcome === 'ok' || decision.outcome === 'held', decision.outcome);
  return decision.saved;
}
const plan = (setUp: DecideSetUp) => saved(decide(setUp)).plan;

test('a bill: bill.create to the vendor, its due date, its number when QuickBooks can take it, one line to the category', () => {
  assert.deepEqual(plan({ answer: bill() }), {
    operation: 'bill.create',
    record: 'bill',
    paymentType: null,
    credit: false,
    printStatus: null,
    accounts: {
      category: { id: '64', name: 'Office Supplies', why: 'office supplies' },
      paidFrom: null,
      liability: null,
      equity: null,
    },
    payee: { kind: 'vendor', id: '7', name: 'Harrowgate Office Supply' },
    amountCents: 41334,
    date: '2026-09-14',
    dueDate: '2026-10-14',
    docNumber: 'HOS-1042',
    memo: CREATED,
    lineDescription: 'Bill HOS-1042 from Harrowgate Office Supply',
    currencyRef: null,
  });
  // Past 21 characters, or another vendor's bill has it: the number goes in the memo.
  const long = plan({ answer: bill({ documentNumber: 'N'.repeat(22) }) });
  assert.deepEqual([long.docNumber, long.memo], [null, `${CREATED} Number ${'N'.repeat(22)}.`]);
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

test('a company receipt: an expense from Paid from — CreditCard from a card, Check for a check from a bank, else Cash — never a number', () => {
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
    ['purchase.create', 'expense', 'CreditCard', null, { id: '41', name: 'Company Visa' }, null],
  );
  assert.deepEqual(card.payee, { kind: 'vendor', id: '9', name: 'Tidewell Hardware' });
  assert.equal(card.memo, `${CREATED} Receipt 55120 from Tidewell Hardware.`);
  const check = plan({
    answer: receipt({ paymentMethod: 'check' }),
    vendor: TIDEWELL,
    check: { paidFrom: CHECKING },
  });
  assert.deepEqual([check.paymentType, check.printStatus], ['Check', 'NotSet']);
  for (const method of ['card', 'cash', 'bank_transfer', 'not_shown', 'other']) {
    const bank = plan({
      answer: receipt({ paymentMethod: method }),
      vendor: TIDEWELL,
      check: { paidFrom: CHECKING },
      config: { companyCardLast4: '4417' },
    });
    assert.deepEqual([bank.paymentType, bank.printStatus], ['Cash', null], method);
  }
  // A seller that is no vendor: no payee, the seller in the memo and the line (D20).
  assert.deepEqual(plan({ answer: receipt(), vendor: { status: 'new' } }).payee, { kind: 'none' });
  // A tip added: the amount carries it.
  assert.equal(
    plan({ answer: sampleAnswer('restaurant-tip-under-total'), vendor: { status: 'new' } })
      .amountCents,
    3848,
  );
});

test('a card refund: an expense with Credit true on the card; a vendor credit: its number only with the own-numbers setting on', () => {
  const refund = plan({ answer: sampleAnswer('card-refund'), vendor: { status: 'new' } });
  assert.deepEqual(
    [refund.operation, refund.record, refund.credit, refund.paymentType, refund.payee, refund.memo],
    [
      'purchase.create',
      'card_refund',
      true,
      'CreditCard',
      { kind: 'none' },
      `${CREATED} Refund R-6603 from Tidewell Hardware.`,
    ],
  );
  const credit = plan({ answer: creditNote() });
  assert.deepEqual(
    [credit.operation, credit.record, credit.docNumber],
    ['vendorCredit.create', 'vendor_credit', null],
  );
  assert.equal(credit.memo, `${CREATED} Number CM-0077. Credits invoice HOS-1042.`);
  const numbered = plan({ answer: creditNote(), preferences: { purchaseCustomTxnNumbers: true } });
  assert.deepEqual(
    [numbered.docNumber, numbered.memo],
    ['CM-0077', `${CREATED} Credits invoice HOS-1042.`],
  );
});

test("paid personally: a journal entry owing the employee, or to the owner's equity; a bill to the contractor; the seller and number in the text", () => {
  const employee = plan({ answer: receipt(), check: paidBy('employee', { paidFrom: null }) });
  assert.deepEqual(
    [
      employee.operation,
      employee.record,
      employee.payee,
      employee.accounts.liability,
      employee.accounts.equity,
    ],
    [
      'journalEntry.create',
      'journal_entry',
      { kind: 'employee', id: '55', name: 'Robin Example' },
      { id: '120', name: 'Owed to Team Members' },
      null,
    ],
  );
  assert.equal(employee.lineDescription, 'Tidewell Hardware, receipt 55120');
  assert.equal(employee.memo, `${CREATED} Robin Example paid Tidewell Hardware, receipt 55120.`);
  const owner = plan({ answer: receipt(), check: paidBy('owner', { paidFrom: null }) });
  assert.deepEqual(
    [owner.payee, owner.accounts.equity, owner.accounts.liability],
    [{ kind: 'owner', name: 'Pat Owner' }, { id: '125', name: 'Owner investments' }, null],
  );
  assert.equal(owner.lineDescription, 'Pat Owner paid Tidewell Hardware, receipt 55120');
  const contractor = plan({
    answer: bill(),
    check: paidBy('not_employee', { paidFrom: null }),
    vendor: { ...VENDOR, id: '31', displayName: 'Sam Lee' },
  });
  assert.deepEqual(
    [contractor.operation, contractor.payee, contractor.docNumber, contractor.dueDate],
    ['bill.create', { kind: 'vendor', id: '31', name: 'Sam Lee' }, null, null],
  );
  assert.equal(contractor.memo, `${CREATED} Sam Lee paid Harrowgate Office Supply, bill HOS-1042.`);
});

test("the category (D27): the setting for the spend type; the default when unset, other, unclear or disputed; a credit's original bill", () => {
  const category = (setUp: DecideSetUp) => plan(setUp).accounts.category;
  assert.deepEqual(category({ answer: bill() }), {
    id: '64',
    name: 'Office Supplies',
    why: 'office supplies',
  });
  assert.deepEqual(category({ answer: bill({ spendType: 'travel' }) }), {
    id: '57',
    name: 'Utilities:Electric',
    why: 'no category set for travel',
  });
  assert.deepEqual(category({ answer: bill({ spendType: 'other' }) }), {
    id: '57',
    name: 'Utilities:Electric',
    why: 'spend type other',
  });
  assert.deepEqual(category({ answer: bill({ uncertainFields: ['spendType'] }) }), {
    id: '57',
    name: 'Utilities:Electric',
    why: 'spend type unclear',
  });
  const document = documentOf(check(bill()));
  assert.deepEqual(
    category({ answer: bill(), verification: { ...agreed(document), spendTypeDisputed: true } }),
    {
      id: '57',
      name: 'Utilities:Electric',
      why: 'the reads disagree on the spend type',
    },
  );
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
  assert.equal(
    category({
      answer: creditNote(),
      lookups: {
        relatedLookup: found(
          billRow({
            lineAccounts: [
              { id: '80', name: 'A' },
              { id: '64', name: 'B' },
            ],
          }),
        ),
      },
    }).id,
    '64',
  );
  assert.equal(
    category({
      answer: creditNote(),
      lookups: { relatedLookup: found(billRow({ vendorId: '88' })) },
    }).why,
    'office supplies',
  );
  // Shown on every approval's line.
  const held = heldOf(decide({ answer: bill(), config: { holdAboveAmount: 0 } }));
  assert.match(held.summary, /category Office Supplies \(office supplies\)/u);
});

test("the saved data: one shape held or straight through, never a line, a row or the model's words; the payer, receipt and credit facts", () => {
  const straight = saved(decide({ answer: bill() }));
  const heldOne = saved(decide({ answer: bill(), config: { holdAboveAmount: 0 } }));
  assert.deepEqual(Object.keys(heldOne), Object.keys(straight));
  assert.deepEqual(heldOne.holdReasons, ['over_limit']);
  assert.deepEqual(straight.holdReasons, []);
  assert.deepEqual(Object.keys(straight), [
    'v',
    'documentType',
    'route',
    'plan',
    'payer',
    'receipt',
    'credit',
    'duplicates',
    'holdReasons',
    'company',
    'preferences',
    'artifactId',
    'modelServed',
  ]);
  assert.deepEqual(straight.modelServed, {
    first: 'anthropic/claude-haiku-4.5',
    second: 'google/gemini-3.1-flash-lite',
  });
  const employee = saved(
    decide({
      answer: sampleAnswer('restaurant-tip-under-total'),
      check: paidBy('employee', { paidFrom: null }),
    }),
  );
  assert.deepEqual(employee.payer, {
    route: 'employee',
    id: '55',
    name: 'Robin Example',
    vendor1099: null,
  });
  assert.deepEqual(employee.receipt, {
    paymentMethod: 'card',
    tipCents: 600,
    tipAdded: true,
    cardLast4: '3346',
  });
  const owner = saved(decide({ answer: receipt(), check: paidBy('owner', { paidFrom: null }) }));
  assert.equal(owner.payer?.id, 'owner');
  const contractor = saved(
    decide({
      answer: receipt(),
      check: paidBy('not_employee', { paidFrom: null }),
      vendor: { ...VENDOR, id: '31', vendor1099: true },
    }),
  );
  assert.deepEqual(contractor.payer, {
    route: 'contractor',
    id: '31',
    name: 'Sam Lee',
    vendor1099: true,
  });
  const credit = saved(
    decide({ answer: creditNote(), lookups: { relatedLookup: found(billRow()) } }),
  );
  assert.deepEqual(credit.credit, { refundMethod: 'credit_on_account', originalBillId: '151' });
  // Not a line, a statement row, an answer field the record does not carry.
  for (const value of [straight, employee, credit]) {
    const text = JSON.stringify(value);
    for (const absent of [
      'lineItems',
      'listedItems',
      'uncertainFields',
      'extraction',
      'arithmetic',
      'unclearFields',
      '"rows"',
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
  assert.deepEqual(big, {
    outcome: 'failed',
    failure: 'saved_too_large',
    sentence:
      'Bills & Receipts could not save this document for approval. Run it again. Nothing was created.',
  });
});

test("the planted marker: no sample's reaches a line, a reason, a sentence or the saved data, on any path", () => {
  let decided = 0;
  for (const sample of SAMPLES) {
    if (check(sample.answer).outcome === 'failed') continue;
    for (const config of [{}, { holdAboveAmount: 0 }]) {
      const said = JSON.stringify(decide({ answer: sample.answer as JsonObject, config }));
      assert.ok(!said.includes(sample.marker), `${sample.name}: the marker`);
      decided += 1;
    }
  }
  assert.equal(decided, 40, 'the 20 samples check-document passes, each straight and held');
});
