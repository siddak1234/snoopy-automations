import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import type { ModelCompletion, ModelRequest } from '../src/contract.js';
import { isUnanswered, isUnsent } from '../src/marks.js';
import { PlatformClient } from '../src/platform.js';
import { CallbackRefusedError, MODEL_REFUSAL_REASONS, ModelRefusedError } from '../src/refusals.js';
import { isTransient } from '../src/retry.js';
import type { Step } from '../src/steps.js';
import { RecordingPlatform, artifactFixture, problemFixture } from '../src/testing.js';
import { recordedWaits } from './retry-fixtures.js';
import { define, extract, invoke, manifest, ok } from './runner-fixtures.js';
import { type StubPlatform, startStubPlatform } from './stub-platform.js';

/**
 * A model call that leaves out a model's maker — the platform's BUILD-PLAN 25.2.29, mirrored:
 * `excludeModelAuthors` names one to three makers; the client and the recording double refuse
 * a list the platform would answer 400, in its words, before anything is sent; the double
 * removes every model by those makers from the list that serves the call, the rest in order;
 * and a list left empty is the platform's 422 `no_model_left`, typed, with nothing spent and
 * nothing to retry. The rule itself is held to the published schema in
 * `contract-model-request.test.ts`.
 */

const REQUEST: ModelRequest = {
  capability: 'document-extraction',
  prompt: 'Extract.',
  input: {},
  outputSchema: { type: 'object' },
};
const FILE = '1e1f2021-2223-4425-8627-28292a2b2c2d';

/** Each list the platform answers 400, with the words of that answer. */
const REFUSED: [unknown, string][] = [
  [[], 'excludeModelAuthors must list 1 to 3 model authors'],
  [['a', 'b', 'c', 'd'], 'excludeModelAuthors must list 1 to 3 model authors'],
  [null, 'excludeModelAuthors must list 1 to 3 model authors'],
  ['google', 'excludeModelAuthors must list 1 to 3 model authors'],
  [
    ['Google'],
    "excludeModelAuthors[0] must be a model author, the part of a model id before its '/': 1–128 lowercase letters, digits and . _ -",
  ],
  [
    ['google', 'anthropic/claude-haiku-4.5'],
    "excludeModelAuthors[1] must be a model author, the part of a model id before its '/': 1–128 lowercase letters, digits and . _ -",
  ],
  [
    ['~anthropic'],
    "excludeModelAuthors[0] must be a model author, the part of a model id before its '/': 1–128 lowercase letters, digits and . _ -",
  ],
  [
    [42],
    "excludeModelAuthors[0] must be a model author, the part of a model id before its '/': 1–128 lowercase letters, digits and . _ -",
  ],
  [['google', 'google'], 'excludeModelAuthors must not name an author twice'],
];

/** A request carrying a list the type would not admit, as JavaScript could send it. */
function excluding(excludeModelAuthors: unknown): ModelRequest {
  return { ...REQUEST, excludeModelAuthors } as ModelRequest;
}

const answer = (model: string): ModelCompletion => ({
  text: '{}',
  model,
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

const waited = recordedWaits();
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

test('the model callback refuses with a closed list of reasons: the platform’s twelve, no_model_left among them', () => {
  assert.deepEqual(
    [...MODEL_REFUSAL_REASONS].sort(),
    [
      'capability_not_in_plan',
      'content_filtered',
      'content_type_not_accepted',
      'entitlements_not_configured',
      'file_content_mismatch',
      'file_encrypted',
      'file_integrity',
      'file_too_large',
      'no_model_left',
      'output_schema_mismatch',
      'over_plan_limit',
      'truncated',
    ],
    "the platform's twelve, and no other",
  );
});

test('a list of makers the platform would refuse is refused in the container, in its words, before anything is sent', async () => {
  const client = new PlatformClient(stub.origin, 'run-token', { modelTimeoutMs: 1000 });
  const platform = new RecordingPlatform();
  for (const [list, words] of REFUSED) {
    for (const refusing of [client, platform]) {
      await assert.rejects(
        refusing.callModel(excluding(list)),
        (error: unknown) => {
          assert.ok(error instanceof Error && !(error instanceof CallbackRefusedError));
          assert.equal(error.message, words);
          assert.equal(isUnanswered(error) || isUnsent(error) || isTransient(error), false);
          return true;
        },
        JSON.stringify(list),
      );
    }
  }
  assert.equal(stub.calls.length, 0, 'nothing left the process');
  assert.deepEqual(platform.modelCalls, [], 'nothing was recorded');
});

test('a list the platform accepts is sent as written, beside the models; a step names it on the call', async () => {
  const client = new PlatformClient(stub.origin, 'run-token', { modelTimeoutMs: 1000 });
  const sent = {
    ...REQUEST,
    models: ['google/gemini-3.1-flash-lite'],
    excludeModelAuthors: ['anthropic'],
  };
  await client.callModel(sent);
  assert.deepEqual(stub.calls.at(-1)?.body, sent);

  const receive: Step = async (context) => {
    await context.platform.callModel(
      extract,
      { reference: 'INV-7' },
      {
        models: ['anthropic/claude-haiku-4.5', 'x-ai/grok-4.6'],
        excludeModelAuthors: ['anthropic'],
      },
    );
    return { outcome: 'ok', summary: 'Read it again' };
  };
  const automation = define({
    manifests: [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])],
    prompts: [extract],
    steps: { receive, validate: ok('v'), post: ok('p') },
  });
  const platform = new RecordingPlatform();
  assert.equal((await automation.execute(invoke(), platform)).outcome, 'success');
  assert.deepEqual(platform.modelCalls[0]?.excludeModelAuthors, ['anthropic']);
  assert.deepEqual(platform.modelAttempts, [{ model: 'x-ai/grok-4.6', outcome: 'ok' }]);
});

test('the double removes every model by a maker the call leaves out, in order, from its models or the default, and keeps an id that names none', async () => {
  const platform = new RecordingPlatform();
  platform.model = (_call, model) => Promise.resolve(answer(model));
  await platform.callModel({
    ...REQUEST,
    models: [
      'anthropic/claude-haiku-4.5',
      '~anthropic/claude-sonnet-latest',
      'google/gemini-3.1-flash-lite',
    ],
    excludeModelAuthors: ['anthropic'],
  });
  assert.deepEqual(platform.modelAttempts, [
    { model: 'google/gemini-3.1-flash-lite', outcome: 'ok' },
  ]);

  // A model the platform could not use falls to the next one left, as before.
  const falling = new RecordingPlatform();
  falling.model = (_call, model) =>
    Promise.resolve(
      model === 'x-ai/grok-4.6' ? { ...answer(model), text: 'not json' } : answer(model),
    );
  await falling.callModel({
    ...REQUEST,
    models: ['google/gemini-3.5-flash', 'x-ai/grok-4.6', 'gemini-2.5-flash'],
    excludeModelAuthors: ['google', 'openai'],
  });
  assert.deepEqual(falling.modelAttempts, [
    { model: 'x-ai/grok-4.6', outcome: 'refused' },
    { model: 'gemini-2.5-flash', outcome: 'ok' },
  ]);

  const byDefault = new RecordingPlatform();
  byDefault.defaultModels = ['openai/gpt-5.2', 'google/gemini-3.1-flash-lite'];
  byDefault.model = (_call, model) => Promise.resolve(answer(model));
  assert.equal(
    (await byDefault.callModel({ ...REQUEST, excludeModelAuthors: ['openai'] })).model,
    'google/gemini-3.1-flash-lite',
  );
});

test('a call that leaves no model is the platform’s 422 no_model_left: typed, before the file is read, nothing recorded or retried', async () => {
  const platform = new RecordingPlatform();
  await assert.rejects(
    // The run was given no file: the platform reads it only after the models are resolved.
    platform.callModel({
      ...REQUEST,
      models: ['anthropic/claude-haiku-4.5', '~anthropic/claude-sonnet-latest'],
      excludeModelAuthors: ['anthropic'],
      artifactId: FILE,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ModelRefusedError);
      assert.equal(error.status, 422);
      assert.equal(error.reason, 'no_model_left');
      assert.equal(error.message, 'the model call was refused with 422: no_model_left');
      assert.equal(isTransient(error) || isUnsent(error), false, 'nothing to retry');
      return true;
    },
  );
  assert.deepEqual([platform.modelCalls, platform.modelAttempts], [[], []]);

  // The same refusal from the wire, as the platform writes it.
  stub.answers.model = () => ({
    status: 422,
    body: problemFixture({
      status: 422,
      code: 'BAD_REQUEST',
      detail: 'Every model that would serve this call is by a maker it excludes',
      details: { reason: 'no_model_left' },
    }),
  });
  const client = new PlatformClient(stub.origin, 'run-token', { modelTimeoutMs: 1000 });
  await assert.rejects(
    client.callModel({ ...REQUEST, excludeModelAuthors: ['anthropic'] }),
    (error: unknown) => error instanceof ModelRefusedError && error.reason === 'no_model_left',
  );

  // A step whose call leaves no model fails once, under either policy, naming the reason.
  for (const when of ['transient', 'unsent'] as const) {
    const receive: Step = async (context) => {
      await context.platform.callModel(
        extract,
        { reference: 'INV-7' },
        {
          models: ['anthropic/claude-haiku-4.5'],
          excludeModelAuthors: ['anthropic'],
        },
      );
      return { outcome: 'ok', summary: 'unreachable' };
    };
    const automation = define({
      manifests: [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])],
      prompts: [extract],
      steps: { receive, validate: ok('v'), post: ok('p') },
      retry: { receive: { attempts: 2, backoffMs: 10_000, when } },
    });
    const refused = new RecordingPlatform();
    refused.artifacts = [artifactFixture()];
    await assert.rejects(automation.execute(invoke(), refused), ModelRefusedError);
    assert.deepEqual(
      refused.steps.map((step) => step.summary),
      ['The receive step failed: the model call was refused (no_model_left)'],
      when,
    );
    assert.deepEqual(waited, [], when);
  }
});
