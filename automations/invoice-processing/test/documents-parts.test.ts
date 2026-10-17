import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, ModelRequest } from '@autom8x/automation-sdk';

import { PART_SIZES, partInput, withPart } from '../src/run/extract.js';
import { partAnswerOf } from '../src/run/answer.js';
import { documentsOf, documentsRun, LOWES } from './documents-world.js';
import { NONE, completion, documentAnswer, isSecondRead, partAnswer } from './fixtures.js';
import { receipt } from './check-world.js';

/**
 * Many documents in one file, read in parts (the owner's AM1, 2026-10-15: "no cap on receipts …
 * it will be seperated right"): no limit on how many documents a file holds or how many lines one
 * has — a part asks for at most `PART_SIZES[0]`, so no answer passes the platform's answer cap, and
 * the next part starts where the last stopped; none is lost, none is read twice.
 */

/** Store `n`'s receipt: its own seller, number and amount, `lines` lines of $1.00 each. */
function storeReceipt(n: number, lines = 1): JsonObject {
  const each = Array.from({ length: lines }, (_, at) => ({
    description: `Item ${n}.${at + 1}`,
    quantity: 1,
    unitPrice: 1,
    amount: 1,
  }));
  return documentAnswer(
    receipt({
      vendorName: `Store ${n}`,
      documentNumber: `R-${n}`,
      subtotal: lines,
      tax: 0,
      total: lines,
      lineItems: each.map((line) => ({ amount: line.amount })),
    }),
    { lineItems: each, lineItemCount: lines },
  );
}

/** Twelve receipts; the fifth has six lines. */
const TWELVE = Array.from({ length: 12 }, (_, at) => storeReceipt(at + 1, at === 4 ? 6 : 1));

/**
 * The model, part by part: from document 1, documents 1–5 with the fifth's first three lines; from
 * document 5 line 4, its last three lines and documents 6–10; from document 11, the last two.
 */
function inParts(call: ModelRequest): JsonObject {
  const from = [call.input.fromDocument, call.input.fromLine];
  const fifth = TWELVE[4]!;
  const lines = fifth.lineItems as JsonObject[];
  if (from[0] === 1 && from[1] === 1) {
    const cut = { ...fifth, lineItems: lines.slice(0, 3) };
    return partAnswer([...TWELVE.slice(0, 4), cut], { document: 5, line: 4 }, 12);
  }
  if (from[0] === 5 && from[1] === 4) {
    const rest = { ...fifth, lineItems: lines.slice(3) };
    return partAnswer([rest, ...TWELVE.slice(5, 10)], { document: 11, line: 1 }, 12);
  }
  if (from[0] === 11 && from[1] === 1) return partAnswer(TWELVE.slice(10), null, 12);
  throw new Error(`no part starts at ${JSON.stringify(from)}`);
}

test('twelve receipts are read in three parts, each starting where the last stopped, and none is lost or read twice', async () => {
  const world = await documentsRun({ config: NONE, documents: TWELVE, parts: inParts });
  assert.equal(world.result.outcome, 'success', JSON.stringify(world.result).slice(0, 400));
  const reads = world.platform.modelCalls.filter((call) => !isSecondRead(call));
  assert.deepEqual(
    reads.map((call) => [
      call.input.fromDocument,
      call.input.fromLine,
      call.input.maximumDocuments,
    ]),
    [
      [1, 1, 5],
      [5, 4, 5],
      [11, 1, 5],
    ],
  );
  const documents = documentsOf(world.result);
  assert.deepEqual(
    documents.map((each) => [each.index, each.vendor.name]),
    TWELVE.map((each, at) => [at + 1, each.vendorName]),
  );
  // The fifth's lines, read across two parts, are all there, in order, once.
  assert.deepEqual(
    documents[4]?.lineItems.map((line) => line.description),
    ['Item 5.1', 'Item 5.2', 'Item 5.3', 'Item 5.4', 'Item 5.5', 'Item 5.6'],
  );
  assert.equal(documents[4]?.lineItemsComplete, true);
  assert.ok(documents.every((each) => each.status === 'saved'));
});

test('a part the platform says was cut at its answer cap is asked again, smaller — never skipped', async () => {
  const world = await documentsRun({ config: NONE, documents: [LOWES] });
  // The first read again, with the first attempts of the first part cut short.
  let cut = 2;
  world.platform.model = (call, model) => {
    if (cut > 0) {
      cut -= 1;
      return Promise.resolve(completion(model, '{"documentCount": 1, "documents": [', 'length'));
    }
    return Promise.resolve(completion(model, partAnswer([LOWES])));
  };
  world.platform.modelCalls.length = 0;
  const result = await world.automation.execute(
    { ...world.request, runId: '99999999-9999-4999-8999-999999999999' },
    world.platform,
  );
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 300));
  assert.deepEqual(
    world.platform.modelCalls.map((call) => [call.input.maximumDocuments, call.input.maximumLines]),
    [
      [PART_SIZES[0].documents, PART_SIZES[0].lines],
      [PART_SIZES[1].documents, PART_SIZES[1].lines],
    ],
    'both models cut at the cap: the same part, smaller',
  );
  assert.equal(documentsOf(result).length, 1);
});

test('a part that does not move the reading on ends it with what was read, the last lines marked incomplete', () => {
  const first = partAnswerOf(partAnswer([LOWES], { document: 1, line: 2 }))!;
  const read = withPart([], first, { document: 1, line: 1 });
  assert.deepEqual(read.next, { document: 1, line: 2 }, 'one line read: on from the second');
  // The next part lists nothing more of it and points back where it started.
  const again = partAnswerOf(partAnswer([], { document: 1, line: 2 }))!;
  const stopped = withPart(read.documents, again, read.next!);
  assert.equal(stopped.next, null);
  assert.equal(stopped.documents.length, 1);
  assert.equal(stopped.documents[0]?.lineItemsComplete, false);
  // A part pointing past documents it never listed is no way on either.
  const skipping = partAnswerOf(partAnswer([LOWES], { document: 4, line: 1 }))!;
  assert.equal(withPart([], skipping, { document: 1, line: 1 }).next, null);
});

test("a part's input says where it starts and how much it may list: numbers, never the file's words", () => {
  assert.deepEqual(partInput({ document: 6, line: 1 }, 0), {
    task: 'Extract the documents in the attached file.',
    fromDocument: 6,
    fromLine: 1,
    maximumDocuments: 5,
    maximumLines: 80,
  });
  assert.deepEqual(partInput({ document: 3, line: 41 }, 2), {
    task: 'Extract the documents in the attached file.',
    fromDocument: 3,
    fromLine: 41,
    maximumDocuments: 1,
    maximumLines: 10,
  });
});

test('a file with nothing in it fails with the plain sentence, and nothing is saved or recorded', async () => {
  const world = await documentsRun({ parts: () => partAnswer([], null, 0) }).catch(
    (error: unknown) => {
      throw error;
    },
  );
  assert.deepEqual(world.result, {
    outcome: 'failed',
    failureReason: 'No bill or receipt found. Try a clearer photo.',
  });
  assert.equal(world.platform.providerCalls.length, 0);
});
