import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CallbackRefusedError, type ModelCompletion } from '@autom8x/automation-sdk';
import { NO_ANSWER, refusalFixture, type ProblemInput } from '@autom8x/automation-sdk/testing';

import { EXTRACT_SENTENCES } from '../src/steps/extract.js';
import { GOOD_ANSWER, completion, everythingSaid, lines, pdf, setUp } from './fixtures.js';

/**
 * Every way `extract` ends a run on an answer the platform gave: a fixed sentence for the
 * run's reason, the reason word in the timeline, nothing created — and never a word of the
 * model's text or the platform's own.
 */

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
  assert.deepEqual(
    outcome.line,
    ['extract', 'failed', `The invoice could not be read (${reason})`],
    label,
  );
  assert.equal(outcome.world.platform.modelCalls.length, 1, `${label}: one call, never repeated`);
}

const refusing = (problem: ProblemInput) => () => Promise.reject(refusalFixture('model', problem));

test('every model off the schema, not JSON or cut off: the could-not-be-read sentence', async () => {
  for (const [label, text, finish] of [
    ['off the schema', JSON.stringify({ ...GOOD_ANSWER, extra: 1 }), 'stop'],
    ['not JSON', 'The invoice total is 461.53', 'stop'],
    ['cut off at the cap', '{"documentType":"invoice","lineItems":[', 'length'],
  ] as const) {
    const outcome = await ended((model) => Promise.resolve(completion(model, text, finish)));
    assertEndsWith(outcome, 'answer_unusable', EXTRACT_SENTENCES.answer_unusable, label);
    assert.equal(outcome.world.platform.modelAttempts.length, 2, `${label}: both models tried`);
  }
  assert.equal(
    EXTRACT_SENTENCES.answer_unusable,
    'The invoice could not be read; try a clearer photo or the PDF.',
  );
});

test('every model declining the document: the declined sentence', async () => {
  const outcome = await ended((model) => Promise.resolve(completion(model, '', 'content_filter')));
  assertEndsWith(
    outcome,
    'content_filtered',
    'The model provider declined to read this document.',
    'filtered',
  );
});

test('every model empty or silent (a reasonless 502): the no-answer sentence', async () => {
  for (const [label, answer] of [
    ['empty', (model: string) => Promise.resolve(completion(model, '   '))],
    ['no answer in time', () => Promise.resolve(NO_ANSWER)],
  ] as const) {
    assertEndsWith(
      await ended(answer),
      'no_answer',
      'No model could read the invoice just now, and nothing was created. Start the run again with the invoice in a few minutes.',
      label,
    );
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
    [
      forbidden('over_plan_limit', { used: 25, limit: 25 }),
      'allowance_used',
      'This workspace has used its 25 model calls this month.',
    ],
    [
      forbidden('over_plan_limit', { used: 1_000, limit: 1_000 }),
      'allowance_used',
      'This workspace has used its 1,000 model calls this month.',
    ],
    [
      forbidden('over_plan_limit', { used: 'many' }),
      'allowance_used',
      'This workspace has used its model calls this month.',
    ],
    [
      forbidden('capability_not_in_plan', { used: 0 }),
      'plan_without_model_calls',
      "This workspace's plan does not include model calls.",
    ],
    [
      forbidden('entitlements_not_configured', { used: 3 }),
      'plan_check_unavailable',
      "Model calls could not be checked against this workspace's plan just now; start the run again with the invoice later.",
    ],
  ] as const) {
    const outcome = await ended(answer);
    assertEndsWith(outcome, reason, sentence, sentence);
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
  assertEndsWith(
    outcome,
    'model_calls_off',
    'Model calls are not switched on yet.',
    'unconfigured',
  );
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
    [
      fileRefusal(422, 'content_type_not_accepted'),
      'file_type',
      'The invoice must be a PDF, JPEG or PNG file.',
    ],
    [
      fileRefusal(422, 'file_too_large'),
      'file_too_large',
      'The invoice file is larger than 3.5 MB.',
    ],
    [
      fileRefusal(422, 'file_content_mismatch'),
      'file_mismatch',
      'The invoice file is not the type it says it is; upload the PDF or photo again.',
    ],
    [
      fileRefusal(422, 'file_encrypted'),
      'file_encrypted',
      'The PDF is password-protected; upload a copy without a password.',
    ],
    [
      fileRefusal(502, 'file_integrity'),
      'file_integrity',
      'The invoice file could not be read back from storage; start the run again with the invoice.',
    ],
    [
      refusing({ status: 404, code: 'NOT_FOUND', detail: 'The requested resource was not found' }),
      'file_gone',
      'The invoice file is no longer available; start the run again with the invoice.',
    ],
  ] as const) {
    assertEndsWith(await ended(answer), reason, sentence, reason);
  }
  // The double's own 404: `receive` read the upload, and by the model call it is gone.
  const world = setUp();
  world.platform.readArtifact = () => Promise.resolve(pdf());
  world.platform.artifacts = [];
  assert.deepEqual(await world.run(), {
    outcome: 'failed',
    failureReason: 'The invoice file is no longer available; start the run again with the invoice.',
  });
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
      'Model calls are unavailable on the platform right now; start the run again with the invoice later.',
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
    EXTRACT_SENTENCES.no_answer,
    '404 upstream',
  );
});

test('a refusal of the request itself is a fault on our side; the deadline, out of time; the flood valve, busy', async () => {
  const fault =
    'The invoice could not be sent to be read because of a fault on our side; nothing was created.';
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
      'The run ran out of time before the invoice was read; start it again with the invoice.',
    ],
    [
      { status: 429, code: 'TOO_MANY_REQUESTS', detail: 'Too many requests' },
      'busy',
      'Autom8x is busy; run it again in a few minutes.',
    ],
    [
      { status: 503, code: 'DEPENDENCY_FAILURE', detail: 'Runs service is unavailable' },
      'no_answer',
      EXTRACT_SENTENCES.no_answer,
    ],
    [
      { status: 504, code: 'DEPENDENCY_FAILURE', detail: 'timeout' },
      'no_answer',
      EXTRACT_SENTENCES.no_answer,
    ],
  ] as const) {
    assertEndsWith(await ended(refusing(problem)), reason, sentence, `${problem.status} ${reason}`);
  }
});

test('an answer a platform should have refused — not JSON, not an object, the wrong shape, cut off — still ends as unusable', async () => {
  const wrongShape = { ...GOOD_ANSWER, lineItems: 'none' };
  for (const [label, text, finish] of [
    ['not JSON', 'Total: 413.34', 'stop'],
    ['not an object', '[1, 2]', 'stop'],
    ['no document type', JSON.stringify({ ...GOOD_ANSWER, documentType: 7 }), 'stop'],
    ['lines not a list', JSON.stringify(wrongShape), 'stop'],
    [
      'unclear fields not a list',
      JSON.stringify({ ...GOOD_ANSWER, uncertainFields: 'total' }),
      'stop',
    ],
    ['cut off', JSON.stringify(GOOD_ANSWER), 'length'],
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
      EXTRACT_SENTENCES.answer_unusable,
      label,
    );
  }
});

test('every sentence fits the one-line bound; none carries the platform’s words or the model’s', async () => {
  for (const sentence of Object.values(EXTRACT_SENTENCES))
    assert.ok(sentence.length <= 200, sentence);
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
