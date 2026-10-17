import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ModelRefusedError,
  PlatformClient,
  modelAuthor,
  renderPrompt,
  type ModelRequest,
} from '@autom8x/automation-sdk';
import { RecordingPlatform } from '@autom8x/automation-sdk/testing';

import { EXTRACT_DOCUMENTS_V1 } from '../src/prompts.js';
import { partInput } from '../src/run/extract.js';
import { MODELS } from '../src/run/model-refusals.js';
import { FILE_ID, completion, pdf } from './fixtures.js';
import { localServer } from './wire.js';

/**
 * The models the reads name: held to the platform's rule by the SDK before anything is sent,
 * and by two makers — so a later read that leaves out the maker of the model that served this
 * one (the platform's BUILD-PLAN 25.2.29, `excludeModelAuthors`) always has a model left.
 */

const REQUEST: ModelRequest = {
  ...renderPrompt(EXTRACT_DOCUMENTS_V1, partInput({ document: 1, line: 1 }, 0)),
  models: MODELS,
  artifactId: FILE_ID,
};

/** Lists the platform answers 400, in the words of that answer. */
const BAD_LISTS: [readonly string[], string][] = [
  [[], 'models must list 1 to 3 model ids'],
  [[...MODELS, 'openai/gpt-5.2', 'x-ai/grok-4.6'], 'models must list 1 to 3 model ids'],
  [[MODELS[0] ?? '', MODELS[0] ?? ''], 'models must not name a model twice'],
  [
    ['anthropic/claude-haiku-4.5:online'],
    "models[0] must not switch on OpenRouter's web search (':online')",
  ],
  [
    ['Anthropic/Claude-Haiku-4.5'],
    "models[0] must use only lowercase letters, digits and . _ : / ~ -, as OpenRouter's ids do",
  ],
];

test("MODELS passes the SDK's models rule and names two makers; a bad list is refused before anything is sent", async () => {
  assert.deepEqual(
    MODELS.map((model) => modelAuthor(model)),
    ['anthropic', 'google'],
    'a primary and a fallback by another maker',
  );
  const server = await localServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ model: completion('anthropic/claude-haiku-4.5') }));
    });
  });
  try {
    const client = new PlatformClient(server.origin, 'run-token', { modelTimeoutMs: 2_000 });
    await client.callModel(REQUEST);
    assert.equal(server.received(), 1, 'MODELS is sent');
    const double = new RecordingPlatform();
    double.artifacts = [pdf()];
    for (const [models, words] of BAD_LISTS) {
      for (const platform of [client, double]) {
        await assert.rejects(
          platform.callModel({ ...REQUEST, models }),
          { message: words },
          JSON.stringify(models),
        );
      }
    }
    assert.equal(server.received(), 1, 'no bad list left the process');
    assert.deepEqual(double.modelCalls, [], 'nor was one recorded');
  } finally {
    await server.close();
  }
});

test('a later read that leaves out the maker that served this one still has a model; leaving out both leaves none', async () => {
  for (const served of MODELS) {
    const platform = new RecordingPlatform();
    platform.artifacts = [pdf()];
    platform.model = (_call, model) => Promise.resolve(completion(model));
    const maker = modelAuthor(served) ?? '';
    const answer = await platform.callModel({ ...REQUEST, excludeModelAuthors: [maker] });
    assert.notEqual(modelAuthor(answer.model), maker, served);
    assert.deepEqual(
      platform.modelAttempts.map((attempt) => attempt.model),
      MODELS.filter((model) => model !== served),
    );
  }
  const platform = new RecordingPlatform();
  platform.artifacts = [pdf()];
  await assert.rejects(
    platform.callModel({ ...REQUEST, excludeModelAuthors: ['anthropic', 'google'] }),
    (error: unknown) => error instanceof ModelRefusedError && error.reason === 'no_model_left',
  );
  assert.deepEqual([platform.modelCalls, platform.modelAttempts], [[], []], 'nothing spent');
});
