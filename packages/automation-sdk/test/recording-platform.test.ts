import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import type { ModelCompletion, ModelRequest } from '../src/contract.js';
import { PlatformClient } from '../src/platform.js';
import { CallbackRefusedError, ModelRefusedError } from '../src/refusals.js';
import type { Step } from '../src/steps.js';
import { artifactFixture, NO_ANSWER, RecordingPlatform } from '../src/testing.js';
import { define, extract, invoke, manifest, ok } from './runner-fixtures.js';
import { type StubPlatform, startStubPlatform } from './stub-platform.js';

/**
 * The run's file on a model call (platform BUILD-PLAN 25.2.18; SDK 25.3.9) and the test
 * double that answers a model call as the platform's callback does (SDK 25.3.10): a
 * schema outside the platform's keywords is its 400; one model per attempt, an answer it
 * could not use or no answer in time falling to the next; the last refusal typed as the
 * platform types it — so an automation's suite fails where production would.
 */

const FILE = '1e1f2021-2223-4425-8627-28292a2b2c2d';
const SCHEMA = { type: 'object', required: ['total'], properties: { total: { type: 'number' } } };
const REQUEST: ModelRequest = {
  capability: 'document-extraction',
  prompt: 'Read the invoice attached.',
  input: {},
  outputSchema: SCHEMA,
};

let stub: StubPlatform;
before(async () => {
  stub = await startStubPlatform();
});
after(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.calls = [];
  stub.answers = {};
});

const answer = (
  model: string,
  text: string,
  finishReason: ModelCompletion['finishReason'] = 'stop',
): ModelCompletion => ({
  text,
  model,
  finishReason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

test("a model call names the run's file by its id, and a malformed id never leaves the container", async () => {
  const client = new PlatformClient(stub.origin, 'run-token', { modelTimeoutMs: 1000 });
  await client.callModel({ ...REQUEST, artifactId: FILE });
  assert.deepEqual(stub.calls.at(-1)?.body, { ...REQUEST, artifactId: FILE });
  for (const bad of ['', 'invoice.pdf', '1e1f2021-2223-0425-8627-28292a2b2c2d']) {
    await assert.rejects(client.callModel({ ...REQUEST, artifactId: bad }), {
      message: 'artifactId must be the id of an uploaded file',
    });
  }
  assert.equal(stub.calls.length, 1, 'the malformed ids were never sent');
});

test('a step names the file and its models on the call; a list alone is still the models', async () => {
  const receive: Step = async (context) => {
    const completion = await context.platform.callModel(
      extract,
      { reference: 'INV-7' },
      { models: ['google/gemini-3.5-flash'], artifactId: FILE },
    );
    await context.platform.callModel(extract, { reference: 'INV-7' }, ['x-ai/grok-4.6']);
    return { outcome: 'ok', summary: `Extracted by ${completion.model}` };
  };
  const automation = define({
    manifests: [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])],
    prompts: [extract],
    steps: { receive, validate: ok('v'), post: ok('p') },
  });
  const platform = new RecordingPlatform();
  platform.artifacts = [artifactFixture({ artifactId: FILE })];
  const result = await automation.execute(invoke(), platform);
  assert.equal(result.outcome, 'success');
  assert.equal(platform.modelCalls[0]?.artifactId, FILE);
  assert.deepEqual(platform.modelCalls[0]?.models, ['google/gemini-3.5-flash']);
  assert.ok(!('artifactId' in (platform.modelCalls[1] ?? {})));
  assert.deepEqual(platform.modelCalls[1]?.models, ['x-ai/grok-4.6']);
});

test("the double answers a file the run was not given with the platform's 404, and records nothing", async () => {
  const platform = new RecordingPlatform();
  await assert.rejects(
    platform.callModel({ ...REQUEST, artifactId: FILE }),
    (error: unknown) => error instanceof CallbackRefusedError && error.status === 404,
  );
  assert.deepEqual(platform.modelCalls, []);
  await assert.rejects(platform.callModel({ ...REQUEST, artifactId: 'nope' }), {
    message: 'artifactId must be the id of an uploaded file',
  });
});

test("a schema outside the platform's keywords is its 400, before any attempt", async () => {
  const platform = new RecordingPlatform();
  await assert.rejects(
    platform.callModel({ ...REQUEST, outputSchema: { type: 'string', pattern: '^INV-' } }),
    (error: unknown) =>
      error instanceof CallbackRefusedError &&
      !(error instanceof ModelRefusedError) &&
      error.status === 400 &&
      /outputSchema uses pattern/u.test(error.detail),
  );
  assert.deepEqual(platform.modelAttempts, []);
});

test('the last refusal is typed as the platform types it, after every attempt', async () => {
  for (const [last, reason, status, path, rule] of [
    [answer('z/last', 'not json'), 'output_schema_mismatch', 422, '$', 'json'],
    [
      answer('z/last', '{"total":"twelve"}'),
      'output_schema_mismatch',
      422,
      '$.total',
      'type:number',
    ],
    [answer('z/last', '', 'content_filter'), 'content_filtered', 422, undefined, undefined],
    [answer('z/last', '{"to', 'length'), 'truncated', 422, undefined, undefined],
  ] as const) {
    const platform = new RecordingPlatform();
    platform.model = (_call, model) =>
      Promise.resolve(model === 'z/last' ? last : answer(model, '', 'length'));
    await assert.rejects(
      platform.callModel({ ...REQUEST, models: ['y/first', 'z/last'] }),
      (error: unknown) =>
        error instanceof ModelRefusedError &&
        error.status === status &&
        error.reason === reason &&
        error.path === path &&
        error.rule === rule,
      reason,
    );
    assert.deepEqual(
      platform.modelAttempts.map((attempt) => attempt.model),
      ['y/first', 'z/last'],
    );
  }

  // No answer in time, and an empty answer: the platform's 502s, which name no reason.
  const silent: (ModelCompletion | typeof NO_ANSWER)[] = [NO_ANSWER, answer('z/last', '   ')];
  for (const last of silent) {
    const platform = new RecordingPlatform();
    platform.model = () => Promise.resolve(last);
    await assert.rejects(
      platform.callModel(REQUEST),
      (error: unknown) =>
        error instanceof CallbackRefusedError && error.status === 502 && error.reason === undefined,
    );
  }
});

test('the first usable answer is the call, and every attempt before it is recorded as the ledger would', async () => {
  const platform = new RecordingPlatform();
  platform.model = (_call, model) =>
    Promise.resolve(
      model === 'a/slow'
        ? NO_ANSWER
        : model === 'b/off-schema'
          ? answer(model, '{"nope":1}')
          : answer(model, '{"total":4}'),
    );
  const completion = await platform.callModel({
    ...REQUEST,
    models: ['a/slow', 'b/off-schema', 'c/serves'],
  });
  assert.equal(completion.model, 'c/serves');
  assert.deepEqual(platform.modelAttempts, [
    { model: 'a/slow', outcome: 'unanswered' },
    { model: 'b/off-schema', outcome: 'refused' },
    { model: 'c/serves', outcome: 'ok' },
  ]);
  assert.equal(platform.modelCalls.length, 1, 'one call, three attempts');

  // A call that names no models is served by the default list.
  const plain = new RecordingPlatform();
  plain.defaultModels = ['vendor/default'];
  plain.model = (_call, model) => Promise.resolve(answer(model, '{"total":1}'));
  assert.equal((await plain.callModel(REQUEST)).model, 'vendor/default');
});

test('an error the scripted model throws ends the call as thrown, as before', async () => {
  const platform = new RecordingPlatform();
  const failure = new Error('scripted failure');
  platform.model = () => Promise.reject(failure);
  await assert.rejects(platform.callModel({ ...REQUEST, models: ['a/b', 'c/d'] }), failure);
});
