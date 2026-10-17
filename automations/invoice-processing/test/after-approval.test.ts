import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROVIDER_REFUSALS,
  faultAnswer,
  type ScriptedAnswer,
} from '@autom8x/automation-kit/testing';
import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { RESULTS } from '../src/words.js';
import { bill, receipt } from './check-world.js';
import {
  PAID,
  REF,
  sampleBill,
  sampleCustomer,
  samplePurchase,
  sampleVendor,
  type RouteRun,
} from './lookups-world.js';
import { approve, firstRun, heldState, outputOf, writesOf } from './writes-world.js';

/**
 * The checks a wait calls for, after an approval and before anything is written (the plan's §2.0,
 * §5; ip-review design-after-approval-writes-notify-tests.json steps[0]–[3]): the same company, the
 * new vendor added meanwhile, the vendor added now, no matching record added meanwhile — each
 * skipped in a first run; each, when it must, keeping the record out of QuickBooks before any write
 * — the details saved, "Saved. Not recorded in QuickBooks: …" (decision 6) — and a held state that
 * does not read back whole stopped before any QuickBooks call.
 */

const HOLD_ALL = { ...PAID.company.config, holdAboveAmount: 0 };
const heldBill = (run: Partial<RouteRun> = {}) =>
  firstRun({ answer: bill(), config: HOLD_ALL, ...run });

/** The run's summary: the result line a person reads. */
const summaryOf = (result: RunResult) =>
  result.outcome === 'success' ? result.summary : JSON.stringify(result);
const notRecorded = (reason: string) => RESULTS.notRecorded(reason);
const DUPLICATE = notRecorded('may already be in QuickBooks');

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
  assert.equal(same.steps[0]?.[2], 'QuickBooks: Sample Bakery');
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
    assert.equal(summaryOf(approved.result), notRecorded("QuickBooks isn't connected"), label);
    assert.deepEqual(approved.steps[0], [
      'confirm-company',
      'failed',
      "Not recorded in QuickBooks: QuickBooks isn't connected",
    ]);
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

test('confirm-company: QuickBooks disconnected while it waited: not recorded, the details saved, no write', async () => {
  const first = await heldBill();
  first.simulator.connected = false;
  const approved = await approve(first);
  assert.equal(summaryOf(approved.result), notRecorded("QuickBooks isn't connected"));
  assert.deepEqual(approved.providerCalls.length, 1);
  assert.deepEqual(outputOf(approved.result).outcome, 'saved');
});

test('confirm-vendor: the new vendor added while it waited, in any case, is linked and never created', async () => {
  const first = await firstRun({ answer: bill(), bare: true });
  first.simulator.company.vendors.push(sampleVendor('77', 'HARROWGATE OFFICE SUPPLY'));
  const approved = await approve(first);
  assert.equal(
    approved.steps.find(([stepId]) => stepId === 'confirm-vendors')?.[2],
    'Vendor found',
  );
  assert.equal(
    approved.steps.find(([stepId]) => stepId === 'create-approved-vendors'),
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
  // The query: the name it would be created with, and the name QuickBooks gives an inactive vendor.
  const query = approved.providerCalls.find(
    (call) => call.operation === 'query.run' && String(call.input.query).includes('FROM Vendor'),
  );
  assert.equal(
    query?.input.query,
    "SELECT * FROM Vendor WHERE DisplayName IN ('Harrowgate Office Supply', 'Harrowgate Office Supply (deleted)') AND Active IN (true, false) MAXRESULTS 4",
  );
});

test("confirm-vendor: '(vendor)' is the name looked up; inactive, two, or in another currency is not recorded, before anything is written", async () => {
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
  assert.equal(
    approved.steps.find(([id]) => id === 'create-approved-vendors')?.[2],
    'Vendor added',
  );
  const cases: [string, JsonObject[], string][] = [
    [
      'inactive',
      [sampleVendor('77', 'Harrowgate Office Supply', { Active: false })],
      "the vendor isn't in QuickBooks",
    ],
    [
      'two',
      [
        sampleVendor('77', 'Harrowgate Office Supply'),
        sampleVendor('78', 'harrowgate office supply'),
      ],
      "the vendor isn't in QuickBooks",
    ],
    [
      'in CAD',
      [sampleVendor('77', 'Harrowgate Office Supply', { CurrencyRef: { value: 'CAD' } })],
      'the vendor uses another currency',
    ],
  ];
  for (const [label, vendors, reason] of cases) {
    const first = await firstRun({ answer: bill(), bare: true });
    first.simulator.company.vendors.push(...vendors);
    const stopped = await approve(first);
    assert.equal(summaryOf(stopped.result), notRecorded(reason), label);
    assert.deepEqual(writesOf(stopped.providerCalls), [], label);
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

test('create-vendor: QuickBooks refusing is not recorded, not confirming is "didn\'t confirm" — the details saved, the bill never sent (a lost answer: test/write-retry.test.ts)', async () => {
  const unconfirmed = RESULTS.unconfirmed;
  const cases: [string, ScriptedAnswer[], string][] = [
    [
      '6240',
      [{ status: 400, body: faultAnswer('6240') }],
      notRecorded('name used by a customer or employee'),
    ],
    [
      '2050',
      [{ status: 400, body: faultAnswer('2050') }],
      notRecorded("the vendor's name is too long"),
    ],
    ['6190', [{ status: 400, body: faultAnswer('6190') }], notRecorded("QuickBooks didn't answer")],
    [
      'another code',
      [{ status: 400, body: faultAnswer('6000') }],
      notRecorded("QuickBooks didn't answer"),
    ],
    ['a 429', [{ status: 429 }], unconfirmed],
    ['Fault 600', [{ status: 400, body: faultAnswer('600') }], unconfirmed],
  ];
  for (const [label, script, sentence] of cases) {
    const first = await firstRun({ answer: bill(), bare: true });
    first.simulator.script('vendor.create', script);
    const approved = await approve(first);
    assert.equal(summaryOf(approved.result), sentence, label);
    assert.deepEqual(
      writesOf(approved.providerCalls).map(([operation]) => operation),
      ['vendor.create'],
      `${label}: one request, never repeated, no bill`,
    );
  }
});

test('confirm-no-duplicate: a record the rule matches, added while it waited — by hand or from the bank feed — keeps it out; what the approver saw is allowed', async () => {
  // A bill: the same vendor's bill with its number.
  const billRun = await heldBill();
  billRun.simulator.company.bills.push(
    sampleBill('160', REF.harrowgate, { DocNumber: 'hos-1042', TotalAmt: 413.34 }),
  );
  const billed = await approve(billRun);
  assert.equal(summaryOf(billed.result), DUPLICATE);
  assert.deepEqual(writesOf(billed.providerCalls), []);
  assert.deepEqual(
    billed.steps.find(([stepId]) => stepId === 'confirm-no-duplicates'),
    ['confirm-no-duplicates', 'failed', 'Not recorded in QuickBooks: may already be in QuickBooks'],
  );
  // The query: find-duplicate-number's, one row more, the newest created first.
  assert.equal(
    billed.providerCalls.at(-1)?.input.query,
    "SELECT * FROM Bill WHERE DocNumber = 'HOS-1042' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  );
  // A company receipt: the bank feed brought the charge.
  const receiptRun = await firstRun({ answer: receipt(), config: HOLD_ALL });
  receiptRun.simulator.company.purchases.push(
    samplePurchase('210', REF.visa4417, { TxnDate: '2026-09-28', TotalAmt: 60.63 }),
  );
  const fed = await approve(receiptRun);
  assert.equal(summaryOf(fed.result), DUPLICATE);
  assert.equal(
    fed.providerCalls.at(-1)?.input.query,
    "SELECT * FROM Purchase WHERE TotalAmt = '60.63' AND TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' ORDERBY MetaData.CreateTime DESC MAXRESULTS 4",
  );
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

test('confirm-no-duplicate: the possible duplicate the approver saw and approved is allowed; a full answer with nothing new goes on', async () => {
  // The vendor's bill with the number, the total and the date: the number is then kept in the
  // memo, so the re-check repeats the total-and-date lookup, which finds the bill the approver saw.
  const seen = await firstRun({
    answer: bill(),
    company: (sim) =>
      sim.company.bills.push(
        sampleBill('150', REF.harrowgate, {
          DocNumber: 'HOS-1042',
          TxnDate: '2026-09-14',
          TotalAmt: 413.34,
        }),
      ),
  });
  assert.deepEqual(heldState(seen).holdReasons, ['possible_duplicate']);
  const approved = await approve(seen);
  assert.equal(approved.result.outcome, 'success');
  assert.equal(
    approved.steps.find(([stepId]) => stepId === 'confirm-no-duplicates')?.[2],
    'No duplicate',
  );
  // Four of the vendor's bills for the total and date, one with the number: the first run's amount
  // lookup read three (its bound), its number lookup the fourth, so the re-check's four rows were
  // all shown to the approver.
  const full = await firstRun({
    answer: bill(),
    company: (sim) => {
      for (const id of ['150', '151', '152']) {
        sim.company.bills.push(
          sampleBill(id, REF.harrowgate, { TxnDate: '2026-09-14', TotalAmt: 413.34 }),
        );
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
  assert.equal(many.result.outcome, 'success');
  assert.equal(
    many.steps.find(([stepId]) => stepId === 'confirm-no-duplicates')?.[2],
    'No duplicate',
  );
});

test('after create-vendor added the vendor, a later stop keeps the bill out and the vendor in: a match added meanwhile, a refusal, a thrown read', async () => {
  const first = await firstRun({ answer: bill(), bare: true });
  first.simulator.company.bills.push(sampleBill('162', REF.other, { DocNumber: 'HOS-1042' }));
  const approved = await approve(first);
  assert.equal(summaryOf(approved.result), DUPLICATE);
  assert.equal(first.simulator.company.vendors.length, 1, 'the vendor stays: a real supplier');
  const refused = await firstRun({ answer: bill(), bare: true });
  refused.simulator.script('query.run', [{ status: 200 }, { status: 403 }]);
  assert.equal(
    summaryOf((await approve(refused)).result),
    notRecorded("QuickBooks isn't connected"),
  );
  const thrown = await firstRun({ answer: bill(), bare: true });
  thrown.simulator.script('query.run', [{ status: 200 }, { refuse: PROVIDER_REFUSALS.noAnswer() }]);
  // Too close to the deadline for the SDK's 10-second retry: the first throw is the last.
  const deadline = new Date(Date.now() + 5_000).toISOString();
  assert.equal(
    summaryOf((await approve(thrown, { deadline })).result),
    notRecorded("QuickBooks didn't answer"),
  );
});

test('a held state that does not read back whole is stopped before any QuickBooks call: "Something went wrong"', async () => {
  const first = await heldBill();
  const state = heldState(first);
  const broken: JsonObject[] = [
    { ...state, v: 1 },
    { ...state, read: undefined },
    { ...state, plan: { ...(state.plan as JsonObject), amountCents: 0 } },
    { ...state, recheck: undefined },
    { ...state, recheck: { ...(state.recheck as JsonObject), fullAt: 7 } },
    { ...state, company: { ...(state.company as JsonObject), createdAt: 7 } },
    { ...state, route: 'statement' },
    { ...state, plan: { ...(state.plan as JsonObject), operation: 'purchase.create' } },
  ];
  for (const held of broken) {
    const approved = await approve(first, { state: held });
    assert.deepEqual(approved.result, {
      outcome: 'failed',
      failureReason: 'Something went wrong. Try again.',
    });
    assert.deepEqual(approved.providerCalls, []);
  }
});
