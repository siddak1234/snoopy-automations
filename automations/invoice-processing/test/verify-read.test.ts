import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';
import { NO_ANSWER, refusalFixture, type ProblemInput } from '@autom8x/automation-sdk/testing';

import { CHECK_DOCUMENT_SENTENCES } from '../src/checks/rules.js';
import { VERIFY_DOCUMENT_V1 } from '../src/prompts.js';
import { MODELS } from '../src/steps/extract.js';
import { VERIFY_INPUT, VERIFY_READ_SENTENCES } from '../src/steps/verify-read.js';
import { bill, paidBy, receipt, statement } from './check-world.js';
import { FILE_ID, completion, secondAnswer } from './fixtures.js';
import { verifyWorld, type Answering } from './verify-read-world.js';

/**
 * `verify-read`, the second read: its one request — blind, by another maker, never without the
 * exclusion — what it keeps when the reads agree or part, the second check not made (the run
 * holds at decide), and the faults that fail.
 */

async function stateOf(world: ReturnType<typeof verifyWorld>): Promise<JsonObject> {
  const result = await world.run();
  assert.equal(result.outcome, 'success', JSON.stringify(result));
  return (result as { output: JsonObject }).output;
}

test("one request: verify-document v1, the fixed task, MODELS less the first read's maker, the run's file — nothing of read 1", async () => {
  const world = verifyWorld({
    first: receipt(),
    options: paidBy('employee', { paidFrom: null }),
  });
  await stateOf(world);
  assert.deepEqual(world.platform.modelCalls, [
    {
      capability: 'document-extraction',
      prompt: VERIFY_DOCUMENT_V1.template,
      input: { task: 'Extract the fields of the attached document.' },
      outputSchema: VERIFY_DOCUMENT_V1.outputSchema,
      models: ['anthropic/claude-haiku-4.5', 'google/gemini-3.1-flash-lite'],
      excludeModelAuthors: ['anthropic'],
      artifactId: FILE_ID,
    },
  ]);
  assert.deepEqual(VERIFY_INPUT, { task: 'Extract the fields of the attached document.' });
  // Blind: no value of the first read, and never "Who paid".
  const sent = JSON.stringify(world.platform.modelCalls);
  for (const value of ['Tidewell', '55120', '60.63', 'Robin Example', '2026-09-27']) {
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

test('the reads agree: the second check is kept, the first read stands, the line counts the fields', async () => {
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
  assert.deepEqual(state.document, world.seeded.document);
  assert.equal(
    world.line()?.summary,
    'Read again by google/gemini-3.1-flash-lite: the 9 fields compared agree',
  );
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
  assert.equal(
    parted.line()?.summary,
    'Read again by google/gemini-3.1-flash-lite: the reads differ on date; spend type disputed, the default category used',
  );
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
  assert.equal(
    picked.line()?.summary,
    "Read again by google/gemini-3.1-flash-lite: the reads differ on total; the second read's total adds up and is kept",
  );
  // Its re-check meets a fail rule: the run ends with check-document's sentence.
  const due = bill({ total: 400, amountDue: 400, subtotal: 370.75 });
  const failing = verifyWorld({
    first: due,
    answer: (_call, model) =>
      Promise.resolve(completion(model, secondAnswer(due, { total: 413.34 }))),
  });
  assert.deepEqual(await failing.run(), {
    outcome: 'failed',
    failureReason: CHECK_DOCUMENT_SENTENCES.C15,
  });
  assert.equal(failing.line()?.summary, 'Checked again, not recorded (amount_due_below_charges)');
});

test('a statement: the type alone; the second read not seeing one is kept for decide (F7)', async () => {
  const agreed = verifyWorld({ first: statement() });
  await stateOf(agreed);
  assert.equal(
    agreed.line()?.summary,
    'Read again by google/gemini-3.1-flash-lite: the document type agrees',
  );
  const parted = verifyWorld({
    first: statement(),
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
  assert.equal(
    world.line()?.summary,
    `A second check could not be made (${String(verification.reason)})`,
  );
  assert.deepEqual(state.document, world.seeded.document, 'the first read stands');
  return verification.reason;
}

test('never without the exclusion: no maker to leave out, or one outside the rule, is a second check not made — and no call', async () => {
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

test("out of time, and the platform's own faults, fail the run with a fixed sentence", async () => {
  const late = verifyWorld({ first: bill(), deadlineInMs: 200_000 });
  assert.deepEqual(await late.run(), {
    outcome: 'failed',
    failureReason: VERIFY_READ_SENTENCES.out_of_time,
  });
  assert.deepEqual(late.platform.modelCalls, [], 'no call bought past the 260 s guard');
  const thrown: [ProblemInput, string][] = [
    [
      { status: 403, code: 'FORBIDDEN', detail: 'late', details: { reason: 'deadline_exceeded' } },
      VERIFY_READ_SENTENCES.out_of_time,
    ],
    [{ status: 404, code: 'NOT_FOUND', detail: 'gone' }, VERIFY_READ_SENTENCES.file_gone],
    [
      { status: 429, code: 'TOO_MANY_REQUESTS', detail: 'busy' },
      'Autom8x is busy; run it again in a few minutes.',
    ],
    [{ status: 503, code: 'NOT_CONFIGURED', detail: 'off' }, VERIFY_READ_SENTENCES.platform_fault],
    [
      {
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: 'key',
        details: { upstreamStatus: '401' },
      },
      VERIFY_READ_SENTENCES.model_account_refused,
    ],
    [
      {
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: 'credit',
        details: { upstreamStatus: '402' },
      },
      VERIFY_READ_SENTENCES.model_account_refused,
    ],
    [
      {
        status: 400,
        code: 'BAD_REQUEST',
        detail: 'no such field',
        details: { field: 'excludeModelAuthors' },
      },
      VERIFY_READ_SENTENCES.platform_fault,
    ],
    [
      {
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: 'store',
        details: { reason: 'file_integrity' },
      },
      VERIFY_READ_SENTENCES.platform_fault,
    ],
    [
      { status: 422, code: 'BAD_REQUEST', detail: 'pdf', details: { reason: 'file_encrypted' } },
      VERIFY_READ_SENTENCES.platform_fault,
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
  assert.deepEqual(VERIFY_READ_SENTENCES, {
    out_of_time:
      'The run ran out of time before the document was checked a second time; start it again with the document.',
    platform_fault:
      'The document could not be checked a second time because of a fault on our side; nothing was created.',
    file_gone: 'The document file is no longer available; start the run again with the document.',
    model_account_refused:
      'Model calls are unavailable on the platform right now; start the run again with the document later.',
    state_incomplete:
      'Bills & Receipts could not finish its checks. Run it again. Nothing was created.',
  });
});

test('a state without what the earlier steps keep fails before any call', async () => {
  const cases: [JsonObject, string][] = [
    [{ document: undefined }, VERIFY_READ_SENTENCES.state_incomplete],
    [{ document: { route: 'bill' } }, VERIFY_READ_SENTENCES.state_incomplete],
    [{ modelServed: undefined }, VERIFY_READ_SENTENCES.state_incomplete],
    [{ file: { artifactId: 'invoice.pdf' } }, VERIFY_READ_SENTENCES.platform_fault],
    [{ file: undefined }, VERIFY_READ_SENTENCES.platform_fault],
  ];
  for (const [state, sentence] of cases) {
    const world = verifyWorld({ first: bill(), state });
    assert.deepEqual(
      await world.run(),
      { outcome: 'failed', failureReason: sentence },
      JSON.stringify(state),
    );
    assert.deepEqual(world.platform.modelCalls, []);
  }
});
