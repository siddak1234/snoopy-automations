import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  isArtifactListing,
  isArtifactReference,
  isContinuation,
  isInvokeRequest,
  isModelCompletion,
  oneLine,
  toArtifactListing,
  type InvokeAck,
  type ModelRequest,
  type ProviderRequest,
  type RunResult,
  type StepReport,
} from '../src/contract.js';
import { artifactFixture, invokeFixture } from '../src/testing.js';

/**
 * The SDK's shapes against the platform's PUBLISHED schemas, vendored at
 * `contract/schemas`. What the SDK sends must validate; what the SDK reads must be
 * accepted by its guards in the shape the platform actually answers.
 */

const schemas = resolve(import.meta.dirname, '../../../contract/schemas');
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);

function validator(name: string): ValidateFunction {
  return ajv.compile(JSON.parse(readFileSync(join(schemas, `${name}.json`), 'utf8')) as object);
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

test('every result variant validates, and the published schema refuses the runId the client adds', () => {
  const validate = validator('automation-run-result');
  const results: RunResult[] = [
    { outcome: 'success' },
    { outcome: 'success', output: { reference: 'INV-1' }, summary: 'Recorded INV-1' },
    { outcome: 'held', held: { stepId: 'validate', reason: 'Above threshold', state: { n: 1 } } },
    { outcome: 'failed', failureReason: 'input must carry an invoice' },
    { outcome: 'failed', failureReason: 'transient', retryState: { attempt: 2 } },
  ];
  for (const result of results) assertValid(validate, result, result.outcome);
  // The client sends `{ runId, ...result }`, as the template did. The platform's
  // result handler tolerates it (it is the one callback without an allowlist);
  // the published schema does not. Same disagreement as the step report below,
  // filed with the platform; this test flips when it is resolved.
  assert.equal(validate({ runId: 'r', ...results[0] }), false);
});

test('a one-line field is trimmed and cut at the bound, and refused when empty', () => {
  assert.equal(oneLine('  Recorded INV-1  ', 'summary'), 'Recorded INV-1');
  assert.equal(oneLine('x'.repeat(300), 'summary').length, 200);
  assert.throws(() => oneLine('   ', 'summary'), /summary must be a non-empty line/u);
});

test('a step report validates without runId, and the published schema refuses it WITH one', () => {
  // The platform's step handler REQUIRES `runId` in the body and refuses a report
  // without it; the published schema has `additionalProperties: false` and no
  // `runId`. The SDK follows the handler, because that is what answers. The
  // disagreement is filed with the platform; this test flips when it is resolved.
  const validate = validator('automation-step-report');
  const report: StepReport = {
    runId: 'r',
    stepId: 'receive',
    outcome: 'held',
    summary: 'Above the threshold',
    heldReason: 'Someone should approve this',
  };
  const { runId: _runId, ...wire } = report;
  assertValid(validate, wire, 'the report without runId');
  assert.equal(validate(report), false, 'the schema still refuses runId');
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
