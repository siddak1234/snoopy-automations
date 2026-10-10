import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ModelRequest } from '../src/contract.js';
import {
  ARTIFACT_ID_PATTERN,
  MODEL_ID_PATTERN,
  MODEL_REQUEST_LIMITS,
  artifactIdProblem,
  modelIdProblem,
  modelsProblem,
} from '../src/model-request.js';
import { assertValid, schemas, validator } from './published-schemas.js';

/**
 * The model request's two copied rules against the published schema
 * (`contract/schemas/automation-model-request.json`): the model-id rule
 * (`models`, the platform's BUILD-PLAN 25.2.16) and the file-id rule (`artifactId`,
 * its 25.2.18). Each copy must carry the schema's own pattern and give the platform's
 * answer for every one of the platform's samples, so a refresh that moves either rule
 * fails here before an automation is refused for it.
 */

test('a model request naming its models validates, and one naming the singular model does not', () => {
  // Since the platform's BUILD-PLAN 25.2.16 (`contract/README.md`, refreshed 2026-10-09).
  const validate = validator('automation-model-request');
  const request: ModelRequest = {
    capability: 'document-extraction',
    prompt: 'Extract the invoice fields.',
    input: { text: '...' },
    outputSchema: { type: 'object' },
    models: ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini', 'anthropic/claude-haiku-4.5'],
  };
  assertValid(validate, request, 'a primary and two fallbacks');
  assertValid(validate, { ...request, models: ['google/gemini-2.5-flash'] }, 'a primary alone');
  const { models: _models, ...withoutModels } = request;
  assert.equal(validate({ ...withoutModels, model: 'google/gemini-2.5-flash' }), false);
  assert.equal(validate({ ...request, model: 'google/gemini-2.5-flash' }), false);
});

/**
 * The samples the platform judges its model-id rule and migration 0018's CHECK on
 * (snoopy-backend `test/helpers/model-ids.ts` at `49c9fac`), copied as data.
 */
const ACCEPTED_MODEL_IDS = [
  'google/gemini-2.5-flash',
  '~google/gemini-flash-latest',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-5.2:exacto',
  'gemini-2.5-flash',
  'vendor/model:onlinex',
  'vendor/online-model',
  'vendor/model:nitrox',
  'vendor/floor-model',
  'x'.repeat(128),
];
const REFUSED_MODEL_IDS: [string, RegExp][] = [
  ['', /printable ASCII/u],
  ['x'.repeat(129), /printable ASCII/u],
  ['google/gemini 2.5', /printable ASCII/u],
  ['tab\tmodel', /printable ASCII/u],
  ['new\nline', /printable ASCII/u],
  ['modèle', /printable ASCII/u],
  ['@preset/invoice', /preset/u],
  ['openai/gpt-4@preset/invoice', /preset/u],
  ['google/gemini-2.5-flash:online', /web search/u],
  ['google/gemini-2.5-flash:online:nitro', /web search/u],
  ['meta-llama/llama-3.3-70b-instruct:free:online', /web search/u],
  ['openai/gpt-4o:ONLINE', /lowercase/u],
  ['Google/Gemini-2.5-Flash', /lowercase/u],
  ['OpenRouter/Fusion', /lowercase/u],
  ['openrouter/fusion', /router/u],
  ['openrouter/auto', /router/u],
  ['~openrouter/auto', /router/u],
  ['openai/gpt-5.2:nitro', /routing/u],
  ['openai/gpt-5.2:nitro:exacto', /routing/u],
  ['google/gemini-2.5-flash:floor', /routing/u],
  ['meta-llama/llama-3.3-70b-instruct:free:floor', /routing/u],
];

test('the SDK’s model rule is the published schema’s: its pattern, its bounds, its answer for every sample', () => {
  const validate = validator('automation-model-request');
  const schema = JSON.parse(
    readFileSync(join(schemas, 'automation-model-request.json'), 'utf8'),
  ) as {
    required: string[];
    properties: {
      models: {
        minItems: number;
        maxItems: number;
        uniqueItems: boolean;
        items: { maxLength: number; pattern: string };
      };
    };
  };
  const { models } = schema.properties;
  assert.ok(!schema.required.includes('models'), 'models is optional');
  assert.deepEqual(
    [models.minItems, models.maxItems, models.uniqueItems],
    [1, MODEL_REQUEST_LIMITS.models, true],
  );
  assert.equal(models.items.pattern, MODEL_ID_PATTERN.source);
  assert.equal(models.items.maxLength, MODEL_REQUEST_LIMITS.modelIdLength);

  const base = { capability: 'summarization', prompt: 'p', input: {}, outputSchema: {} };
  for (const id of ACCEPTED_MODEL_IDS) {
    assert.equal(modelIdProblem(id), undefined, id);
    assert.ok(validate({ ...base, models: [id] }), id);
  }
  for (const [id, words] of REFUSED_MODEL_IDS) {
    assert.match(modelsProblem([id]) ?? '', words, JSON.stringify(id));
    assert.equal(validate({ ...base, models: [id] }), false, JSON.stringify(id));
  }
  // The list's own bounds, the same both ways: three is the most, none is not a list.
  for (const list of [[], ['a/b', 'c/d', 'e/f', 'g/h'], ['a/b', 'a/b'], 'a/b', null, [42]]) {
    assert.notEqual(modelsProblem(list), undefined, JSON.stringify(list));
    assert.equal(validate({ ...base, models: list }), false, JSON.stringify(list));
  }
  assert.equal(modelsProblem(['a/b', 'c/d', 'e/f']), undefined);
  assert.ok(validate({ ...base, models: ['a/b', 'c/d', 'e/f'] }));
});

test("a model request may name the run's file, by the published schema's rule, which is the SDK's", () => {
  // The platform's BUILD-PLAN 25.2.18; its samples (snoopy-backend
  // `test/wire-schema.test.ts` at `4875579`), copied as data.
  const validate = validator('automation-model-request');
  const schema = JSON.parse(
    readFileSync(join(schemas, 'automation-model-request.json'), 'utf8'),
  ) as { required: string[]; properties: { artifactId: { type: string; pattern: string } } };
  assert.ok(!schema.required.includes('artifactId'), 'optional: most calls carry no file');
  assert.equal(schema.properties.artifactId.type, 'string');
  assert.equal(schema.properties.artifactId.pattern, ARTIFACT_ID_PATTERN.source);

  const request: ModelRequest = {
    capability: 'document-extraction',
    prompt: 'Extract the invoice fields.',
    input: {},
    outputSchema: { type: 'object' },
    artifactId: '1e1f2021-2223-4425-8627-28292a2b2c2d',
  };
  assertValid(validate, request, 'a model request naming its file');
  for (const [id, expected] of [
    ['1e1f2021-2223-4425-8627-28292a2b2c2d', true],
    ['1E1F2021-2223-4425-8627-28292A2B2C2D', true],
    ['invoice.pdf', false],
    ['1e1f2021-2223-0425-8627-28292a2b2c2d', false],
    ['1e1f2021-2223-4425-c627-28292a2b2c2d', false],
    ['', false],
    [42, false],
  ] as const) {
    assert.equal(artifactIdProblem(id) === undefined, expected, JSON.stringify(id));
    assert.equal(validate({ ...request, artifactId: id }), expected, JSON.stringify(id));
  }
});
