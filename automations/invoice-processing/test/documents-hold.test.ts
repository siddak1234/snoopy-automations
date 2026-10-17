import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import {
  HARROWGATE,
  LOWES,
  TIDEWELL,
  approve,
  documentsOf,
  documentsRun,
  statuses,
} from './documents-world.js';
import {
  NONE,
  documentAnswer,
  isSecondRead,
  manifests,
  positionsOf,
  secondAnswer,
} from './fixtures.js';
import { assertOutputValid } from './output-schema.js';

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
