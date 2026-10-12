import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROVIDER_REFUSALS,
  faultAnswer,
  type ScriptedAnswer,
} from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';

import { DECIDE_SENTENCES } from '../src/decide/fails.js';
import { LOOKUP_SENTENCES } from '../src/lookups/read.js';
import { AFTER_APPROVAL_SENTENCES } from '../src/writes/sentences.js';
import { bill, receipt } from './check-world.js';
import {
  PAID,
  REF,
  sampleBill,
  sampleCustomer,
  sampleJournalEntry,
  samplePurchase,
  sampleVendor,
  type RouteRun,
} from './lookups-world.js';
import { approve, firstRun, heldState, outputOf, writesOf } from './writes-world.js';

/**
 * The checks a wait calls for, after an approval and before anything is written (the plan's §2.0
 * steps 19–22, §5; ip-review design-after-approval-writes-notify-tests.json steps[0]–[3]): the same
 * company, the new vendor added meanwhile, the vendor added now, no matching record added
 * meanwhile — each skipped in a first run, each ending the run in a fixed sentence before any write
 * when it must, and a held state that does not read back whole stopped before any QuickBooks call.
 */

const HOLD_ALL = { ...PAID.company.config, holdAboveAmount: 0 };
const heldBill = (run: Partial<RouteRun> = {}) =>
  firstRun({ answer: bill(), config: HOLD_ALL, ...run });

const COMPANY = AFTER_APPROVAL_SENTENCES.company_changed;
const DUPLICATE =
  'A matching record was added in QuickBooks while this waited for approval, possibly from your bank feed. Nothing was created.';
const DUPLICATE_AFTER_VENDOR =
  'A matching record was added in QuickBooks while this waited for approval, possibly from your bank feed. No bill was created. The new vendor was added to QuickBooks.';

test('a first run — straight through — reports none of the four checks and makes no call for them', async () => {
  const world = await firstRun({ answer: bill(), bare: false });
  const reported = world.platform.steps.map((step) => step.stepId);
  for (const stepId of [
    'confirm-company',
    'confirm-vendor',
    'create-vendor',
    'confirm-no-duplicate',
  ]) {
    assert.ok(!reported.includes(stepId), stepId);
  }
  assert.equal(
    world.platform.providerCalls.filter((call) => call.operation === 'companyInfo.get').length,
    1,
    "read-company's alone",
  );
});

test('confirm-company: the same company continues; another name, legal name, country or creation time fails before anything is written', async () => {
  const same = await approve(await heldBill());
  assert.equal(same.steps[0]?.[2], 'Same QuickBooks company as when this was held: Sample Bakery');
  assert.equal(same.result.outcome, 'success');
  const changes: [string, (info: JsonObject) => void][] = [
    ['name', (info) => (info.CompanyName = 'Other Bakery')],
    ['name, in case only', (info) => (info.CompanyName = 'SAMPLE BAKERY')],
    ['legal name', (info) => (info.LegalName = 'Other Bakery LLC')],
    ['legal name gone', (info) => delete info.LegalName],
    ['country', (info) => (info.Country = 'CA')],
    // A copy or a sandbox with the same names: only the creation time tells it apart.
    ['creation time', (info) => (info.MetaData = { CreateTime: '2025-03-04T10:00:00-08:00' })],
  ];
  for (const [label, change] of changes) {
    const first = await heldBill();
    change(first.simulator.company.companyInfo);
    const approved = await approve(first);
    assert.deepEqual(approved.result, { outcome: 'failed', failureReason: COMPANY }, label);
    assert.match(
      approved.steps[0]?.[2] ?? '',
      /^Company not confirmed: its .+ changed \(company_changed\)$/u,
    );
    assert.deepEqual(writesOf(approved.providerCalls), [], label);
  }
  // Cleaned on both sides; the same instant in another offset; a creation time one answer lacks.
  for (const change of [
    (info: JsonObject) => (info.CompanyName = ' Sample  Bakery '),
    (info: JsonObject) => (info.MetaData = { CreateTime: '2024-01-02T17:00:00Z' }),
    (info: JsonObject) => delete info.MetaData,
  ]) {
    const first = await heldBill();
    change(first.simulator.company.companyInfo);
    assert.equal((await approve(first)).result.outcome, 'success');
  }
});

test('confirm-company: QuickBooks disconnected while it waited, or refusing, ends with its sentence and no write', async () => {
  const first = await heldBill();
  first.simulator.connected = false;
  const approved = await approve(first);
  assert.deepEqual(approved.result, {
    outcome: 'failed',
    failureReason: 'Reconnect QuickBooks in Connections, then run it again.',
  });
  assert.deepEqual(approved.providerCalls.length, 1);
});

test('confirm-vendor: the new vendor added while it waited, in any case, is linked and never created', async () => {
  const first = await firstRun({ answer: bill(), bare: true });
  first.simulator.company.vendors.push(sampleVendor('77', 'HARROWGATE OFFICE SUPPLY'));
  const approved = await approve(first);
  assert.equal(
    approved.steps.find(([stepId]) => stepId === 'confirm-vendor')?.[2],
    "Vendor 'HARROWGATE OFFICE SUPPLY' was added to QuickBooks while this waited (Id 77); the bill will use it",
  );
  assert.equal(
    approved.steps.find(([stepId]) => stepId === 'create-vendor'),
    undefined,
  );
  const writes = writesOf(approved.providerCalls);
  assert.deepEqual(
    writes.map(([operation, body]) => [operation, body.VendorRef]),
    [['bill.create', { value: '77' }]],
  );
  const output = outputOf(approved.result);
  assert.deepEqual(output.newVendor, {
    how: 'found',
    id: '77',
    displayName: 'HARROWGATE OFFICE SUPPLY',
  });
  assert.equal(first.simulator.company.vendors.length, 1, 'no vendor created');
  // The query: the name it would be created with, active or not.
  const query = approved.providerCalls.find(
    (call) => call.operation === 'query.run' && String(call.input.query).includes('FROM Vendor'),
  );
  assert.equal(
    query?.input.query,
    "SELECT * FROM Vendor WHERE DisplayName = 'Harrowgate Office Supply' AND Active IN (true, false) MAXRESULTS 2",
  );
});

test("confirm-vendor: '(vendor)' is the name looked up; inactive, two, or in another currency fails before anything is written", async () => {
  const named = await firstRun({
    answer: bill(),
    bare: true,
    company: (sim) => sim.company.customers.push(sampleCustomer('20', 'Harrowgate Office Supply')),
  });
  const approved = await approve(named);
  assert.deepEqual(writesOf(approved.providerCalls)[0], [
    'vendor.create',
    {
      DisplayName: 'Harrowgate Office Supply (vendor)',
      CompanyName: 'Harrowgate Office Supply',
    },
  ]);
  assert.match(
    approved.steps.find(([id]) => id === 'create-vendor')?.[2] ?? '',
    /because a customer has that name$/u,
  );
  const cases: [string, JsonObject[], string][] = [
    [
      'inactive',
      [sampleVendor('77', 'Harrowgate Office Supply', { Active: false })],
      LOOKUP_SENTENCES.vendor_inactive,
    ],
    [
      'two',
      [
        sampleVendor('77', 'Harrowgate Office Supply'),
        sampleVendor('78', 'harrowgate office supply'),
      ],
      LOOKUP_SENTENCES.vendor_ambiguous,
    ],
    [
      'in CAD',
      [sampleVendor('77', 'Harrowgate Office Supply', { CurrencyRef: { value: 'CAD' } })],
      DECIDE_SENTENCES.F2,
    ],
  ];
  for (const [label, vendors, sentence] of cases) {
    const first = await firstRun({ answer: bill(), bare: true });
    first.simulator.company.vendors.push(...vendors);
    const failed = await approve(first);
    assert.deepEqual(failed.result, { outcome: 'failed', failureReason: sentence }, label);
    assert.deepEqual(writesOf(failed.providerCalls), [], label);
  }
});

test('create-vendor: a printed name past 100 characters is no company name, and past 100 its check name is the printed name cut to 100 (the recommended answer)', async () => {
  const long = `Harrowgate ${'Office '.repeat(15)}Supply`;
  assert.ok(long.length > 100);
  const first = await firstRun({ answer: bill({ vendorName: long }), bare: true });
  const approved = await approve(first);
  const [[operation, body]] = writesOf(approved.providerCalls) as [[string, JsonObject]];
  assert.equal(operation, 'vendor.create');
  assert.deepEqual(body, { DisplayName: long, PrintOnCheckName: long.slice(0, 100).trimEnd() });
  assert.equal(approved.result.outcome, 'success');
});

test('create-vendor: QuickBooks refusing, or not confirming, ends the run in a fixed sentence, the bill never sent', async () => {
  const cases: [string, ScriptedAnswer[], string][] = [
    [
      '6240',
      [{ status: 400, body: faultAnswer('6240') }],
      AFTER_APPROVAL_SENTENCES.vendor_name_in_use,
    ],
    [
      '2050',
      [{ status: 400, body: faultAnswer('2050') }],
      AFTER_APPROVAL_SENTENCES.vendor_name_too_long,
    ],
    [
      '6190',
      [{ status: 400, body: faultAnswer('6190') }],
      AFTER_APPROVAL_SENTENCES.vendor_subscription_ended,
    ],
    [
      'another code',
      [{ status: 400, body: faultAnswer('6000') }],
      AFTER_APPROVAL_SENTENCES.vendor_refused,
    ],
    ['a 429', [{ status: 429 }], AFTER_APPROVAL_SENTENCES.vendor_unconfirmed],
    ['a lost answer', [{ lost: 'before_record' }], AFTER_APPROVAL_SENTENCES.vendor_unconfirmed],
    [
      'Fault 600',
      [{ status: 400, body: faultAnswer('600') }],
      AFTER_APPROVAL_SENTENCES.vendor_unconfirmed,
    ],
  ];
  for (const [label, script, sentence] of cases) {
    const first = await firstRun({ answer: bill(), bare: true });
    first.simulator.script('vendor.create', script);
    const approved = await approve(first);
    assert.deepEqual(approved.result, { outcome: 'failed', failureReason: sentence }, label);
    assert.deepEqual(
      writesOf(approved.providerCalls).map(([operation]) => operation),
      ['vendor.create'],
      `${label}: one request, never repeated, no bill`,
    );
  }
});

test('confirm-no-duplicate: a record the rule matches, added while it waited — by hand or from the bank feed — fails; what the approver saw is allowed', async () => {
  // A bill: the same vendor's bill with its number.
  const billRun = await heldBill();
  billRun.simulator.company.bills.push(
    sampleBill('160', REF.harrowgate, { DocNumber: 'hos-1042', TotalAmt: 413.34 }),
  );
  const billed = await approve(billRun);
  assert.deepEqual(billed.result, { outcome: 'failed', failureReason: DUPLICATE });
  assert.deepEqual(writesOf(billed.providerCalls), []);
  assert.equal(
    billed.steps.at(-1)?.[2],
    'A matching record was added while this waited: Id 160 (duplicate_appeared)',
  );
  // The query: find-duplicate-number's, one row more.
  assert.equal(
    billed.providerCalls.at(-1)?.input.query,
    "SELECT * FROM Bill WHERE DocNumber = 'HOS-1042' MAXRESULTS 4",
  );
  // A company receipt: the bank feed brought the charge.
  const receiptRun = await firstRun({ answer: receipt(), config: HOLD_ALL });
  receiptRun.simulator.company.purchases.push(
    samplePurchase('210', REF.visa, { TxnDate: '2026-09-28', TotalAmt: 60.63 }),
  );
  const fed = await approve(receiptRun);
  assert.deepEqual(fed.result, { outcome: 'failed', failureReason: DUPLICATE });
  assert.equal(
    fed.providerCalls.at(-1)?.input.query,
    "SELECT * FROM Purchase WHERE TotalAmt = '60.63' AND TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' MAXRESULTS 4",
  );
  // An employee's: an entry that day owing them the amount.
  const employeeRun = await firstRun({ answer: receipt(), ...PAID.employee });
  employeeRun.simulator.company.journalEntries.push(
    sampleJournalEntry(
      '410',
      60.63,
      { debit: REF.electric, credit: REF.teamOwed },
      { TxnDate: '2026-09-27' },
      { Type: 'Employee', EntityRef: { value: '55', name: 'Robin Example' } },
    ),
  );
  const owed = await approve(employeeRun);
  assert.deepEqual(owed.result, { outcome: 'failed', failureReason: DUPLICATE });
  // Not a match — another vendor's bill with the number, a charge on another account — goes on.
  const other = await heldBill();
  other.simulator.company.bills.push(sampleBill('161', REF.other, { DocNumber: 'HOS-1042' }));
  assert.equal((await approve(other)).result.outcome, 'success');
  const otherCard = await firstRun({ answer: receipt(), config: HOLD_ALL });
  otherCard.simulator.company.purchases.push(
    samplePurchase('211', REF.checking, { TxnDate: '2026-09-28', TotalAmt: 60.63 }),
  );
  assert.equal((await approve(otherCard)).result.outcome, 'success');
});

test('confirm-no-duplicate: the possible duplicate the approver saw and approved is allowed; a full answer with nothing new goes on, saying more may exist', async () => {
  const seen = await firstRun({
    answer: bill(),
    company: (sim) =>
      sim.company.bills.push(sampleBill('150', REF.harrowgate, { DocNumber: 'HOS-1042' })),
  });
  assert.deepEqual(heldState(seen).holdReasons, ['possible_duplicate']);
  const approved = await approve(seen);
  assert.equal(approved.result.outcome, 'success');
  assert.equal(
    approved.steps.find(([stepId]) => stepId === 'confirm-no-duplicate')?.[2],
    'No matching record added since this was held; 1 already shown to the approver',
  );
  // Four bills with the number: the first run's number lookup read three (its bound), its amount
  // lookup the fourth, so the re-check's four rows were all shown to the approver.
  const full = await firstRun({
    answer: bill(),
    company: (sim) => {
      for (const id of ['150', '151', '152']) {
        sim.company.bills.push(sampleBill(id, REF.harrowgate, { DocNumber: 'HOS-1042' }));
      }
      sim.company.bills.push(
        sampleBill('153', REF.harrowgate, {
          DocNumber: 'HOS-1042',
          TxnDate: '2026-09-14',
          TotalAmt: 413.34,
        }),
      );
    },
  });
  const many = await approve(full);
  assert.match(
    many.steps.find(([stepId]) => stepId === 'confirm-no-duplicate')?.[2] ?? '',
    /the search was full, so more may exist$/u,
  );
});

test('after create-vendor added the vendor, a later failure says so: a match added meanwhile, a refusal, a thrown read', async () => {
  const first = await firstRun({ answer: bill(), bare: true });
  first.simulator.company.bills.push(sampleBill('162', REF.other, { DocNumber: 'HOS-1042' }));
  const approved = await approve(first);
  assert.deepEqual(approved.result, { outcome: 'failed', failureReason: DUPLICATE_AFTER_VENDOR });
  assert.equal(first.simulator.company.vendors.length, 1, 'the vendor stays: a real supplier');
  const refused = await firstRun({ answer: bill(), bare: true });
  refused.simulator.script('query.run', [{ status: 200 }, { status: 403 }]);
  assert.deepEqual((await approve(refused)).result, {
    outcome: 'failed',
    failureReason:
      'QuickBooks refused access to this company. Reconnect QuickBooks in Connections as a company admin, then run it again. No bill was created. The new vendor was added to QuickBooks.',
  });
  const thrown = await firstRun({ answer: bill(), bare: true });
  thrown.simulator.script('query.run', [{ status: 200 }, { refuse: PROVIDER_REFUSALS.noAnswer() }]);
  // Too close to the deadline for the SDK's 10-second retry: the first throw is the last.
  const deadline = new Date(Date.now() + 5_000).toISOString();
  assert.deepEqual((await approve(thrown, { deadline })).result, {
    outcome: 'failed',
    failureReason:
      'Autom8x could not reach QuickBooks. Run it again in a few minutes. No bill was created. The new vendor was added to QuickBooks.',
  });
});

test('a held state that does not read back whole is stopped before any QuickBooks call: "could not finish its checks"', async () => {
  const first = await heldBill();
  const state = heldState(first);
  const broken: JsonObject[] = [
    { ...state, v: 2 },
    { ...state, plan: { ...(state.plan as JsonObject), amountCents: 0 } },
    { ...state, recheck: undefined },
    { ...state, company: { ...(state.company as JsonObject), createdAt: 7 } },
    { ...state, route: 'statement' },
    { ...state, plan: { ...(state.plan as JsonObject), operation: 'purchase.create' } },
  ];
  for (const held of broken) {
    const approved = await approve(first, { state: held });
    assert.deepEqual(approved.result, {
      outcome: 'failed',
      failureReason: AFTER_APPROVAL_SENTENCES.state_incomplete,
    });
    assert.deepEqual(approved.providerCalls, []);
  }
});
