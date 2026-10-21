import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Buffer } from 'node:buffer';

import {
  RESULT_BODY_LIMIT_BYTES,
  boundedResult,
  type JsonObject,
  type ModelRequest,
  type RunResult,
} from '@autom8x/automation-sdk';

import { bill } from './check-world.js';
import {
  HARROWGATE,
  LOWES,
  TIDEWELL,
  approve,
  documentsOf,
  documentsRun,
  statuses,
  type Run,
} from './documents-world.js';
import {
  NONE,
  QUICKBOOKS,
  documentAnswer,
  isSecondRead,
  manifests,
  partAnswer,
  positionsOf,
  secondAnswer,
} from './fixtures.js';
import { assertOutputValid, assertResultValid } from './output-schema.js';

/**
 * One document never fails the others (the session's spec, B4; the owner's AM6 and AM8): a
 * doubtful document is read again — ONE second read for the file — and, still unclear, waits for
 * approval while the others are recorded or saved; a financial document QuickBooks has no record
 * for is saved with all its data; only a page that is clearly no financial document waits for
 * review.
 */

/** Receipt 2 with its total unreadable. */
const NO_TOTAL = { ...HARROWGATE, total: null, uncertainFields: ['total'] };

test('a doubtful document waits while the others are recorded: one second read, one approval naming it, and after approval it is saved as not recorded', async () => {
  const first = await documentsRun({
    documents: [TIDEWELL, NO_TOTAL, LOWES],
    second: (position) => secondAnswer({ ...[TIDEWELL, NO_TOTAL, LOWES][position - 1]! }),
  });
  const seconds = first.platform.modelCalls.filter(isSecondRead);
  assert.equal(seconds.length, 1, 'one second read for the file');
  assert.deepEqual(positionsOf(seconds[0]!), [2], 'naming the doubtful document alone');
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  const held = first.result as Extract<RunResult, { outcome: 'held' }>;
  assert.equal(held.held.reason, "Document 2: the total can't be read.");
  assert.equal(held.held.stepId, 'ask-approval');
  assert.deepEqual(statuses(first.result), ['recorded', 'waiting', 'recorded']);
  assert.equal(
    documentsOf(first.result)[1]?.statusText,
    "Waiting for approval: the total can't be read",
  );
  assert.equal(first.simulator.company.purchases.length, 2, 'the others recorded before the hold');

  const approved = await approve(first);
  assert.equal(approved.result.outcome, 'success', JSON.stringify(approved.result).slice(0, 400));
  assert.deepEqual(statuses(approved.result), ['recorded', 'not_recorded', 'recorded']);
  assert.equal(
    documentsOf(approved.result)[1]?.statusText,
    "Saved. Not recorded in QuickBooks: the total can't be read",
  );
  const success = approved.result as Extract<RunResult, { outcome: 'success' }>;
  assert.equal(success.summary, '3 receipts: 2 recorded in QuickBooks, 1 not recorded.');
  assert.equal(first.simulator.company.purchases.length, 2, 'nothing more written');
  assertOutputValid(success.output);
});

test('with "None", the doubtful document waits too, and after approval it is saved', async () => {
  const first = await documentsRun({ config: NONE, documents: [TIDEWELL, NO_TOTAL, LOWES] });
  assert.deepEqual(statuses(first.result), ['saved', 'waiting', 'saved']);
  const approved = await approve(first);
  assert.deepEqual(statuses(approved.result), ['saved', 'saved', 'saved']);
  assert.equal(first.platform.providerCalls.length, 0);
});

test('a second read that reads what the first could not settles the document, and it is recorded with the others', async () => {
  const world = await documentsRun({
    documents: [TIDEWELL, NO_TOTAL, LOWES],
    second: () => secondAnswer({ ...HARROWGATE }),
  });
  assert.equal(world.result.outcome, 'success', JSON.stringify(world.result).slice(0, 400));
  assert.deepEqual(statuses(world.result), ['recorded', 'recorded', 'recorded']);
});

test('a second read that counts the documents otherwise holds every doubtful one', async () => {
  const unclear = { ...HARROWGATE, uncertainFields: ['tax'] };
  const world = await documentsRun({
    config: NONE,
    documents: [TIDEWELL, unclear, LOWES],
    secondCount: 4,
  });
  assert.equal(world.result.outcome, 'held');
  assert.equal(
    (world.result as Extract<RunResult, { outcome: 'held' }>).held.reason,
    'Document 2: unclear: tax, two reads differ: number of documents.',
  );
  assert.deepEqual(statuses(world.result), ['saved', 'waiting', 'saved']);
});

test('a quote is saved with all its data while the bill beside it is recorded (AM8)', async () => {
  const quote = documentAnswer(
    { ...HARROWGATE, documentType: 'quote', vendorName: 'Tidewell Hardware' },
    { documentNumber: 'Q-118', numberLabel: 'Quote #' },
  );
  const bill = { ...TIDEWELL, documentType: 'bill', paymentMethod: 'not_shown', cardLast4: '' };
  const world = await documentsRun({ documents: [quote, bill] });
  assert.equal(world.result.outcome, 'success', JSON.stringify(world.result).slice(0, 400));
  const [saved, recorded] = documentsOf(world.result);
  assert.deepEqual(
    [saved?.type, saved?.status, saved?.statusText, saved?.number, saved?.total],
    ['quote', 'saved', 'Saved. QuickBooks has no record for a quote.', 'Q-118', '23.4'],
  );
  assert.equal(saved?.lineItems.length, 1, 'with all its data');
  assert.equal(recorded?.status, 'recorded');
});

test('a page that is clearly no financial document waits for review while the receipts are recorded; approved, it is saved (AM8)', async () => {
  const page = documentAnswer(
    { ...HARROWGATE, vendorName: null, total: null, documentNumber: null },
    { documentType: 'not_financial', lineItems: [], lineItemCount: 0 },
  );
  const first = await documentsRun({ documents: [TIDEWELL, page, LOWES] });
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  const held = first.result as Extract<RunResult, { outcome: 'held' }>;
  assert.equal(held.held.reason, "Document 2: this doesn't look like a bill, receipt or invoice.");
  assert.deepEqual(statuses(first.result), ['recorded', 'waiting', 'recorded']);
  assert.equal(documentsOf(first.result)[1]?.type, 'other');
  assert.equal(
    first.platform.modelCalls.filter(isSecondRead).length,
    0,
    'a page is not read again',
  );
  const approved = await approve(first);
  assert.deepEqual(statuses(approved.result), ['recorded', 'saved', 'recorded']);
});

test('two copies of one receipt in one file: the second waits, "same as document 1" (B-T11)', async () => {
  const world = await documentsRun({ config: NONE, documents: [TIDEWELL, { ...TIDEWELL }] });
  assert.equal(world.result.outcome, 'held');
  assert.equal(
    (world.result as Extract<RunResult, { outcome: 'held' }>).held.reason,
    'Document 2: same as document 1.',
  );
  assert.deepEqual(statuses(world.result), ['saved', 'waiting']);
});

/** The held run's reason. */
const reasonOf = (result: RunResult) =>
  (result as Extract<RunResult, { outcome: 'held' }>).held.reason;

/** The continuation's QuickBooks writes, by operation. */
const writesIn = (approved: Awaited<ReturnType<typeof approve>>) =>
  approved.providerCalls
    .map((call) => call.operation)
    .filter((operation) => operation.endsWith('.create'));

/** The step's line in the continuation. */
const lineIn = (approved: Awaited<ReturnType<typeof approve>>, stepId: string) =>
  approved.steps.find(([id]) => id === stepId)?.[2];

/** Two copies of one purchase, both waiting: after the one approval, ONE record (Gate 25's R5d). */
async function bothWaitThenOne(first: Run) {
  assert.deepEqual(statuses(first.result), ['waiting', 'waiting']);
  const approved = await approve(first);
  assert.equal(approved.result.outcome, 'success', JSON.stringify(approved.result).slice(0, 400));
  assert.deepEqual(statuses(approved.result), ['recorded', 'not_recorded']);
  assert.equal(
    documentsOf(approved.result)[1]?.statusText,
    'Saved. Not recorded in QuickBooks: same as document 1',
  );
  assert.equal(
    lineIn(approved, 'create-approved-records'),
    '1 recorded in QuickBooks, 1 not recorded',
  );
  return approved;
}

test('the same bill twice in one file from a new vendor: one approval, then one vendor and ONE bill, the copy "same as document 1" (Gate 25\'s R5d)', async () => {
  const twice = documentAnswer(bill(), { numberLabel: 'Invoice #' });
  const first = await documentsRun({ documents: [twice, { ...twice }], bare: true });
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  assert.match(
    reasonOf(first.result),
    /^Document 1: new vendor.*Document 2: new vendor.*same as document 1\.$/u,
  );
  const approved = await bothWaitThenOne(first);
  assert.deepEqual(writesIn(approved), ['vendor.create', 'bill.create']);
  assert.equal(first.simulator.company.bills.length, 1, 'one bill in QuickBooks');
  assert.equal(first.simulator.company.vendors.length, 1, 'one vendor');
});

test('two copies of one receipt over the limit: one approval, then ONE expense, the copy "same as document 1" (Gate 25\'s R5d)', async () => {
  const first = await documentsRun({
    documents: [TIDEWELL, { ...TIDEWELL }],
    config: { ...QUICKBOOKS, holdAboveAmount: 50 },
  });
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  assert.equal(
    reasonOf(first.result),
    'Document 1: over the $50 limit. Document 2: over the $50 limit, same as document 1.',
  );
  const before = first.simulator.company.purchases.length;
  const approved = await bothWaitThenOne(first);
  assert.deepEqual(writesIn(approved), ['purchase.create']);
  assert.equal(first.simulator.company.purchases.length, before + 1, 'one expense in QuickBooks');
});

test('a receipt recorded in the first run and its copy waiting: after approval the copy is kept out as already in QuickBooks, and nothing is written', async () => {
  const first = await documentsRun({ documents: [TIDEWELL, { ...TIDEWELL }] });
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  assert.deepEqual(statuses(first.result), ['recorded', 'waiting']);
  assert.equal(reasonOf(first.result), 'Document 2: same as document 1.');
  const approved = await approve(first);
  assert.deepEqual(statuses(approved.result), ['recorded', 'not_recorded']);
  assert.equal(
    documentsOf(approved.result)[1]?.statusText,
    'Saved. Not recorded in QuickBooks: may already be in QuickBooks',
  );
  assert.equal(
    lineIn(approved, 'confirm-no-duplicates'),
    'Not recorded in QuickBooks: may already be in QuickBooks',
  );
  assert.deepEqual(writesIn(approved), []);
});

/** The body the result callback sends, in bytes, as the platform counts it. */
const bodyBytes = (result: RunResult) =>
  Buffer.byteLength(JSON.stringify({ runId: '00000000-0000-4000-8000-000000000000', ...result }));

/** One receipt of 1,200 lines at $1.25, read 80 lines a part. */
const LINES = Array.from({ length: 1_200 }, (_, at) => ({
  description: `Item ${at + 1}: 2X4-8 STUD, KILN DRIED, PREMIUM GRADE, AISLE 14`,
  quantity: 1,
  unitPrice: 1.25,
  amount: 1.25,
}));
const LONG: JsonObject = {
  ...TIDEWELL,
  subtotal: 1_500,
  tax: 0,
  total: 1_500,
  lineItems: LINES,
  lineItemCount: LINES.length,
};

function longInParts(call: ModelRequest): JsonObject {
  const from = Number(call.input.fromLine);
  const lines = LINES.slice(from - 1, from - 1 + Number(call.input.maximumLines));
  const next =
    from - 1 + lines.length < LINES.length ? { document: 1, line: from + lines.length } : null;
  return partAnswer([{ ...LONG, lineItems: lines }], next, 1);
}

test("a held run of one 1,200-line receipt fits the platform's 256 KiB: its documents left out, never its state, and the run is held, not failed (Gate 25's R5d)", async () => {
  const first = await documentsRun({ documents: [LONG], parts: longInParts });
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  assert.equal(reasonOf(first.result), 'Document 1: over the $500 limit.');
  // As the automation hands it over: every line twice, in the state and in the documents.
  assert.ok(bodyBytes(first.result) > RESULT_BODY_LIMIT_BYTES, `${bodyBytes(first.result)} bytes`);
  const sent = boundedResult(first.result) as Extract<RunResult, { outcome: 'held' }>;
  assert.ok(bodyBytes(sent) <= RESULT_BODY_LIMIT_BYTES, `sent: ${bodyBytes(sent)} bytes`);
  assert.equal(sent.outcome, 'held');
  assert.deepEqual(sent.held, (first.result as Extract<RunResult, { outcome: 'held' }>).held);
  assert.equal('documents' in sent, false);
  assertResultValid(sent, 'what the held run sends');
  // Approved, the continuation's result carries the document with every line.
  const approved = await approve(first);
  const done = boundedResult(approved.result) as Extract<RunResult, { outcome: 'success' }>;
  assert.ok(bodyBytes(done) <= RESULT_BODY_LIMIT_BYTES, `success: ${bodyBytes(done)} bytes`);
  assert.equal(done.documents?.[0]?.lineItems.length, 1_200);
  assert.equal(done.documents?.[0]?.status, 'recorded');
});

test('no email setting: the results go to the people the platform picks, never an address the flow types (AM3)', async () => {
  const [manifest] = manifests;
  assert.deepEqual(
    manifest?.setup?.map((field) => [field.key, field.control]),
    [
      ['vendor', 'connection'],
      ['holdAboveAmount', 'money'],
    ],
  );
  // An old v2 setting carried over sends nothing either.
  const world = await documentsRun({
    config: { ...NONE, notifyEmail: 'books@example.com' } as JsonObject,
  });
  assert.equal(world.result.outcome, 'success');
  assert.deepEqual(world.platform.mails, []);
  assert.ok(!world.platform.steps.some((step) => step.stepId === 'notify'));
});
