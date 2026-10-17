import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  idempotencyKeyFor,
  renderPrompt,
  type InvokeRequest,
  type JsonObject,
} from '@autom8x/automation-sdk';
import { NO_ANSWER } from '@autom8x/automation-sdk/testing';

import { EXTRACT_DOCUMENTS_V1 } from '../src/prompts.js';
import { partAnswerOf, v2AnswerOf, type DocumentAnswer } from '../src/run/answer.js';
import { partInput } from '../src/run/extract.js';
import { MODELS } from '../src/run/model-refusals.js';
import { runStateOf } from '../src/run/state.js';
import { readLine } from '../src/run/words.js';
import { RUN_FAILS } from '../src/words.js';
import { SEEDED_STATE, extractWorld } from './extract-world.js';
import {
  FILE_ID,
  GOOD_ANSWER,
  QUICKBOOKS,
  completion,
  documentAnswer,
  isSecondRead,
  lines,
  partAnswer,
  reads,
  setUp,
} from './fixtures.js';

/**
 * `extract` when an answer comes, for a file of one document: the one request it sends — the one
 * model call a run makes unless the first read shows a problem (decision 3) — the platform's fallback
 * to the second model, answers kept whole whatever they say, its line, the time guard, and a
 * continuation, which never calls the model. A file of several, read in parts:
 * `documents-parts.test.ts`. The prompt file itself: `prompt.test.ts`.
 */

const READ = 'Read: bill from Harrowgate Office Supply, $461.53';

function extractLine(world: ReturnType<typeof setUp>) {
  return lines(world.platform).find(([stepId]) => stepId === 'extract');
}

/** One document as v3 reads it, typed. */
function documentOf(answer: JsonObject): DocumentAnswer {
  const [document] = partAnswerOf(partAnswer([documentAnswer(answer)]))?.documents ?? [];
  assert.ok(document);
  return document;
}

test("it sends one model request: the registered extract-documents v1, the part's numbers, MODELS and the run's file, nothing else; a second read only on a problem", async () => {
  const world = setUp({ config: { ...QUICKBOOKS, holdAboveAmount: 0 } });
  assert.equal((await world.run()).outcome, 'success');
  const [first, ...rest] = world.platform.modelCalls;
  const input = partInput({ document: 1, line: 1 }, 0);
  assert.deepEqual(first, {
    ...renderPrompt(EXTRACT_DOCUMENTS_V1, input),
    models: ['anthropic/claude-haiku-4.5', 'google/gemini-3.1-flash-lite'],
    artifactId: FILE_ID,
  });
  assert.deepEqual(input, {
    task: 'Extract the documents in the attached file.',
    fromDocument: 1,
    fromLine: 1,
    maximumDocuments: 5,
    maximumLines: 80,
  });
  // The part's numbers are the template's only words from outside it: nothing typed, nothing read.
  assert.ok(first?.prompt.includes('Start at document 1, and with its line 1.'));
  assert.ok(first?.prompt.includes('List at most 5 documents and at most 80 lines in all'));
  assert.deepEqual(
    rest.map((call) => isSecondRead(call)),
    [true],
    'over the limit: the one other call is the second read',
  );
  // Nothing wrong with the first read, within the limit: one model call, and no other.
  const plain = setUp();
  assert.equal((await plain.run()).outcome, 'success');
  assert.equal(plain.platform.modelCalls.length, 1);
});

test('it makes no provider call and sends no mail', async () => {
  const world = setUp();
  await world.run();
  const key = idempotencyKeyFor(world.request.runId, 'extract');
  assert.deepEqual(
    world.platform.providerCalls.filter((call) => call.idempotencyKey.startsWith(key)),
    [],
  );
  assert.equal(world.platform.providerCalls.length, 0, 'QuickBooks is read after the reads');
  assert.deepEqual(world.platform.mails, []);
});

test("the line (§3.E) says what was read — the type, the seller, the total — never a line or the model's other words; the state keeps each document's read, every earlier key, and the models", async () => {
  const world = extractWorld();
  const answer = {
    ...GOOD_ANSWER,
    lineItems: [{ amount: 1 }],
    lineItemsComplete: false,
    uncertainFields: ['documentDate', 'total'],
  };
  // The router may serve a dated id: it is kept as served.
  world.platform.model = (_call, model) =>
    Promise.resolve(completion(`${model}-20261001`, partAnswer([documentAnswer(answer)])));
  const state = (await world.state()) ?? {};
  const { documents: _documents, ...rest } = state;
  assert.deepEqual(rest, {
    ...SEEDED_STATE,
    modelServed: 'anthropic/claude-haiku-4.5-20261001',
    readMakers: ['anthropic'],
  });
  const [entry] = runStateOf(state)?.documents ?? [];
  assert.deepEqual(entry?.answer, v2AnswerOf(documentOf(answer)));
  assert.deepEqual([entry?.index, entry?.kind, entry?.stage], [1, 'record', 'read']);
  assert.deepEqual(world.platform.steps.at(-1)?.summary, READ);
  // A seller's name past 60 characters is shortened; a total not read is left out; a credit's
  // negative total read as its size; another currency named; several counted.
  assert.equal(
    readLine([documentOf({ ...GOOD_ANSWER, vendorName: 'V'.repeat(80), total: null })]),
    `Read: bill from ${'V'.repeat(59)}…`,
  );
  assert.equal(
    readLine([
      documentOf({ ...GOOD_ANSWER, documentType: 'credit_note', total: -12.5, currency: 'CAD' }),
    ]),
    'Read: credit note from Harrowgate Office Supply, 12.50 CAD',
  );
  assert.equal(
    readLine([documentOf({ ...GOOD_ANSWER, documentType: 'quote', vendorName: null })]),
    'Read: quote, $461.53',
  );
  const receipt = documentOf({ ...GOOD_ANSWER, documentType: 'receipt' });
  assert.equal(readLine([receipt, receipt, receipt]), 'Read: 3 receipts');
  assert.equal(readLine([receipt, documentOf(GOOD_ANSWER)]), 'Read: 2 documents');
  // A statement's listed rows are never quoted.
  const listing = extractWorld();
  const rows = Array.from({ length: 3 }, (_, index) => ({
    reference: `INV-${index}`,
    amount: 10,
    kind: 'invoice',
  }));
  listing.platform.model = (_call, model) =>
    Promise.resolve(
      completion(
        model,
        partAnswer([
          documentAnswer({
            ...GOOD_ANSWER,
            documentType: 'supplier_statement',
            listedItems: rows,
            listedItemsComplete: false,
          }),
        ]),
      ),
    );
  await listing.state();
  assert.equal(
    listing.platform.steps.at(-1)?.summary,
    'Read: statement from Harrowgate Office Supply, $461.53',
  );
});

test('fallback: the first model answers off the schema, and the second reads it', async () => {
  const world = setUp();
  world.platform.model = (call, model) =>
    !isSecondRead(call) && model === MODELS[0]
      ? Promise.resolve(
          completion(model, partAnswer([documentAnswer({ ...GOOD_ANSWER, total: 'twelve' })])),
        )
      : reads()(call, model);
  assert.equal((await world.run()).outcome, 'success');
  assert.deepEqual(world.platform.modelAttempts, [
    { model: 'anthropic/claude-haiku-4.5', outcome: 'refused' },
    { model: 'google/gemini-3.1-flash-lite', outcome: 'ok' },
  ]);
  assert.deepEqual(extractLine(world), ['extract', 'ok', READ]);
});

test('fallback: the first model gets no answer in time, and the second reads it', async () => {
  const world = setUp();
  world.platform.model = (call, model) =>
    !isSecondRead(call) && model === MODELS[0] ? Promise.resolve(NO_ANSWER) : reads()(call, model);
  assert.equal((await world.run()).outcome, 'success');
  assert.deepEqual(
    world.platform.modelAttempts.map((attempt) => attempt.outcome),
    ['unanswered', 'ok'],
  );
});

test("an answer finishing 'other' is read as one finishing 'stop'", async () => {
  const world = extractWorld();
  world.platform.model = (_call, model) =>
    Promise.resolve(completion(model, partAnswer([documentAnswer()]), 'other'));
  const [entry] = runStateOf((await world.state()) ?? {})?.documents ?? [];
  assert.deepEqual(entry?.answer, v2AnswerOf(documentOf(GOOD_ANSWER)));
});

test('schema-valid wrong answers pass unchanged, for the checks to judge', async () => {
  const wrong: Record<string, JsonObject> = {
    'wrong sums': { ...GOOD_ANSWER, subtotal: 999.99, total: 5 },
    'an invented vendor': { ...GOOD_ANSWER, vendorName: 'Nobody Printed This Inc' },
    'obeying injected text': { ...GOOD_ANSWER, vendorName: 'Trusted Vendor Inc', total: 1 },
    '41 lines marked complete': {
      ...GOOD_ANSWER,
      lineItems: Array.from({ length: 41 }, () => ({ amount: 1 })),
      lineItemsComplete: true,
    },
    'a receipt that reads as a bill': {
      ...GOOD_ANSWER,
      documentType: 'receipt',
      paymentMethod: 'card',
      cardLast4: '12345',
      tip: -3,
      cashBackPrinted: true,
    },
  };
  for (const [name, answer] of Object.entries(wrong)) {
    const world = extractWorld();
    world.platform.model = (_call, model) =>
      Promise.resolve(completion(model, partAnswer([documentAnswer(answer)])));
    const [entry] = runStateOf((await world.state()) ?? {})?.documents ?? [];
    assert.deepEqual(entry?.answer, v2AnswerOf(documentOf(answer)), name);
    assert.equal(world.platform.modelCalls.length, 1, `${name}: no second paid call`);
  }
});

test('the time guard: with less than 260 s to the deadline no model call is bought', async () => {
  const late = setUp({ deadlineInMs: 200_000 });
  assert.deepEqual(await late.run(), {
    outcome: 'failed',
    failureReason: RUN_FAILS.ai_unavailable,
  });
  assert.deepEqual(extractLine(late), ['extract', 'failed', RUN_FAILS.ai_unavailable]);
  assert.deepEqual(late.platform.modelCalls, []);
  const inTime = setUp({ deadlineInMs: 300_000 });
  assert.equal((await inTime.run()).outcome, 'success');
});

function continuing(request: InvokeRequest, stepId: string, state: JsonObject): InvokeRequest {
  return {
    ...request,
    continuation: {
      ofRunId: '66666666-6666-4666-8666-666666666666',
      kind: 'approval',
      stepId,
      decision: 'approved',
      decidedAt: new Date().toISOString(),
      state,
    },
  };
}

test('a continuation after approval never calls the model', async () => {
  // An approval resumes after the step that held, and every step that can hold comes after
  // the two reads: here, after the last step of the pipeline as it stands.
  const world = setUp();
  const state = { ...SEEDED_STATE, modelServed: MODELS[0] };
  const result = await world.automation.execute(
    continuing(world.request, 'verify-read', state),
    world.platform,
  );
  assert.equal(result.outcome, 'success');
  assert.deepEqual(world.platform.modelCalls, []);
  assert.deepEqual(world.platform.steps, []);
});

test("a state without the upload ends as the document can't be read right now, and no model call", async () => {
  for (const file of [undefined, {}, { artifactId: 'invoice.pdf' }, { artifactId: 42 }]) {
    const world = setUp();
    const { file: _kept, ...rest } = SEEDED_STATE;
    const state = file === undefined ? rest : { ...rest, file };
    const result = await world.automation.execute(
      continuing(world.request, 'receive', state),
      world.platform,
    );
    assert.deepEqual(
      result,
      { outcome: 'failed', failureReason: RUN_FAILS.ai_unavailable },
      JSON.stringify(file),
    );
    assert.deepEqual(world.platform.modelCalls, []);
  }
});
