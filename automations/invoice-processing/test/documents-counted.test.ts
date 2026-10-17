import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModelRequest, RunResult } from '@autom8x/automation-sdk';

import { partAnswerOf, v2AnswerOf } from '../src/run/answer.js';
import { documentReadOf } from '../src/run/document-read.js';
import { withPart } from '../src/run/extract.js';
import { statement } from './check-world.js';
import {
  HARROWGATE,
  LOWES,
  TIDEWELL,
  approve,
  documentsOf,
  documentsRun,
  statuses,
} from './documents-world.js';
import { NONE, documentAnswer, isSecondRead, partAnswer } from './fixtures.js';

/**
 * Nothing in a file is left out silently (the owner's AM6, 2026-10-15: "any invoice, any receipt,
 * any refund, or any bill"): each part counts the documents the whole file holds. A part that says
 * the file is done while counting more than were read is followed by one from the next document;
 * a reading that still ends short of the count has its last document wait for a person, "the file
 * may hold more documents" (the session's choice S44), while the rest go on. And a reading that
 * stops inside a document marks what it did not read — a statement's rows too.
 */

/** The first-read calls a run made, by where each part started. */
const startsOf = (calls: readonly ModelRequest[]) =>
  calls
    .filter((call) => !isSecondRead(call))
    .map((call) => [call.input.fromDocument, call.input.fromLine]);

/** A model that lists receipts 1 and 2, says it is done, yet counts three; then, from the third, `rest`. */
const countsThree = (rest: readonly object[]) => (call: ModelRequest) =>
  call.input.fromDocument === 1
    ? partAnswer([TIDEWELL, HARROWGATE], null, 3)
    : partAnswer([...(rest as never[])], null, 3);

test('a part that says the file is done while it counts more is followed by one from the next document, and every document is read', async () => {
  const world = await documentsRun({ config: NONE, parts: countsThree([LOWES]) });
  assert.equal(world.result.outcome, 'success', JSON.stringify(world.result).slice(0, 400));
  assert.deepEqual(startsOf(world.platform.modelCalls), [
    [1, 1],
    [3, 1],
  ]);
  assert.deepEqual(
    documentsOf(world.result).map((each) => [each.index, each.vendor.name, each.status]),
    [
      [1, 'Tidewell Hardware', 'saved'],
      [2, 'Harrowgate Office Supply', 'saved'],
      [3, "Lowe's", 'saved'],
    ],
  );
});

test('a reading still short of the count: the last document read waits, "the file may hold more documents", while the others are recorded', async () => {
  const first = await documentsRun({ parts: countsThree([]) });
  assert.deepEqual(
    startsOf(first.platform.modelCalls),
    [
      [1, 1],
      [3, 1],
    ],
    'one more part, which read nothing: the reading ends',
  );
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  const held = first.result as Extract<RunResult, { outcome: 'held' }>;
  assert.equal(held.held.reason, 'Document 2: the file may hold more documents.');
  assert.deepEqual(statuses(first.result), ['recorded', 'waiting']);
  assert.equal(
    documentsOf(first.result)[1]?.statusText,
    'Waiting for approval: the file may hold more documents',
  );
  assert.equal(first.simulator.company.purchases.length, 1, 'the other recorded before the hold');

  const approved = await approve(first);
  assert.equal(approved.result.outcome, 'success', JSON.stringify(approved.result).slice(0, 400));
  assert.deepEqual(statuses(approved.result), ['recorded', 'recorded']);
  assert.equal(first.simulator.company.purchases.length, 2);
});

test('the last document waits for the count even when QuickBooks will not take it; approved, it is saved, not recorded', async () => {
  const cashBack = { ...HARROWGATE, cashBackPrinted: true };
  const first = await documentsRun({
    parts: (call) =>
      call.input.fromDocument === 1
        ? partAnswer([TIDEWELL, cashBack], null, 3)
        : partAnswer([], null, 3),
  });
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 400));
  assert.equal(
    (first.result as Extract<RunResult, { outcome: 'held' }>).held.reason,
    'Document 2: the file may hold more documents.',
  );
  assert.deepEqual(statuses(first.result), ['recorded', 'waiting']);

  const approved = await approve(first);
  assert.deepEqual(statuses(approved.result), ['recorded', 'not_recorded']);
  assert.equal(
    documentsOf(approved.result)[1]?.statusText,
    'Saved. Not recorded in QuickBooks: it includes cash back',
  );
  assert.equal(first.simulator.company.purchases.length, 1, 'nothing more written');
});

test('a file read whole, its count met, has nothing waiting for the count', async () => {
  const world = await documentsRun({ config: NONE, documents: [TIDEWELL, LOWES] });
  assert.deepEqual(statuses(world.result), ['saved', 'saved']);
  assert.equal(startsOf(world.platform.modelCalls).length, 1);
});

test('a reading that stops inside a statement marks its rows incomplete, so it is never compared as if whole', () => {
  const rows = documentAnswer(statement({ lineItems: [] }));
  assert.ok((rows.listedItems as unknown[]).length > 0, 'the sample lists rows');
  // The part lists the statement's first rows, then points back at the statement: nowhere new.
  const part = partAnswerOf(partAnswer([rows], { document: 1, line: 81 }))!;
  const read = withPart([], part, { document: 1, line: 1 });
  assert.equal(read.next, null);
  const [answer] = read.documents;
  assert.ok(answer);
  assert.equal(answer.listedItemsComplete, false);
  assert.equal(documentReadOf(answer).lineItemsComplete, false, 'the result says so');
  assert.equal(v2AnswerOf(answer).listedItemsComplete, false, 'the checks see it too');
});

test('a part that reads nothing at the start of a document leaves the documents before it whole', () => {
  const [one] = partAnswerOf(partAnswer([LOWES]))!.documents;
  assert.ok(one);
  const part = partAnswerOf(partAnswer([], { document: 2, line: 1 }, 2))!;
  const read = withPart([one], part, { document: 2, line: 1 });
  assert.equal(read.next, null, 'no way on');
  assert.equal(read.documents[0]?.lineItemsComplete, true, 'document 1 was read to its end');
});

test('a page clearly no financial document, read last in a file counted to hold more, waits for both reasons', async () => {
  const page = documentAnswer(
    { ...HARROWGATE, vendorName: null, total: null, documentNumber: null },
    { documentType: 'not_financial', lineItems: [], lineItemCount: 0 },
  );
  const world = await documentsRun({
    config: NONE,
    parts: (call) =>
      call.input.fromDocument === 1
        ? partAnswer([TIDEWELL, page], null, 3)
        : partAnswer([], null, 3),
  });
  assert.equal(
    (world.result as Extract<RunResult, { outcome: 'held' }>).held.reason,
    "Document 2: this doesn't look like a bill, receipt or invoice, the file may hold more documents.",
  );
  assert.deepEqual(statuses(world.result), ['saved', 'waiting']);
});
