import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import type { ModelRequest } from '../src/contract.js';
import { isUnanswered } from '../src/marks.js';
import { PlatformClient } from '../src/platform.js';
import { CallbackRefusedError } from '../src/refusals.js';
import { isTransient } from '../src/retry.js';
import type { Step } from '../src/steps.js';
import { RecordingPlatform } from '../src/testing.js';
import { recordedWaits } from './retry-fixtures.js';
import { define, extract, invoke, manifest, ok } from './runner-fixtures.js';
import { type StubPlatform, startStubPlatform } from './stub-platform.js';

/**
 * A model request's `models` — the primary, then up to two fallbacks — from the step
 * that names them to the wire (platform BUILD-PLAN 25.2.16): a list the platform would
 * answer 400 is refused in the container, in the platform's words and before anything
 * is sent (`model-request.ts`), by the client and the recording double alike; a list it
 * accepts is sent as written, in order; and a step that names none sends none, so the
 * platform's default serves. The rule itself is held to the published schema in
 * `contract-model-request.test.ts`.
 */

const REQUEST: ModelRequest = {
  capability: 'document-extraction',
  prompt: 'Extract.',
  input: { text: 'INV-1' },
  outputSchema: { type: 'object' },
};

/** Each list the platform answers 400, with the words of that answer. */
const REFUSED: [unknown, string][] = [
  [[], 'models must list 1 to 3 model ids'],
  [['a/one', 'a/two', 'a/three', 'a/four'], 'models must list 1 to 3 model ids'],
  [null, 'models must list 1 to 3 model ids'],
  [['google/gemini 2.5'], 'models[0] must be 1–128 printable ASCII characters, no space'],
  [['google/gemini-2.5-flash', 42], 'models[1] must be 1–128 printable ASCII characters, no space'],
  [
    ['google/gemini-2.5-flash', '@preset/invoice'],
    "models[1] must not name an OpenRouter preset ('@')",
  ],
  [
    ['openai/gpt-4.1-mini:online:nitro'],
    "models[0] must not switch on OpenRouter's web search (':online')",
  ],
  [['openai/gpt-4.1-mini', 'openai/gpt-4.1-mini'], 'models must not name a model twice'],
];

/** A request carrying a list the type would not admit, as JavaScript could send it. */
function naming(models: unknown): ModelRequest {
  return { ...REQUEST, models } as ModelRequest;
}

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

test("a list the platform would refuse is refused in the container, in the platform's words, before anything is sent", async () => {
  const client = new PlatformClient(stub.origin, 'run-token', { modelTimeoutMs: 1000 });
  for (const [models, words] of REFUSED) {
    await assert.rejects(
      client.callModel(naming(models)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, words);
        // Not the platform's answer and not an answer that never came: never retried.
        assert.ok(!(error instanceof CallbackRefusedError));
        assert.equal(isUnanswered(error), false);
        assert.equal(isTransient(error), false);
        return true;
      },
      JSON.stringify(models),
    );
  }
  assert.equal(stub.calls.length, 0, 'nothing left the process');
});

test('a list the platform accepts is sent as written and in order; a request with none sends none', async () => {
  const client = new PlatformClient(stub.origin, 'run-token', { modelTimeoutMs: 1000 });
  const models = ['anthropic/claude-haiku-4.5', 'google/gemini-2.5-flash', 'openai/gpt-4.1-mini'];
  const completion = await client.callModel({ ...REQUEST, models });
  assert.equal(completion.model, 'stub-model', 'the answer names the model that served');
  assert.deepEqual(stub.calls.at(-1)?.body, { ...REQUEST, models });
  await client.callModel(REQUEST);
  assert.deepEqual(Object.keys(stub.calls.at(-1)?.body as object).sort(), [
    'capability',
    'input',
    'outputSchema',
    'prompt',
  ]);
});

test('the recording double refuses what the client refuses, in the same words, before recording it', async () => {
  const platform = new RecordingPlatform();
  for (const [models, words] of REFUSED) {
    await assert.rejects(platform.callModel(naming(models)), { message: words });
  }
  assert.deepEqual(platform.modelCalls, [], 'nothing was recorded');
  await platform.callModel({ ...REQUEST, models: ['google/gemini-2.5-flash'] });
  assert.deepEqual(platform.modelCalls, [{ ...REQUEST, models: ['google/gemini-2.5-flash'] }]);
});

/** An automation whose first step sends the extraction prompt, to `models` when given. */
function extracting(models: readonly string[] | undefined, retry = false) {
  const receive: Step = async (context) => {
    const completion = await context.platform.callModel(extract, { reference: 'INV-7' }, models);
    return { outcome: 'ok', summary: `Extracted by ${completion.model}` };
  };
  return define({
    manifests: [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])],
    prompts: [extract],
    steps: { receive, validate: ok('v'), post: ok('p') },
    ...(retry ? { retry: { receive: { attempts: 3, backoffMs: 10_000 } } } : {}),
  });
}

test('a step names its models on the call: they ride beside the rendered prompt, and a step that names none sends none', async () => {
  const models = ['openai/gpt-4.1-mini', 'google/gemini-2.5-flash'];
  const named = new RecordingPlatform();
  await extracting(models).execute(invoke(), named);
  const rendered = {
    capability: 'document-extraction',
    prompt: 'Extract the invoice fields from INV-7.',
    input: { reference: 'INV-7' },
    outputSchema: { type: 'object' },
  };
  assert.deepEqual(named.modelCalls, [{ ...rendered, models }]);

  const unnamed = new RecordingPlatform();
  await extracting(undefined).execute(invoke(), unnamed);
  assert.deepEqual(unnamed.modelCalls, [rendered], 'no models key: the platform default serves');
});

test('a step whose list the platform would refuse fails at that step, unsent, and is never retried', async () => {
  const platform = new RecordingPlatform();
  await assert.rejects(
    extracting(['google/gemini-2.5-flash:online'], true).execute(invoke(), platform),
    { message: "models[0] must not switch on OpenRouter's web search (':online')" },
  );
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome, step.summary]),
    [['receive', 'failed', 'The receive step failed']],
    'one attempt, reported once',
  );
  assert.deepEqual(waited, [], 'no wait: nothing to retry');
  assert.equal(platform.modelCalls.length, 0, 'nothing was sent');
});
