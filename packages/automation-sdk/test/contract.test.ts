import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

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
import { artifactFixture, invokeFixture } from '../src/testing.js';
import { assertValid, schemas, validator } from './published-schemas.js';

/**
 * The SDK's shapes against the platform's PUBLISHED schemas, vendored at
 * `contract/schemas`. What the SDK sends must validate; what the SDK reads must be
 * accepted by its guards in the shape the platform actually answers. The model-id and
 * file-id rules are held to the model request's schema in `contract-model-request.test.ts`.
 */

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

test('a manifest may declare the files its runs accept, in the published block', () => {
  // The platform's BUILD-PLAN 25.2.21: until it, the schema had no `artifacts` and closed
  // the manifest, so a manifest declaring the block its validator has always read
  // failed this copy. The verdicts are its validator's (snoopy-backend
  // `test/wire-schema.test.ts` at `4875579`), copied as data.
  const validate = validator('automation-manifest');
  const reference = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../manifests/invoice-check.v1.json'), 'utf8'),
  ) as Record<string, unknown>;
  const withArtifacts = (artifacts: unknown) => ({ ...reference, artifacts });
  assertValid(validate, reference, 'the reference manifest alone');
  const declared = withArtifacts({
    acceptedContentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    maximumSizeBytes: 3_500_000,
  });
  assertValid(validate, declared, 'a manifest declaring its files');
  assert.ok(isManifest(declared), 'and the runner reads it');

  const mediaTypes: [string, boolean][] = [
    ['application/pdf', true],
    ['image/jpeg', true],
    ['image/png', true],
    ['image/*', true],
    ['Application/PDF', true],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true],
    ['text/plain+x', true],
    ['pdf', false],
    ['image/', false],
    ['/png', false],
    ['*/*', false],
    ['image/**', false],
    ['image/png; charset=binary', false],
    ['image/png ', false],
    ['image\\png', false],
    ['imäge/png', false],
    ['image/pnǵ', false],
  ];
  for (const [mediaType, expected] of mediaTypes) {
    const verdict = validate(
      withArtifacts({ acceptedContentTypes: [mediaType], maximumSizeBytes: 1024 }),
    );
    assert.equal(verdict, expected, mediaType);
  }
  for (const [size, expected] of [
    [0, false],
    [1, true],
    [104_857_600, true],
    [104_857_601, false],
    [1.5, false],
  ] as const) {
    const verdict = validate(
      withArtifacts({ acceptedContentTypes: ['application/pdf'], maximumSizeBytes: size }),
    );
    assert.equal(verdict, expected, `${size} bytes`);
  }
  for (const artifacts of [
    { acceptedContentTypes: [], maximumSizeBytes: 1024 },
    { acceptedContentTypes: ['application/pdf'] },
    { maximumSizeBytes: 1024 },
    { acceptedContentTypes: ['application/pdf'], maximumSizeBytes: 1024, maximumPages: 10 },
  ]) {
    assert.equal(validate(withArtifacts(artifacts)), false, JSON.stringify(artifacts));
  }
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
