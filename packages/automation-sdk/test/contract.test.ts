import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  CAPABILITIES,
  MAIL_BODY_MAX_LENGTH,
  MAIL_SUBJECT_MAX_LENGTH,
  isArtifactListing,
  isArtifactReference,
  isCapability,
  isContinuation,
  isInvokeRequest,
  isMailAcceptance,
  isModelCompletion,
  oneLine,
  toArtifactListing,
  truncateText,
  type InvokeAck,
  type MailRequest,
  type ModelRequest,
  type ProviderRequest,
  type RunResult,
  type StepReport,
} from '../src/contract.js';
import { isManifest, readManifest } from '../src/manifest.js';
import {
  MODEL_ID_PATTERN,
  MODEL_REQUEST_LIMITS,
  modelIdProblem,
  modelsProblem,
} from '../src/model-request.js';
import { artifactFixture, invokeFixture } from '../src/testing.js';

/**
 * The SDK's shapes against the platform's PUBLISHED schemas, vendored at
 * `contract/schemas`. What the SDK sends must validate; what the SDK reads must be
 * accepted by its guards in the shape the platform actually answers.
 */

const schemas = resolve(import.meta.dirname, '../../../contract/schemas');
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);

// Compiled once each: Ajv refuses a second schema under the same `$id`.
const compiled = new Map<string, ValidateFunction>();

function validator(name: string): ValidateFunction {
  const cached = compiled.get(name);
  if (cached) return cached;
  const validate = ajv.compile(
    JSON.parse(readFileSync(join(schemas, `${name}.json`), 'utf8')) as object,
  );
  compiled.set(name, validate);
  return validate;
}

function assertValid(validate: ValidateFunction, value: unknown, what: string): void {
  assert.ok(validate(value), `${what}: ${ajv.errorsText(validate.errors)}`);
}

test('an invoke the platform would send is accepted, with or without a continuation', () => {
  const validate = validator('automation-invoke-request');
  const first = invokeFixture();
  assertValid(validate, first, 'a first run');
  assert.ok(isInvokeRequest(first));

  const continued = invokeFixture({
    input: {},
    continuation: {
      ofRunId: '44444444-4444-4444-8444-444444444444',
      kind: 'approval',
      stepId: 'validate',
      decision: 'approved',
      decidedAt: new Date().toISOString(),
      state: { invoice: { reference: 'INV-1' } },
    },
  });
  assertValid(validate, continued, 'a continuation');
  assert.ok(isInvokeRequest(continued));
  assert.ok(isContinuation(continued.continuation));
});

test('an invoke missing what the automation needs is refused by the guard', () => {
  const { runToken: _token, ...withoutToken } = invokeFixture();
  assert.equal(isInvokeRequest(withoutToken), false, 'no run token');
  assert.equal(isInvokeRequest({ ...invokeFixture(), config: 'x' }), false, 'config not an object');
  assert.equal(
    isInvokeRequest({ ...invokeFixture(), continuation: { ofRunId: 'r', kind: 'approval' } }),
    false,
    'a continuation without its state',
  );
  assert.equal(
    isInvokeRequest({
      ...invokeFixture(),
      continuation: { ofRunId: 'r', kind: 'later', state: {} },
    }),
    false,
    'a continuation of an unknown kind',
  );
  // Additions are tolerated: the platform may add a field this automation ignores.
  assert.ok(isInvokeRequest({ ...invokeFixture(), traceId: 'added-later' }));
});

test('every acknowledgement the shell can return validates', () => {
  const validate = validator('automation-invoke-ack');
  const acks: InvokeAck[] = [
    { accepted: true, runId: 'r' },
    { accepted: false, runId: 'r', reason: 'unknown-template' },
    { accepted: false, runId: 'r', reason: 'draining', retryAfterSeconds: 30 },
    { accepted: false, runId: 'r', reason: 'at-capacity', retryAfterSeconds: 10 },
    { accepted: false, runId: 'r', reason: 'unsupported-contract-version' },
  ];
  for (const ack of acks) assertValid(validate, ack, JSON.stringify(ack));
});

test('every result variant validates, with the runId the client adds, and retryState is gone', () => {
  const validate = validator('automation-run-result');
  const results: RunResult[] = [
    { outcome: 'success' },
    { outcome: 'success', output: { reference: 'INV-1' }, summary: 'Recorded INV-1' },
    { outcome: 'held', held: { stepId: 'validate', reason: 'Above threshold', state: { n: 1 } } },
    { outcome: 'failed', failureReason: 'input must carry an invoice' },
  ];
  for (const result of results) assertValid(validate, result, result.outcome);
  // FLIPPED 2026-09-08. The client sends `{ runId, ...result }`; the platform's
  // published schema refused it and its route tolerated it by omission (its
  // §12.1 #82). Resolved on the platform side: every branch admits `runId`, and
  // the route binds it to the token's run when sent.
  for (const result of results)
    assertValid(validate, { runId: 'r', ...result }, `${result.outcome} with runId`);
  // WITHDRAWN 2026-09-08 (platform §12.1 #84): `retryState` was surface with no
  // implementation behind it. The schema no longer carries it, and the platform's
  // route refuses it as undeclared — so a client that still sends it is told.
  assert.equal(
    validate({ outcome: 'failed', failureReason: 'transient', retryState: { attempt: 2 } }),
    false,
    'retryState is refused, not silently dropped',
  );
});

test('a one-line field is trimmed and cut at the bound, and refused when empty', () => {
  assert.equal(oneLine('  Recorded INV-1  ', 'summary'), 'Recorded INV-1');
  assert.equal(oneLine('x'.repeat(300), 'summary').length, 200);
  assert.throws(() => oneLine('   ', 'summary'), /summary must be a non-empty line/u);
});

test('a step report validates WITH runId, which the published schema now requires', () => {
  // FLIPPED 2026-09-08. The platform's step handler always REQUIRED `runId` and
  // the published schema forbade it — a fake that agreed with itself, filed as
  // the platform's §12.1 #81 by session 2 here. Resolved on the platform side:
  // the schema requires what the route requires, and this SDK sent it all along.
  const validate = validator('automation-step-report');
  const report: StepReport = {
    runId: 'r',
    stepId: 'receive',
    outcome: 'held',
    summary: 'Above the threshold',
    heldReason: 'Someone should approve this',
  };
  assertValid(validate, report, 'the report as the SDK sends it');
  const { runId: _runId, ...withoutRunId } = report;
  assert.equal(
    validate(withoutRunId),
    false,
    'a report that omits runId is refused, as the route refuses it',
  );
});

test('provider and model requests validate', () => {
  const provider: ProviderRequest = {
    providerId: 'google',
    operation: 'messages.send',
    input: { userId: 'me', raw: 'x' },
    idempotencyKey: 'invoice-notify-11111111-1111',
  };
  assertValid(validator('automation-provider-request'), provider, 'provider request');

  const model: ModelRequest = {
    capability: 'document-extraction',
    prompt: 'Extract the invoice fields.',
    input: { text: '...' },
    outputSchema: { type: 'object' },
  };
  assertValid(validator('automation-model-request'), model, 'model request');
});

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

test('the answers the platform sends back are recognised in their real shapes', () => {
  assert.ok(isArtifactReference(artifactFixture()));
  assert.ok(isArtifactReference(artifactFixture({ sha256: 'abc' })));
  const listing = toArtifactListing(artifactFixture());
  assert.ok(isArtifactListing(listing));
  assert.equal(isArtifactReference(listing), false, 'a listing is not a reference');
  assert.equal(isArtifactReference({ ...artifactFixture(), sizeBytes: '3' }), false);

  assert.ok(
    isModelCompletion({
      text: '{}',
      model: 'm',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  );
  assert.equal(isModelCompletion({ text: '{}', model: 'm', finishReason: 'stop' }), false);
});

test('a mail request validates against the published schema, and the SDK bounds are its bounds', () => {
  const validate = validator('automation-mail-request');
  const mail: MailRequest = {
    to: 'vendor@example.com',
    subject: 'Invoice received',
    body: 'Thank you.',
    idempotencyKey: 'notify-0123456789abcdef',
  };
  assertValid(validate, mail, 'a mail request');
  // `runId` is optional in the handler's allow-list but not in the published
  // request, and the client never sends it.
  assert.equal(validate({ ...mail, runId: '44444444-4444-4444-8444-444444444444' }), false);
  const schema = JSON.parse(
    readFileSync(join(schemas, 'automation-mail-request.json'), 'utf8'),
  ) as { properties: Record<'subject' | 'body', { maxLength: number }> };
  assert.equal(MAIL_SUBJECT_MAX_LENGTH, schema.properties.subject.maxLength);
  assert.equal(MAIL_BODY_MAX_LENGTH, schema.properties.body.maxLength);
  assert.ok(isMailAcceptance({ mail: { accepted: true } }));
  assert.equal(isMailAcceptance({ mail: { accepted: false } }), false);
  assert.equal(isMailAcceptance({ provider: { status: 200 } }), false);
});

test('the capability list is the model-request schema’s enum, exactly', () => {
  const schema = JSON.parse(
    readFileSync(join(schemas, 'automation-model-request.json'), 'utf8'),
  ) as { properties: { capability: { enum: string[] } } };
  assert.deepEqual([...CAPABILITIES], schema.properties.capability.enum);
  assert.ok(isCapability('screening'));
  assert.equal(isCapability('mind-reading'), false);
});

test('every manifest in the repository is readable as the runner reads it', () => {
  const manifests = resolve(import.meta.dirname, '../../../manifests');
  const files = readdirSync(manifests).filter((file) => file.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const manifest = readManifest(join(manifests, file));
    assert.ok(manifest.pipeline.length > 0, `${file} declares a pipeline`);
    assert.ok(file.startsWith(`${manifest.templateId}.v${manifest.version}.json`), file);
  }
  assert.equal(
    isManifest({ templateId: 'x', version: 1, requiredCapabilities: [], pipeline: [] }),
    false,
  );
  assert.equal(
    isManifest({ templateId: 'x', version: 0, requiredCapabilities: [], pipeline: [{ id: 'a' }] }),
    false,
  );
});

test('a cut never splits a surrogate pair: the last character kept is whole', () => {
  const emoji = '\u{1F600}';
  assert.equal(truncateText(`${'x'.repeat(199)}${emoji}`, 200), 'x'.repeat(199));
  assert.equal(truncateText(`${'x'.repeat(198)}${emoji}`, 200), `${'x'.repeat(198)}${emoji}`);
  assert.equal(truncateText('short', 200), 'short');
  const line = oneLine(`${'x'.repeat(199)}${emoji} tail`, 'summary');
  assert.equal(line, 'x'.repeat(199));
  assert.doesNotMatch(line, /[\uD800-\uDBFF]$/u, 'no lone surrogate at the cut');
});
