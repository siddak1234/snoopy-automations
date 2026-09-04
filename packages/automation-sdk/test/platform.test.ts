import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { CallbackRefusedError, PlatformClient } from '../src/platform.js';
import { artifactFixture } from '../src/testing.js';
import { type StubPlatform, startStubPlatform } from './stub-platform.js';

/**
 * The client on the wire.
 *
 * Every assertion here is about what left the process: the path, the one header
 * that carries a credential, the body the platform's handler will allowlist, and
 * how each answer shape is read back.
 */

const TOKEN = 'run-token-under-test';
let stub: StubPlatform;
let client: PlatformClient;

before(async () => {
  stub = await startStubPlatform();
});
after(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.calls = [];
  stub.answers = {};
  stub.delayMs = 0;
  stub.objectRequests = [];
  client = new PlatformClient(stub.origin, TOKEN, { timeoutMs: 1000, modelTimeoutMs: 1000 });
});

function last(): { path: string; headers: Record<string, unknown>; body: unknown } {
  const call = stub.calls.at(-1);
  assert.ok(call, 'a callback was sent');
  return { path: call.path, headers: call.headers as Record<string, unknown>, body: call.body };
}

test('a step report carries the bearer run token, the run id, and nothing else credential-shaped', async () => {
  await client.reportStep({ runId: 'r1', stepId: 'receive', outcome: 'ok', summary: 'Got it' });
  const { path, headers, body } = last();
  assert.equal(path, '/v1/automations/callbacks/step');
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.cookie, undefined);
  // The token appears in exactly one header.
  const carrying = Object.entries(headers).filter(([, v]) => String(v).includes(TOKEN));
  assert.deepEqual(
    carrying.map(([k]) => k),
    ['authorization'],
  );
  assert.deepEqual(body, { runId: 'r1', stepId: 'receive', outcome: 'ok', summary: 'Got it' });
});

test('a result is sent as the outcome with the run id alongside, one-liners bounded', async () => {
  await client.reportResult('r1', { outcome: 'success', output: { n: 1 }, summary: 'Done' });
  assert.deepEqual(last().body, {
    runId: 'r1',
    outcome: 'success',
    output: { n: 1 },
    summary: 'Done',
  });

  // A sentence past the bound is cut, not refused: the platform would answer 400
  // and a finished run — side effects included — would end as a deadline failure.
  await client.reportResult('r1', { outcome: 'success', summary: `${'x'.repeat(250)} end` });
  assert.equal((last().body as { summary: string }).summary.length, 200);
  await assert.rejects(
    client.reportResult('r1', { outcome: 'failed', failureReason: '   ' }),
    /failureReason must be a non-empty line/u,
  );
  await client.reportResult('r1', {
    outcome: 'held',
    held: { stepId: 'validate', reason: 'why', state: { s: 1 } },
  });
  assert.equal(last().path, '/v1/automations/callbacks/result');
});

test('a model call sends exactly the four fields the handler allowlists and reads the completion', async () => {
  const completion = await client.callModel({
    capability: 'document-extraction',
    prompt: 'Extract.',
    input: { text: 'INV-1' },
    outputSchema: { type: 'object' },
  });
  const { path, body } = last();
  assert.equal(path, '/v1/automations/callbacks/model');
  assert.deepEqual(Object.keys(body as object).sort(), [
    'capability',
    'input',
    'outputSchema',
    'prompt',
  ]);
  assert.equal(completion.text, '{"vendor":"Contoso"}');
  assert.equal(completion.finishReason, 'stop');
  assert.equal(completion.usage.totalTokens, 19);
});

test('a malformed model answer is an error, not an empty completion', async () => {
  stub.answers.model = () => ({ status: 200, body: { model: { text: 'x' } } });
  await assert.rejects(
    client.callModel({ capability: 'summarization', prompt: 'p', input: {}, outputSchema: {} }),
    /did not answer with a completion/u,
  );
});

test("a provider call returns the provider's own status rather than throwing on it", async () => {
  stub.answers.provider = () => ({
    status: 200,
    body: { provider: { status: 429, body: { error: 'rate limited' } } },
  });
  const answer = await client.callProvider({
    providerId: 'google',
    operation: 'messages.send',
    input: { userId: 'me' },
    idempotencyKey: 'sixteen-characters-key',
  });
  assert.equal(answer.status, 429);
  assert.deepEqual(answer.body, { error: 'rate limited' });
  assert.equal(last().path, '/v1/automations/callbacks/provider');
  assert.deepEqual(Object.keys(last().body as object).sort(), [
    'idempotencyKey',
    'input',
    'operation',
    'providerId',
  ]);
});

test('an artifact is read by id and listed with none', async () => {
  const artifact = await client.readArtifact('a9');
  assert.deepEqual(last().body, { artifactId: 'a9' });
  assert.equal(artifact.artifactId, 'a9');
  assert.match(artifact.downloadUrl, /^http/u);

  const listing = await client.listArtifacts();
  assert.deepEqual(last().body, {});
  assert.equal(listing.length, 1);
  assert.equal(listing[0]?.artifactId, 'a1');
  assert.ok(!('downloadUrl' in (listing[0] ?? {})), 'a listing carries no link');
});

test('a refused callback surfaces the status and the platform detail', async () => {
  stub.answers.step = () => ({
    status: 422,
    body: { error: { code: 'BAD_REQUEST', details: { reason: 'step_not_declared' } } },
  });
  await assert.rejects(
    client.reportStep({ runId: 'r', stepId: 'nope', outcome: 'ok', summary: 's' }),
    (error: unknown) =>
      error instanceof CallbackRefusedError &&
      error.status === 422 &&
      error.callback === 'step' &&
      error.detail.includes('step_not_declared'),
  );
});

test('the bytes are fetched from the link with no credential at all', async () => {
  const bytes = new TextEncoder().encode('THE INVOICE');
  stub.objects.set('doc-1', bytes);
  const artifact = artifactFixture({
    artifactId: 'doc-1',
    downloadUrl: `${stub.origin}/objects/doc-1?signature=fixture`,
  });
  const read = await client.readArtifactBytes(artifact);
  assert.equal(new TextDecoder().decode(read), 'THE INVOICE');
  const presented = stub.objectRequests.at(-1) ?? {};
  assert.equal(presented.authorization, undefined, 'the run token never reaches the store');
  assert.equal(presented.cookie, undefined);

  const dead = artifactFixture({ artifactId: 'gone', downloadUrl: `${stub.origin}/objects/gone` });
  await assert.rejects(client.readArtifactBytes(dead), /refused the link with 403/u);
});

test('a callback that never answers times out instead of hanging the run', async () => {
  stub.delayMs = 500;
  const impatient = new PlatformClient(stub.origin, TOKEN, { timeoutMs: 50 });
  await assert.rejects(
    impatient.reportStep({ runId: 'r', stepId: 'receive', outcome: 'ok', summary: 's' }),
    (error: unknown) => error instanceof Error && error.name === 'TimeoutError',
  );
});
