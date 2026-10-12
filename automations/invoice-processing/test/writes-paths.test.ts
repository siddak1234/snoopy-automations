import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REFUSED_BODY_FIELDS, refusedFieldOf } from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';

import type { SavedState } from '../src/decide/saved.js';
import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import { PAID, type RouteRun } from './lookups-world.js';
import { assertOutputValid } from './output-schema.js';
import {
  CONTINUATION_RUN_ID,
  approve,
  expenseLine,
  firstRun,
  heldState,
  journalLine,
  outputOf,
  runLine,
  writesOf,
} from './writes-world.js';

/**
 * Every path end to end on the simulator (the plan's §2.6, §2.8, §5 "Writes"), straight through and
 * held then approved: exactly the record decide planned is created — one request, the body below,
 * the memo naming the run that wrote it (after an approval the continuation, the recommended
 * answer) — and nothing else; CurrencyRef USD with multicurrency on; a rejected or expired approval,
 * and a statement, create nothing; every output holds to the manifest's outputSchema.
 */

const FIRST_RUN_ID = '11111111-1111-4111-8111-111111111111';
const HOLD_ALL = { holdAboveAmount: 0 };

/** Each path's document, settings and inputs, and the body create-record sends, for a run id. */
const PATHS: readonly [string, RouteRun, (runId: string) => readonly [string, JsonObject]][] = [
  [
    'a bill',
    { answer: bill() },
    (runId) => [
      'bill.create',
      {
        VendorRef: { value: '7' },
        TxnDate: '2026-09-14',
        DueDate: '2026-10-14',
        DocNumber: 'HOS-1042',
        PrivateNote: runLine(runId),
        Line: [expenseLine(413.34, 'Bill HOS-1042 from Harrowgate Office Supply', '57')],
      },
    ],
  ],
  [
    'a company receipt on the card',
    { answer: receipt() },
    (runId) => [
      'purchase.create',
      {
        PaymentType: 'CreditCard',
        AccountRef: { value: '41' },
        TxnDate: '2026-09-27',
        EntityRef: { value: '9', type: 'Vendor' },
        PrivateNote: `${runLine(runId)} Receipt 55120 from Tidewell Hardware.`,
        Line: [expenseLine(60.63, 'Receipt 55120 from Tidewell Hardware', '57')],
      },
    ],
  ],
  [
    'a company receipt paid by check from the bank',
    { answer: receipt({ paymentMethod: 'check' }), ...PAID.bank },
    (runId) => [
      'purchase.create',
      {
        PaymentType: 'Check',
        AccountRef: { value: '35' },
        TxnDate: '2026-09-27',
        EntityRef: { value: '9', type: 'Vendor' },
        PrintStatus: 'NotSet',
        PrivateNote: `${runLine(runId)} Receipt 55120 from Tidewell Hardware.`,
        Line: [expenseLine(60.63, 'Receipt 55120 from Tidewell Hardware', '57')],
      },
    ],
  ],
  [
    'a company receipt paid by card from the bank, its seller no vendor',
    {
      answer: receipt(),
      bare: true,
      config: { ...PAID.bank.config, companyCardLast4: '4417' },
    },
    (runId) => [
      'purchase.create',
      {
        PaymentType: 'Cash',
        AccountRef: { value: '35' },
        TxnDate: '2026-09-27',
        PrivateNote: `${runLine(runId)} Receipt 55120 from Tidewell Hardware.`,
        Line: [expenseLine(60.63, 'Receipt 55120 from Tidewell Hardware', '57')],
      },
    ],
  ],
  [
    'a card refund',
    { answer: sampleAnswer('card-refund') },
    (runId) => [
      'purchase.create',
      {
        PaymentType: 'CreditCard',
        AccountRef: { value: '41' },
        TxnDate: '2026-10-02',
        EntityRef: { value: '9', type: 'Vendor' },
        Credit: true,
        PrivateNote: `${runLine(runId)} Refund R-6603 from Tidewell Hardware.`,
        Line: [expenseLine(23.72, 'Refund R-6603 from Tidewell Hardware', '57')],
      },
    ],
  ],
  [
    'a vendor credit, its number in the memo (own numbers not on)',
    { answer: creditNote() },
    (runId) => [
      'vendorCredit.create',
      {
        VendorRef: { value: '7' },
        TxnDate: '2026-09-22',
        PrivateNote: `${runLine(runId)} Number CM-0077. Credits invoice HOS-1042.`,
        Line: [expenseLine(203.2, 'Credit note CM-0077 from Harrowgate Office Supply', '57')],
      },
    ],
  ],
  [
    'an employee who paid',
    { answer: receipt(), ...PAID.employee },
    (runId) => [
      'journalEntry.create',
      {
        TxnDate: '2026-09-27',
        PrivateNote: `${runLine(runId)} Robin Example paid Tidewell Hardware, receipt 55120.`,
        Line: [
          journalLine(60.63, 'Tidewell Hardware, receipt 55120', 'Debit', '57'),
          journalLine(60.63, 'Tidewell Hardware, receipt 55120', 'Credit', '120', '55'),
        ],
      },
    ],
  ],
  [
    'an owner who paid',
    { answer: receipt(), ...PAID.owner },
    (runId) => [
      'journalEntry.create',
      {
        TxnDate: '2026-09-27',
        PrivateNote: `${runLine(runId)} Pat Owner paid Tidewell Hardware, receipt 55120.`,
        Line: [
          journalLine(60.63, 'Pat Owner paid Tidewell Hardware, receipt 55120', 'Debit', '57'),
          journalLine(60.63, 'Pat Owner paid Tidewell Hardware, receipt 55120', 'Credit', '125'),
        ],
      },
    ],
  ],
  [
    'a contractor who paid',
    { answer: receipt(), ...PAID.contractor },
    (runId) => [
      'bill.create',
      {
        VendorRef: { value: '31' },
        TxnDate: '2026-09-27',
        PrivateNote: `${runLine(runId)} Sam Lee paid Tidewell Hardware, receipt 55120.`,
        Line: [expenseLine(60.63, 'Tidewell Hardware, receipt 55120', '57')],
      },
    ],
  ],
];

/** The paths that always hold: a person who paid (D16). */
const ALWAYS_HELD = new Set(['an employee who paid', 'an owner who paid', 'a contractor who paid']);

/** The run held, whatever its amount. */
const held = (run: RouteRun): RouteRun => ({
  ...run,
  config: { ...(run.config ?? PAID.company.config), ...HOLD_ALL },
});

function assertNoRefusedField(body: JsonObject, label: string): void {
  const top = Object.keys(body).map((key) => key.toLowerCase());
  for (const field of REFUSED_BODY_FIELDS) {
    assert.ok(!top.includes(field.toLowerCase()), `${label}: names ${field}`);
  }
}

test('straight through: each path creates exactly the record decide planned, in one request, the memo naming the run', async () => {
  for (const [label, run, body] of PATHS) {
    if (ALWAYS_HELD.has(label)) continue;
    const world = await firstRun(run);
    const output = outputOf(world.result);
    assert.deepEqual(writesOf(world.platform.providerCalls), [body(FIRST_RUN_ID)], label);
    assert.equal(output.decidedBy, 'automatically', label);
    assertOutputValid(output, label);
    // Created once, and the record QuickBooks keeps is the one its answer named.
    const record = output.record as JsonObject;
    const [operation] = body(FIRST_RUN_ID);
    const held = {
      'bill.create': world.simulator.company.bills,
      'purchase.create': world.simulator.company.purchases,
      'vendorCredit.create': world.simulator.company.vendorCredits,
      'journalEntry.create': world.simulator.company.journalEntries,
    }[operation];
    assert.deepEqual(
      held?.map((row) => row.Id),
      [record.id],
      label,
    );
  }
});

test('held, then approved: every path creates exactly the record decide saved — the continuation writes it, its memo naming the continuation', async () => {
  for (const [label, run, body] of PATHS) {
    const first = await firstRun(ALWAYS_HELD.has(label) ? run : held(run));
    const state = heldState(first) as unknown as SavedState;
    assert.deepEqual(
      writesOf(first.platform.providerCalls),
      [],
      `${label}: the held run wrote nothing`,
    );
    const approved = await approve(first);
    const output = outputOf(approved.result);
    assert.deepEqual(writesOf(approved.providerCalls), [body(CONTINUATION_RUN_ID)], label);
    assert.equal(output.decidedBy, 'after approval', label);
    assert.deepEqual(output.holdReasons, state.holdReasons, label);
    // QuickBooks' total for the record; a journal entry's TotalAmt is always 0, so none.
    assert.equal(
      (output.record as JsonObject).quickBooksTotalCents,
      state.plan.record === 'journal_entry' ? null : state.plan.amountCents,
      label,
    );
    assertOutputValid(output, label);
    // The amount, date, accounts and memo words are the saved plan's, whatever the settings now say.
    const [, sent] = body(CONTINUATION_RUN_ID);
    assert.equal(sent.TxnDate, state.plan.date, label);
    assert.ok(String(sent.PrivateNote).endsWith(state.plan.memo), label);
    assertNoRefusedField(sent, label);
  }
});

test('approval writes the saved plan, never the settings as they are by then', async () => {
  const first = await firstRun(held({ answer: receipt() }));
  // Paid from and the category changed while it waited: the plan's accounts are still written.
  const approved = await approve(first, {
    config: {
      expenseAccount: 'Office Supplies',
      paidFromAccount: 'Checking',
      categoryRepairsAndMaintenance: 'Meals',
    },
  });
  const [[, body]] = writesOf(approved.providerCalls) as [[string, JsonObject]];
  assert.deepEqual([body.PaymentType, body.AccountRef], ['CreditCard', { value: '41' }]);
  assert.deepEqual((body.Line as JsonObject[])[0]?.AccountBasedExpenseLineDetail, {
    AccountRef: { value: '57' },
  });
});

test('with multicurrency on, every write sends CurrencyRef USD (sandbox S13); off, none', async () => {
  const multicurrency = (run: RouteRun): RouteRun => ({
    ...run,
    company: (sim) => {
      run.company?.(sim);
      (sim.company.preferences.CurrencyPrefs as JsonObject).MultiCurrencyEnabled = true;
    },
  });
  for (const [label, run] of PATHS) {
    const first = await firstRun(multicurrency(ALWAYS_HELD.has(label) ? run : held(run)));
    const approved = await approve(first);
    const writes = writesOf(approved.providerCalls);
    assert.equal(writes.length, 1, label);
    assert.deepEqual(writes[0]?.[1].CurrencyRef, { value: 'USD' }, label);
  }
  const off = await firstRun({ answer: bill() });
  assert.equal(writesOf(off.platform.providerCalls)[0]?.[1].CurrencyRef, undefined);
});

test('a new vendor approved: confirm-vendor finds none, create-vendor adds it as the approver saw it, the bill names it', async () => {
  const first = await firstRun({ answer: bill(), bare: true });
  assert.deepEqual(heldState(first).holdReasons, ['new_vendor']);
  const approved = await approve(first);
  assert.deepEqual(writesOf(approved.providerCalls), [
    [
      'vendor.create',
      { DisplayName: 'Harrowgate Office Supply', CompanyName: 'Harrowgate Office Supply' },
    ],
    [
      'bill.create',
      {
        VendorRef: { value: '1001' },
        TxnDate: '2026-09-14',
        DueDate: '2026-10-14',
        DocNumber: 'HOS-1042',
        PrivateNote: runLine(CONTINUATION_RUN_ID),
        Line: [expenseLine(413.34, 'Bill HOS-1042 from Harrowgate Office Supply', '57')],
      },
    ],
  ]);
  assert.deepEqual(
    approved.steps.map(([stepId, outcome]) => [stepId, outcome]),
    [
      ['confirm-company', 'ok'],
      ['confirm-vendor', 'ok'],
      ['create-vendor', 'ok'],
      ['confirm-no-duplicate', 'ok'],
      ['create-record', 'ok'],
    ],
  );
  assert.equal(
    approved.steps[2]?.[2],
    "Added vendor 'Harrowgate Office Supply' to QuickBooks (Id 1001)",
  );
  const output = outputOf(approved.result);
  assert.deepEqual(output.newVendor, {
    how: 'created',
    id: '1001',
    displayName: 'Harrowgate Office Supply',
  });
  assertOutputValid(output);
});

test('a rejected or an expired approval creates nothing; a statement creates nothing and never waits', async () => {
  const first = await firstRun(held({ answer: bill() }));
  // Expired: the platform mints no continuation, and the held run wrote nothing.
  assert.deepEqual(writesOf(first.platform.providerCalls), []);
  assert.deepEqual(first.simulator.company.bills, []);
  // Rejected: were one ever minted, the runner refuses it before any step runs.
  const rejected = await approve(first, { decision: 'rejected' });
  assert.deepEqual(rejected.result, {
    outcome: 'failed',
    failureReason: 'the approval continuation was not approved',
  });
  assert.deepEqual([rejected.steps, rejected.providerCalls], [[], []]);
  assert.deepEqual(first.simulator.company.bills, []);
  const compared = await firstRun({ answer: statement() });
  assert.deepEqual(writesOf(compared.platform.providerCalls), []);
  assert.equal(outputOf(compared.result).outcome, 'compared');
  assertOutputValid(outputOf(compared.result));
});

test('the same continuation dispatched twice — one key per step — makes one record: the platform replays the first answer', async () => {
  const first = await firstRun(held({ answer: receipt() }));
  const once = await approve(first);
  const twice = await approve(first);
  assert.deepEqual(outputOf(twice.result), outputOf(once.result));
  assert.equal(first.simulator.company.purchases.length, 1);
  assert.equal(
    first.simulator.calls.filter((call) => call.outcome === 'replayed').length > 0,
    true,
  );
});

test('no body a write sends names Id, SyncToken or sparse at the top level, in any case (the platform refuses one: refused_field)', async () => {
  for (const [label, run] of PATHS) {
    const first = await firstRun(ALWAYS_HELD.has(label) ? run : held(run));
    const approved = await approve(first);
    for (const [operation, body] of writesOf(approved.providerCalls)) {
      assert.equal(refusedFieldOf(operation, body), undefined, label);
      assertNoRefusedField(body, label);
    }
  }
  const vendor = await approve(await firstRun({ answer: bill(), bare: true }));
  for (const [operation, body] of writesOf(vendor.providerCalls)) {
    assert.equal(refusedFieldOf(operation, body), undefined, operation);
  }
});
