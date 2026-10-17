import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderPrompt, type JsonObject } from '@autom8x/automation-sdk';
import { NO_ANSWER, refusalFixture, type ProblemInput } from '@autom8x/automation-sdk/testing';

import { VERIFY_DOCUMENTS_V1 } from '../src/prompts.js';
import { MODELS } from '../src/run/model-refusals.js';
import { VERIFY_TASK } from '../src/run/verify.js';
import { RUN_FAILS } from '../src/words.js';
import { bill, receipt, statement } from './check-world.js';
import { FILE_ID, completion, secondAnswer } from './fixtures.js';
import { flat, verifyWorld, type Answering } from './verify-read-world.js';

/**
 * `verify-read`, the second read, when it is due (decision 3; when, `second-read.test.ts`), for a
 * file of one document (several: `documents-hold.test.ts`): its one request — blind, by another maker, never without the exclusion — what it keeps when the reads
 * agree or part, the second read not made (the run holds at decide), and the faults that fail.
 * Lines (§3.E): `Second read matches`, `Second read differs: …`, `Second read not made`.
 */

async function stateOf(world: ReturnType<typeof verifyWorld>): Promise<JsonObject> {
  const result = await world.run();
  assert.equal(result.outcome, 'success', JSON.stringify(result));
  return flat((result as { output: JsonObject }).output);
}

test("one request: verify-documents v1, the fixed task, the documents' places, MODELS less the first read's maker, the run's file — nothing of read 1", async () => {
  const world = verifyWorld({ first: receipt() });
  await stateOf(world);
  const input = { task: VERIFY_TASK, positions: '1' };
  assert.deepEqual(world.platform.modelCalls, [
    {
      ...renderPrompt(VERIFY_DOCUMENTS_V1, input),
      models: ['anthropic/claude-haiku-4.5', 'google/gemini-3.1-flash-lite'],
      excludeModelAuthors: ['anthropic'],
      artifactId: FILE_ID,
    },
  ]);
  assert.equal(VERIFY_TASK, 'Read again the documents the instruction names.');
  assert.ok(world.platform.modelCalls[0]?.prompt.includes('by their numbers: 1;'));
  // Blind: no value of the first read.
  const sent = JSON.stringify(world.platform.modelCalls);
  for (const value of ['Tidewell', '55120', '60.63', '2026-09-27']) {
    assert.ok(!sent.includes(value), value);
  }
  // The platform served another maker's model.
  assert.deepEqual(world.platform.modelAttempts, [{ model: MODELS[1], outcome: 'ok' }]);
});

test("a first read served by Google's model leaves Google out; an alias counts as its maker", async () => {
  const google = verifyWorld({ first: bill(), firstModel: 'google/gemini-3.1-flash-lite-preview' });
  await stateOf(google);
  assert.deepEqual(google.platform.modelCalls[0]?.excludeModelAuthors, ['google']);
  assert.deepEqual(google.platform.modelAttempts, [{ model: MODELS[0], outcome: 'ok' }]);
  const alias = verifyWorld({ first: bill(), firstModel: '~anthropic/claude-haiku-latest' });
  await stateOf(alias);
  assert.deepEqual(alias.platform.modelCalls[0]?.excludeModelAuthors, ['anthropic']);
});

test('the reads agree: the second read is kept, the first stands, the line says they match', async () => {
  const world = verifyWorld({ first: bill() });
  const state = await stateOf(world);
  assert.deepEqual(state.verification, {
    status: 'made',
    modelServed: 'google/gemini-3.1-flash-lite',
    compared: [
      'documentType',
      'vendorName',
      'documentNumber',
      'documentDate',
      'currency',
      'total',
      'dueDate',
      'amountDue',
      'spendType',
    ],
    differences: [],
    totalPicked: null,
    spendTypeDisputed: false,
  });
  assert.deepEqual(state.document, world.document);
  assert.equal(world.line()?.summary, 'Second read matches');
  assert.deepEqual([world.platform.providerCalls, world.platform.mails], [[], []]);
});

test('the reads part: both values kept for decide, the first read written unless only the second adds up', async () => {
  const parted = verifyWorld({
    first: bill(),
    answer: (_call, model) =>
      Promise.resolve(
        completion(
          model,
          secondAnswer(bill(), { documentDate: '2026-09-15', spendType: 'materials' }),
        ),
      ),
  });
  const state = await stateOf(parted);
  assert.deepEqual((state.verification as JsonObject).differences, [
    { field: 'documentDate', first: '2026-09-14', second: '2026-09-15' },
  ]);
  assert.equal((state.verification as JsonObject).spendTypeDisputed, true);
  assert.equal(parted.line()?.summary, 'Second read differs: date');
  // The first read misread its total; the second's adds up, is recorded, and the arithmetic re-run.
  const misread = bill({ total: 431.34 });
  const picked = verifyWorld({
    first: misread,
    answer: (_call, model) =>
      Promise.resolve(completion(model, secondAnswer(misread, { total: 413.34 }))),
  });
  const pickedState = await stateOf(picked);
  const document = pickedState.document as JsonObject;
  assert.deepEqual([document.totalCents, document.findings], [41334, []]);
  assert.equal((pickedState.verification as JsonObject).totalPicked, 'second');
  assert.equal(picked.line()?.summary, 'Second read differs: total');
  // Its re-check meets a rule QuickBooks cannot record it under: not recorded, the details saved.
  const due = bill({ total: 400, amountDue: 400, subtotal: 370.75 });
  const stopped = verifyWorld({
    first: due,
    answer: (_call, model) =>
      Promise.resolve(completion(model, secondAnswer(due, { total: 413.34 }))),
  });
  const stoppedState = await stateOf(stopped);
  assert.deepEqual(stoppedState.quickBooks, { notRecorded: 'part may already be paid' });
  assert.equal(stopped.line()?.summary, 'Not recorded in QuickBooks: part may already be paid');
  // With "None" — the second read due on an unclear total — no recording rule is weighed.
  const unclear = bill({
    total: 400,
    amountDue: 400,
    subtotal: 370.75,
    uncertainFields: ['total'],
  });
  const none = verifyWorld({
    first: unclear,
    config: { vendor: 'none' },
    answer: (_call, model) =>
      Promise.resolve(completion(model, secondAnswer(unclear, { total: 413.34 }))),
  });
  const noneState = await stateOf(none);
  assert.equal(noneState.quickBooks, undefined);
  assert.equal((noneState.document as JsonObject).totalCents, 41334);
});

test('a statement: the type alone; the second read not seeing one is kept for decide (F7)', async () => {
  const agreed = verifyWorld({ first: statement(), config: { vendor: 'quickbooks' }, state: {} });
  const seeded = agreed.document as unknown as JsonObject;
  // A statement's amount is no record's: a second read is due only on a problem, and it has none.
  assert.equal((await agreed.run()).outcome, 'success');
  assert.equal(agreed.line(), undefined, 'not due: skipped, no line');
  const forced = verifyWorld({
    first: statement(),
    state: { document: { ...seeded, findings: ['amounts_mismatch'] } },
  });
  await stateOf(forced);
  assert.equal(forced.line()?.summary, 'Second read matches');
  const parted = verifyWorld({
    first: statement(),
    state: { document: { ...seeded, findings: ['amounts_mismatch'] } },
    answer: (_call, model) =>
      Promise.resolve(
        completion(model, secondAnswer(statement(), { documentType: 'bill', total: 96.4 })),
      ),
  });
  const state = await stateOf(parted);
  assert.deepEqual((state.verification as JsonObject).differences, [
    { field: 'documentType', first: 'supplier statement', second: 'bill' },
  ]);
});

/** The step's outcome when the second read is not made: the run goes on, recorded so decide holds it. */
async function notMade(world: ReturnType<typeof verifyWorld>) {
  const state = await stateOf(world);
  const verification = state.verification as JsonObject;
  assert.equal(verification.status, 'not_made');
  assert.equal(world.line()?.summary, 'Second read not made', 'its reason in the state alone');
  assert.deepEqual(state.document, world.document, 'the first read stands');
  return verification.reason;
}

test('never without the exclusion: no maker to leave out, or one outside the rule, is a second read not made — and no call', async () => {
  for (const firstModel of [
    'test-model',
    'Anthropic/claude-haiku-4.5',
    `${'a'.repeat(129)}/model`,
  ]) {
    const world = verifyWorld({ first: bill(), firstModel });
    assert.equal(await notMade(world), 'no_other_maker', firstModel);
    assert.deepEqual(world.platform.modelCalls, [], firstModel);
  }
});

test('every model left by the same maker: the platform refuses with nothing spent, and the run holds (no_model_left)', async () => {
  const world = verifyWorld({ first: bill() });
  world.platform.defaultModels = ['anthropic/claude-haiku-4.5'];
  // The owner's switch names one maker's models only: the call's list, as the platform serves it.
  const original = world.platform.callModel.bind(world.platform);
  world.platform.callModel = (request) =>
    original({ ...request, models: ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5'] });
  assert.equal(await notMade(world), 'no_model_left');
  assert.deepEqual(world.platform.modelAttempts, []);
});

test("the second read's own refusals hold the run, each its word: unusable, filtered, the plan's", async () => {
  const forbidden = (reason: string) =>
    refusing({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'refused',
      details: { reason, used: 25, limit: 25 },
    });
  const cases: [string, Answering][] = [
    [
      'answer_unusable',
      (_call, model) => Promise.resolve(completion(model, { ...secondAnswer(bill()), extra: 1 })),
    ],
    ['answer_unusable', (_call, model) => Promise.resolve(completion(model, 'not JSON'))],
    [
      'answer_unusable',
      (_call, model) => Promise.resolve(completion(model, '{"documentType":', 'length')),
    ],
    [
      'content_filtered',
      (_call, model) => Promise.resolve(completion(model, '', 'content_filter')),
    ],
    ['no_answer', () => Promise.resolve(NO_ANSWER)],
    ['no_answer', (_call, model) => Promise.resolve(completion(model, '  '))],
    ['allowance_used', forbidden('over_plan_limit')],
    ['plan_without_model_calls', forbidden('capability_not_in_plan')],
    ['plan_check_unavailable', forbidden('entitlements_not_configured')],
  ];
  for (const [reason, answer] of cases) {
    const world = verifyWorld({ first: bill(), answer });
    assert.equal(await notMade(world), reason, reason);
    assert.equal(world.platform.modelCalls.length, 1, `${reason}: made once, never again`);
  }
});

test('served by the maker it left out, which the platform never does: not made, never compared', async () => {
  const world = verifyWorld({
    first: bill(),
    answer: () => Promise.resolve(completion('anthropic/claude-sonnet-4.5', secondAnswer(bill()))),
  });
  assert.equal(await notMade(world), 'same_maker');
});

const refusing = (problem: ProblemInput) => () => Promise.reject(refusalFixture('model', problem));

test("out of time, and the platform's own faults, fail the run with one of the spec's sentences", async () => {
  const late = verifyWorld({ first: bill(), deadlineInMs: 200_000 });
  assert.deepEqual(await late.run(), {
    outcome: 'failed',
    failureReason: RUN_FAILS.ai_unavailable,
  });
  assert.deepEqual(late.platform.modelCalls, [], 'no call bought past the 260 s guard');
  const thrown: [ProblemInput, string][] = [
    [
      { status: 403, code: 'FORBIDDEN', detail: 'late', details: { reason: 'deadline_exceeded' } },
      RUN_FAILS.ai_unavailable,
    ],
    [{ status: 404, code: 'NOT_FOUND', detail: 'gone' }, RUN_FAILS.file],
    [{ status: 429, code: 'TOO_MANY_REQUESTS', detail: 'busy' }, RUN_FAILS.ai_busy],
    [{ status: 503, code: 'NOT_CONFIGURED', detail: 'off' }, RUN_FAILS.ai_unavailable],
    [
      {
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: 'key',
        details: { upstreamStatus: '401' },
      },
      RUN_FAILS.ai_unavailable,
    ],
    [
      {
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: 'credit',
        details: { upstreamStatus: '402' },
      },
      RUN_FAILS.ai_unavailable,
    ],
    [
      {
        status: 400,
        code: 'BAD_REQUEST',
        detail: 'no such field',
        details: { field: 'excludeModelAuthors' },
      },
      RUN_FAILS.ai_unavailable,
    ],
    [
      {
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: 'store',
        details: { reason: 'file_integrity' },
      },
      RUN_FAILS.ai_unavailable,
    ],
    [
      { status: 422, code: 'BAD_REQUEST', detail: 'pdf', details: { reason: 'file_encrypted' } },
      RUN_FAILS.ai_unavailable,
    ],
  ];
  for (const [problem, sentence] of thrown) {
    const world = verifyWorld({ first: bill(), answer: refusing(problem) });
    assert.deepEqual(
      await world.run(),
      { outcome: 'failed', failureReason: sentence },
      JSON.stringify(problem),
    );
  }
});

test('a state without what the earlier steps keep: no file fails before any call; no usable document is not read again; no maker is no second read', async () => {
  for (const state of [{ file: { artifactId: 'invoice.pdf' } }, { file: undefined }]) {
    const world = verifyWorld({ first: bill(), state });
    assert.deepEqual(
      await world.run(),
      { outcome: 'failed', failureReason: RUN_FAILS.ai_unavailable },
      JSON.stringify(state),
    );
    assert.deepEqual(world.platform.modelCalls, []);
  }
  for (const state of [{ document: undefined }, { document: { route: 'bill' } }]) {
    const world = verifyWorld({ first: bill(), state });
    assert.equal((await world.run()).outcome, 'success', JSON.stringify(state));
    assert.equal(world.line(), undefined, 'nothing to read again: skipped');
    assert.deepEqual(world.platform.modelCalls, []);
  }
  const noMaker = verifyWorld({ first: bill(), state: { readMakers: undefined } });
  assert.equal(await notMade(noMaker), 'no_other_maker');
  assert.deepEqual(noMaker.platform.modelCalls, []);
});
