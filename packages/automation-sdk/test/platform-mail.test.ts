import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { PlatformClient } from '../src/platform.js';
import { CallbackRefusedError } from '../src/refusals.js';
import { problemFixture } from '../src/testing.js';
import { type StubPlatform, startStubPlatform } from './stub-platform.js';

/**
 * The client's mail on the wire (`platform.test.ts`'s, in its own file for the line ceiling):
 * exactly the four fields the handler allow-lists leave the process, with the run token, and the
 * acceptance is read back. A run's results are the platform's to mail (AM3): never sent from here.
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

test('a mail sends exactly the four fields the handler allowlists, with the token, and reads the acceptance', async () => {
  await client.sendMail({
    to: 'vendor@example.com',
    subject: 'Invoice INV-1 received',
    body: 'We received it.',
    idempotencyKey: 'notify-0123456789abcdef',
    // A field the handler would refuse must not travel even if a caller adds one.
    ...({ from: 'me@customer.example' } as object),
  });
  const { path, headers, body } = last();
  assert.equal(path, '/v1/automations/callbacks/mail');
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(body, {
    to: 'vendor@example.com',
    subject: 'Invoice INV-1 received',
    body: 'We received it.',
    idempotencyKey: 'notify-0123456789abcdef',
  });

  stub.answers.mail = () => ({ status: 200, body: { mail: { queued: true } } });
  await assert.rejects(
    client.sendMail({
      to: 'v@example.com',
      subject: 's',
      body: 'b',
      idempotencyKey: 'k'.repeat(16),
    }),
    /did not answer with an acceptance/u,
  );

  stub.answers.mail = () => ({
    status: 403,
    body: problemFixture({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'The recipient is an address inside the requesting workspace',
      details: { reason: 'recipient_inside_workspace' },
    }),
  });
  await assert.rejects(
    client.sendMail({
      to: 'v@example.com',
      subject: 's',
      body: 'b',
      idempotencyKey: 'k'.repeat(16),
    }),
    (error: unknown) =>
      error instanceof CallbackRefusedError &&
      error.callback === 'mail' &&
      error.status === 403 &&
      error.reason === 'recipient_inside_workspace',
  );
});
