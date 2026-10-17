import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CallbackRefusedError, type ModelCompletion } from '@autom8x/automation-sdk';
import { NO_ANSWER, refusalFixture, type ProblemInput } from '@autom8x/automation-sdk/testing';

import { PART_SIZES } from '../src/run/extract.js';
import { EXTRACT_FAILS } from '../src/run/model-refusals.js';
import { RUN_FAILS } from '../src/words.js';
import {
  GOOD_ANSWER,
  completion,
  documentAnswer,
  everythingSaid,
  lines,
  partAnswer,
  pdf,
  setUp,
} from './fixtures.js';

/**
 * Every way `extract` ends a run on an answer the platform gave: one of the spec's sentences
 * (§3.F) for the run's reason and its line, the reason word in the log alone — and never a word of
 * the model's text or the platform's own.
 */

const UNREADABLE = RUN_FAILS.unreadable;
const BUSY = RUN_FAILS.ai_busy;
const UNAVAILABLE = RUN_FAILS.ai_unavailable;
const FILE = RUN_FAILS.file;

/** A world whose model answers every attempt with `answer`, or rejects with it. */
async function ended(answer: (model: string) => Promise<ModelCompletion | typeof NO_ANSWER>) {
  const world = setUp();
  world.platform.model = (_call, model) => answer(model);
  const result = await world.run();
  return { world, result, line: lines(world.platform).at(-1) };
}

function assertEndsWith(
  outcome: Awaited<ReturnType<typeof ended>>,
  reason: string,
  sentence: string,
  label: string,
): void {
  assert.deepEqual(outcome.result, { outcome: 'failed', failureReason: sentence }, label);
  assert.deepEqual(outcome.line, ['extract', 'failed', sentence], label);
  assert.ok(
    outcome.world.logs.some(
      ([, message, fields]) => message === 'step_failed' && fields?.reason === reason,
    ),
    `${label}: the code in the log`,
  );
  assert.equal(outcome.world.platform.modelCalls.length, 1, `${label}: one call, never repeated`);
}

const refusing = (problem: ProblemInput) => () => Promise.reject(refusalFixture('model', problem));

test('every model off the schema or not JSON: the could-not-be-read sentence', async () => {
  for (const [label, text, finish] of [
    ['off the schema', JSON.stringify({ ...GOOD_ANSWER, extra: 1 }), 'stop'],
    ['not JSON', 'The document total is 461.53', 'stop'],
  ] as const) {
    const outcome = await ended((model) => Promise.resolve(completion(model, text, finish)));
    assertEndsWith(outcome, 'answer_unusable', UNREADABLE, label);
    assert.equal(outcome.world.platform.modelAttempts.length, 2, `${label}: both models tried`);
  }
  assert.equal(UNREADABLE, "The document can't be read. Try a clearer photo.");
});

test('every model cut off at the cap, at every part size: asked again smaller, then the could-not-be-read sentence', async () => {
  const world = setUp();
  world.platform.model = (_call, model) =>
    Promise.resolve(completion(model, '{"documentCount":1,"documents":[', 'length'));
  const result = await world.run();
  assert.deepEqual(result, { outcome: 'failed', failureReason: UNREADABLE });
  assert.deepEqual(
    world.platform.modelCalls.map((call) => call.input.maximumDocuments),
    PART_SIZES.map((size) => size.documents),
    'each size once, smaller each time',
  );
});

test('every model declining the document: the declined sentence', async () => {
  const outcome = await ended((model) => Promise.resolve(completion(model, '', 'content_filter')));
  assertEndsWith(outcome, 'content_filtered', UNREADABLE, 'filtered');
});

test('every model empty or silent (a reasonless 502): the no-answer sentence', async () => {
  for (const [label, answer] of [
    ['empty', (model: string) => Promise.resolve(completion(model, '   '))],
    ['no answer in time', () => Promise.resolve(NO_ANSWER)],
  ] as const) {
    assertEndsWith(await ended(answer), 'no_answer', BUSY, label);
  }
});

test("the plan's refusals on the first attempt, each after one model call", async () => {
  const forbidden = (reason: string, details: Record<string, unknown>) =>
    refusing({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'refused',
      details: { reason, ...details },
    });
  for (const [answer, reason, sentence] of [
    [forbidden('over_plan_limit', { used: 25, limit: 25 }), 'allowance_used', UNAVAILABLE],
    [forbidden('over_plan_limit', { used: 1_000, limit: 1_000 }), 'allowance_used', UNAVAILABLE],
    [forbidden('over_plan_limit', { used: 'many' }), 'allowance_used', UNAVAILABLE],
    [forbidden('capability_not_in_plan', { used: 0 }), 'plan_without_model_calls', UNAVAILABLE],
    [forbidden('entitlements_not_configured', { used: 3 }), 'plan_check_unavailable', UNAVAILABLE],
  ] as const) {
    const outcome = await ended(answer);
    assertEndsWith(outcome, reason, sentence, reason);
    assert.deepEqual(outcome.world.platform.modelAttempts, [], 'refused before any vendor call');
  }
});

test('503 NOT_CONFIGURED, the platform before its key: not switched on, and not repeated', async () => {
  const outcome = await ended(
    refusing({
      status: 503,
      code: 'NOT_CONFIGURED',
      detail: 'model gateway adapter is not configured',
      details: { component: 'model gateway' },
    }),
  );
  assertEndsWith(outcome, 'model_calls_off', UNAVAILABLE, 'unconfigured');
});

test("each of the run's file refusals, and a file the run was not given, has its own sentence", async () => {
  const fileRefusal = (status: number, reason: string) =>
    refusing({
      status,
      code: status === 502 ? 'DEPENDENCY_FAILURE' : 'BAD_REQUEST',
      detail: 'refused',
      details: { reason },
    });
  for (const [answer, reason, sentence] of [
    [fileRefusal(422, 'content_type_not_accepted'), 'file_type', FILE],
    [fileRefusal(422, 'file_too_large'), 'file_too_large', FILE],
    [fileRefusal(422, 'file_content_mismatch'), 'file_mismatch', FILE],
    [fileRefusal(422, 'file_encrypted'), 'file_encrypted', FILE],
    [fileRefusal(502, 'file_integrity'), 'file_integrity', FILE],
    [
      refusing({ status: 404, code: 'NOT_FOUND', detail: 'The requested resource was not found' }),
      'file_gone',
      FILE,
    ],
  ] as const) {
    assertEndsWith(await ended(answer), reason, sentence, reason);
  }
  // The double's own 404: `receive` read the upload, and by the model call it is gone.
  const world = setUp();
  world.platform.readArtifact = () => Promise.resolve(pdf());
  world.platform.artifacts = [];
  assert.deepEqual(await world.run(), { outcome: 'failed', failureReason: FILE });
  assert.deepEqual(world.platform.modelCalls, [], 'refused before the call was made');
});

test("OpenRouter refusing the platform's key or credit (a 502 with its upstream 401 or 402): unavailable", async () => {
  for (const upstreamStatus of ['401', '402']) {
    assertEndsWith(
      await ended(
        refusing({
          status: 502,
          code: 'DEPENDENCY_FAILURE',
          detail: 'The model provider refused the request',
          details: { upstreamStatus },
        }),
      ),
      'model_account_refused',
      UNAVAILABLE,
      upstreamStatus,
    );
  }
  // Any other upstream status is the router's refusal of a model: no answer.
  assertEndsWith(
    await ended(
      refusing({
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: 'x',
        details: { upstreamStatus: '404' },
      }),
    ),
    'no_answer',
    BUSY,
    '404 upstream',
  );
});

test('a refusal of the request itself is a fault on our side; the deadline, out of time; the flood valve, busy', async () => {
  const fault = UNAVAILABLE;
  for (const [problem, reason, sentence] of [
    [
      { status: 400, code: 'BAD_REQUEST', detail: 'outputSchema uses pattern' },
      'platform_fault',
      fault,
    ],
    [{ status: 401, code: 'UNAUTHENTICATED', detail: 'run token' }, 'platform_fault', fault],
    [
      {
        status: 403,
        code: 'FORBIDDEN',
        detail: 'x',
        details: { reason: 'capability_not_declared' },
      },
      'platform_fault',
      fault,
    ],
    [
      { status: 403, code: 'FORBIDDEN', detail: 'x', details: { reason: 'run_mismatch' } },
      'platform_fault',
      fault,
    ],
    [
      { status: 409, code: 'CONFLICT', detail: 'x', details: { reason: 'run_not_active' } },
      'platform_fault',
      fault,
    ],
    [
      {
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: 'x',
        details: { reason: 'pinned_version_unavailable' },
      },
      'platform_fault',
      fault,
    ],
    [
      { status: 422, code: 'BAD_REQUEST', detail: 'x', details: { reason: 'no_model_left' } },
      'platform_fault',
      fault,
    ],
    [
      {
        status: 403,
        code: 'FORBIDDEN',
        detail: 'The run deadline has passed',
        details: { reason: 'deadline_exceeded' },
      },
      'out_of_time',
      UNAVAILABLE,
    ],
    [{ status: 429, code: 'TOO_MANY_REQUESTS', detail: 'Too many requests' }, 'busy', BUSY],
    [
      { status: 503, code: 'DEPENDENCY_FAILURE', detail: 'Runs service is unavailable' },
      'no_answer',
      BUSY,
    ],
    [{ status: 504, code: 'DEPENDENCY_FAILURE', detail: 'timeout' }, 'no_answer', BUSY],
  ] as const) {
    assertEndsWith(await ended(refusing(problem)), reason, sentence, `${problem.status} ${reason}`);
  }
});

test('an answer a platform should have refused — not JSON, not an object, the wrong shape, a value off its list, cut off — still ends as unusable', async () => {
  const one = documentAnswer();
  const wrongShape = partAnswer([{ ...one, lineItems: 'none' }]);
  const off = (change: Record<string, unknown>) =>
    JSON.stringify(partAnswer([{ ...one, ...change }]));
  const part = (change: Record<string, unknown>) =>
    JSON.stringify({ ...partAnswer([one]), ...change });
  for (const [label, text, finish] of [
    ['not JSON', 'Total: 413.34', 'stop'],
    ['not an object', '[1, 2]', 'stop'],
    ["v2's one-document answer", JSON.stringify(GOOD_ANSWER), 'stop'],
    ['no document type', off({ documentType: 7 }), 'stop'],
    ['a type off the list', off({ documentType: 'statement' }), 'stop'],
    ['references not a list', off({ references: 'PO 7' }), 'stop'],
    ['a line without its words', off({ lineItems: [{ amount: 1 }] }), 'stop'],
    ['a next part with no line', part({ nextDocument: 2, nextLine: 0 }), 'stop'],
    ['a next part before the first', part({ nextDocument: -1, nextLine: 1 }), 'stop'],
    ['no count of documents', part({ documentCount: undefined }), 'stop'],
    ['lines not a list', JSON.stringify(wrongShape), 'stop'],
    ['listed rows not a list', off({ listedItems: {} }), 'stop'],
    ['listed rows missing', off({ listedItems: undefined }), 'stop'],
    ['a listed row that is not one', off({ listedItems: ['INV-1'] }), 'stop'],
    [
      'a listed row of an unknown kind',
      off({ listedItems: [{ reference: 'INV-1', amount: 1, kind: 'refund' }] }),
      'stop',
    ],
    ['a payment method off the list', off({ paymentMethod: 'paypal' }), 'stop'],
    ['no payment method', off({ paymentMethod: null }), 'stop'],
    ['a refund method off the list', off({ refundMethod: 'store_credit' }), 'stop'],
    ['a spend type off the list', off({ spendType: 'fuel' }), 'stop'],
    ['no spend type', off({ spendType: undefined }), 'stop'],
    ['unclear fields not a list', off({ uncertainFields: 'total' }), 'stop'],
    ['cut off', part({}), 'length'],
  ] as const) {
    const world = setUp();
    // A platform that hands any answer over: the step's own checks are the last line.
    world.platform.callModel = (request) => {
      world.platform.modelCalls.push(request);
      return Promise.resolve(completion('vendor/model', text, finish));
    };
    assertEndsWith(
      { world, result: await world.run(), line: lines(world.platform).at(-1) },
      'answer_unusable',
      UNREADABLE,
      label,
    );
  }
});

test("every sentence is one of the spec's, within the one-line bound; none carries the platform's words or the model's", async () => {
  for (const fail of Object.values(EXTRACT_FAILS)) {
    assert.ok(
      [UNREADABLE, BUSY, UNAVAILABLE, FILE, RUN_FAILS.none_found].includes(RUN_FAILS[fail]),
      fail,
    );
  }
  const marker = 'QZ7LEAK';
  for (const answer of [
    (model: string) => Promise.resolve(completion(model, `{"vendorName":"${marker}"}`)),
    () =>
      Promise.reject(
        refusalFixture('model', {
          status: 400,
          code: 'BAD_REQUEST',
          detail: `the request quoted ${marker}`,
          details: { field: marker },
        }),
      ),
    () => Promise.reject(new CallbackRefusedError('model', 502, `<html>${marker}</html>`)),
  ]) {
    const { world, result } = await ended(answer);
    assert.equal(result.outcome, 'failed');
    assert.ok(!everythingSaid(world.platform, result).includes(marker));
  }
});
