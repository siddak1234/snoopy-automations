import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_REFUSALS } from '@autom8x/automation-kit/testing';
import { idempotencyKeyFor, type JsonObject, type RunResult } from '@autom8x/automation-sdk';

import { UNCONFIRMED_LINE } from '../src/quickbooks-path.js';

import {
  HARROWGATE,
  LOWES,
  THREE_RECEIPTS,
  TIDEWELL,
  documentsOf,
  documentsRun,
  keysOf,
  statuses,
} from './documents-world.js';
import { FILE_ID, NONE, lines } from './fixtures.js';
import { assertOutputValid } from './output-schema.js';

/**
 * One photo, three receipts from three sellers — the owner's run 793eef82 of 2026-10-15, which v2
 * failed with "Add one document per file." (B-T1, B-T2, B-T5; the owner: "it was 3 receipts in one
 * picture. that should work … we should get a json out that clearly seperates accordingly"): each
 * read in ONE model call, each its own document with its own seller and its own data, each saved
 * or recorded on its own, under its own key.
 */

test('with "None", one photo of three receipts is read in one call and saved as three documents, each with its own seller, and QuickBooks is never called', async () => {
  const world = await documentsRun({ config: NONE });
  assert.equal(world.result.outcome, 'success');
  assert.equal(world.platform.modelCalls.length, 1, 'one AI read: nothing was doubtful');
  assert.equal(world.platform.providerCalls.length, 0, 'None calls QuickBooks for nothing');
  const documents = documentsOf(world.result);
  assert.deepEqual(
    documents.map((each) => [each.index, each.vendor.name, each.status, each.statusText]),
    [
      [1, 'Tidewell Hardware', 'saved', 'Saved'],
      [2, 'Harrowgate Office Supply', 'saved', 'Saved'],
      [3, "Lowe's", 'saved', 'Saved'],
    ],
  );
  const success = world.result as Extract<RunResult, { outcome: 'success' }>;
  assert.equal(success.summary, '3 receipts: 3 saved.');
  assertOutputValid(success.output);
});

test("each document carries everything read of it: its seller's place, its numbers, its time and each line's quantity and unit price, as decimal strings", async () => {
  const world = await documentsRun({ config: NONE });
  const lowes = documentsOf(world.result)[2]!;
  assert.deepEqual(lowes, {
    index: 3,
    status: 'saved',
    statusText: 'Saved',
    type: 'receipt',
    vendor: {
      name: "Lowe's",
      address: '2150 W Shaw Ave',
      city: 'Fresno, CA 93711',
      storeNumber: '1234',
    },
    number: '48291',
    numberLabel: 'Trans #',
    references: [{ label: 'Register', value: '07' }],
    date: '2026-10-14',
    time: '14:32',
    currency: null,
    lineItems: [{ description: '2X4-8 STUD', quantity: '4', unitPrice: '3.98', amount: '15.92' }],
    lineItemsComplete: true,
    subtotal: '15.92',
    tax: '1.27',
    tip: null,
    discount: null,
    total: '17.19',
    payment: { method: 'card', cardLast4: '4417' },
    recordedIn: null,
    details: [{ label: 'Category', value: 'Materials' }],
    // v6: the run's one upload, which the run page's Format and the run package read.
    source: { file: FILE_ID },
  });
});

test('with QuickBooks, each receipt is recorded as its own expense, each write under its own key, the new seller added once as a vendor', async () => {
  const world = await documentsRun({});
  assert.equal(world.result.outcome, 'success', JSON.stringify(world.result).slice(0, 400));
  assert.equal(world.platform.modelCalls.length, 1);
  const step = idempotencyKeyFor(world.request.runId, 'create-records');
  assert.deepEqual(keysOf(world, 'purchase.create'), [`${step}.d1`, `${step}.d2`, `${step}.d3`]);
  const vendors = idempotencyKeyFor(world.request.runId, 'create-vendors');
  assert.deepEqual(keysOf(world, 'vendor.create'), [`${vendors}.d3`], "Lowe's added, once");
  const documents = documentsOf(world.result);
  assert.deepEqual(statuses(world.result), ['recorded', 'recorded', 'recorded']);
  const purchases = world.simulator.company.purchases;
  assert.equal(purchases.length, 3);
  // v6: each says the QuickBooks company it went to, and every one the file it came from.
  assert.deepEqual(
    documents.map((each) => each.recordedIn),
    purchases.map((row) => ({
      providerId: 'quickbooks',
      recordType: 'expense',
      recordId: row.Id,
      accountName: 'Sample Bakery',
    })),
  );
  assert.deepEqual(
    documents.map((each) => each.source),
    [{ file: FILE_ID }, { file: FILE_ID }, { file: FILE_ID }],
  );
  // Each expense names its own seller: the two known vendors, and Lowe's as it was added.
  const added = world.simulator.company.vendors.find((row) => row.DisplayName === "Lowe's");
  assert.ok(added, "Lowe's is a vendor now");
  assert.deepEqual(
    purchases.map((row) => (row.EntityRef as JsonObject | undefined)?.value),
    ['9', '7', added.Id],
  );
  assert.deepEqual(
    documents.map((each) => each.statusText),
    Array(3).fill('Recorded in QuickBooks: expense'),
  );
  const success = world.result as Extract<RunResult, { outcome: 'success' }>;
  assert.equal(success.summary, '3 receipts: 3 recorded in QuickBooks.');
  assert.deepEqual(documents[0]?.details, [
    { label: 'Category', value: 'Repairs & Maintenance' },
    { label: 'Paid from', value: 'Visa 4417' },
    { label: 'Decided', value: 'Automatically' },
    { label: 'Next', value: 'When this charge arrives in your bank feed, choose Match, not Add.' },
  ]);
  assertOutputValid(success.output);
});

test('two receipts from one new seller: one vendor added, two expenses, both naming it', async () => {
  const second = { ...LOWES, documentNumber: '48302', total: 34.38, subtotal: 31.84, tax: 2.54 };
  const lines = [{ description: '2X4-8 STUD', quantity: 8, unitPrice: 3.98, amount: 31.84 }];
  const world = await documentsRun({ documents: [LOWES, { ...second, lineItems: lines }] });
  assert.equal(world.result.outcome, 'success', JSON.stringify(world.result).slice(0, 400));
  assert.equal(keysOf(world, 'vendor.create').length, 1, 'one vendor per name in the file');
  const added = world.simulator.company.vendors.filter((row) => row.DisplayName === "Lowe's");
  assert.equal(added.length, 1);
  assert.deepEqual(
    world.simulator.company.purchases.map((row) => (row.EntityRef as JsonObject).value),
    [added[0]!.Id, added[0]!.Id],
  );
});

test("a receipt's new seller whose vendor add gets no answer three times: the expense is still recorded, naming no vendor, and says so truly (Gate 25's R5d)", async () => {
  const feed = { ...LOWES, vendorName: 'Fresno Feed & Seed', documentNumber: '7710' };
  const lost = { lost: 'before_record' } as const;
  const none = { refuse: PROVIDER_REFUSALS.noAnswer() };
  const started = Date.now();
  // Lowe's alone, QuickBooks making the vendor each time and the answer lost; and Lowe's beside
  // a second new seller, nothing reaching QuickBooks — so that one's add is never tried.
  const [made, neither] = await Promise.all([
    documentsRun({
      documents: [LOWES],
      company: (sim) => sim.script('vendor.create', [lost, lost, lost]),
    }),
    documentsRun({
      documents: [LOWES, feed],
      company: (sim) => sim.script('vendor.create', [none, none, none]),
    }),
  ]);
  assert.ok(Date.now() - started >= 30_000, 'three attempts: 10 s, then 20 s');
  for (const [world, count] of [
    [made, 1],
    [neither, 2],
  ] as const) {
    assert.equal(world.result.outcome, 'success', JSON.stringify(world.result).slice(0, 400));
    const vendors = idempotencyKeyFor(world.request.runId, 'create-vendors');
    assert.deepEqual(keysOf(world, 'vendor.create'), Array(3).fill(`${vendors}.d1`));
    assert.deepEqual(
      lines(world.platform).find(([stepId]) => stepId === 'create-vendors'),
      ['create-vendors', 'failed', `${UNCONFIRMED_LINE} (after 3 attempts)`],
    );
    const purchases = world.simulator.company.purchases.slice(-count);
    assert.equal(keysOf(world, 'purchase.create').length, count, 'each expense sent');
    assert.deepEqual(statuses(world.result), Array(count).fill('recorded'));
    const documents = documentsOf(world.result);
    assert.deepEqual(
      documents.map((each) => [each.statusText, each.recordedIn?.recordId]),
      purchases.map((row) => ['Recorded in QuickBooks: expense', row.Id]),
    );
    // Naming no vendor, the seller in its memo.
    assert.deepEqual(
      purchases.map((row) => row.EntityRef),
      Array(count).fill(undefined),
    );
    assert.match(String(purchases[0]?.PrivateNote), /Receipt 48291 from Lowe's\.$/u);
  }
  assert.equal(
    made.simulator.company.vendors.filter((row) => row.DisplayName === "Lowe's").length,
    1,
  );
  assert.equal(
    neither.simulator.company.vendors.filter((row) => row.DisplayName === "Lowe's").length,
    0,
  );
  assert.match(
    String(neither.simulator.company.purchases.at(-1)?.PrivateNote),
    /from Fresno Feed & Seed\.$/u,
  );
});

test('two receipts from two known sellers: two vendors found, two expenses, nothing added', async () => {
  const world = await documentsRun({ documents: [TIDEWELL, HARROWGATE] });
  assert.deepEqual(statuses(world.result), ['recorded', 'recorded']);
  assert.equal(keysOf(world, 'vendor.create').length, 0);
  assert.deepEqual(
    world.simulator.company.purchases.map((row) => (row.EntityRef as JsonObject).value),
    ['9', '7'],
  );
});

test('every document keeps its own number: a bill is recorded with it as its DocNumber, its label and references beside it', async () => {
  const bill = THREE_RECEIPTS[0]!;
  const invoice = {
    ...bill,
    documentType: 'invoice',
    vendorName: 'Harrowgate Office Supply',
    documentNumber: 'HOS-1042',
    numberLabel: 'Invoice #',
    references: [
      { label: 'PO #', value: '7781' },
      { label: 'Account', value: 'C-0042' },
    ],
    paymentMethod: 'not_shown',
    cardLast4: '',
    dueDate: '2026-10-27',
    spendType: 'office_supplies',
  };
  const world = await documentsRun({ documents: [invoice] });
  const [document] = documentsOf(world.result);
  assert.equal(document?.status, 'recorded', JSON.stringify(document));
  assert.deepEqual(
    [document?.type, document?.number, document?.numberLabel, document?.references],
    [
      'invoice',
      'HOS-1042',
      'Invoice #',
      [
        { label: 'PO #', value: '7781' },
        { label: 'Account', value: 'C-0042' },
      ],
    ],
  );
  const [bills] = [world.simulator.company.bills];
  assert.equal(bills[0]?.DocNumber, 'HOS-1042', "the record carries the document's own number");
  assert.equal(document?.recordedIn?.recordType, 'bill');
});
