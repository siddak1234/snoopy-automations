import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import type { ModelRequest } from '../src/contract.js';
import { isUnanswered, isUnsent, unanswered, unsent } from '../src/marks.js';
import { PlatformClient } from '../src/platform.js';
import { refusalFixture, RecordingPlatform } from '../src/testing.js';
import type { Step } from '../src/steps.js';
import { noAnswer, recordedWaits } from './retry-fixtures.js';
import { define, extract, invoke, manifest, ok } from './runner-fixtures.js';
import { type StubPlatform, startStubPlatform } from './stub-platform.js';

/**
 * One retry of a model call cut by a platform restart — the owner's decision of
 * 2026-10-10 (platform BUILD-PLAN 25.3.13): a step whose policy says `when: 'unsent'`
 * is repeated only when a callback provably never left this container — the
 * connection was refused, or the platform's name did not resolve. A model call that
 * reached the platform may have been made and billed, and repeating it makes it
 * again, so a timeout, a reset, a cut body and every answer the platform gave are
 * never repeated under it.
 */

const REQUEST: ModelRequest = {
  capability: 'document-extraction',
  prompt: 'Extract.',
  input: {},
  outputSchema: {},
};

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
  stub.delayMs = 0;
});

/** A refused connection, marked as the client marks fetch's own rejection of one. */
async function notSent(): Promise<TypeError> {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
    code: 'ECONNREFUSED',
  });
  const error = new TypeError('fetch failed', { cause });
  await unanswered(unsent(Promise.reject(error))).catch(() => undefined);
  return error;
}

/** An origin nobody listens on: a port taken, then given back. */
async function closedOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** A server that reads the whole request, then drops the connection without a word. */
async function droppingServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request) => {
    request.resume();
    request.on('end', () => request.socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test('a callback that provably never left is marked unsent; one that may have reached the platform is not', async () => {
  // Never left: the connection was refused, or the name did not resolve
  // (`.invalid` never resolves, RFC 2606).
  const refused = new PlatformClient(await closedOrigin(), 'run-token');
  await assert.rejects(refused.callModel(REQUEST), (error: unknown) => {
    assert.equal(isUnsent(error), true);
    assert.equal(isUnanswered(error), true, 'an unsent callback is an unanswered one too');
    return true;
  });
  const nowhere = new PlatformClient('http://platform.invalid', 'run-token');
  await assert.rejects(nowhere.callModel(REQUEST), (error: unknown) => isUnsent(error));

  // May have reached it: a timeout, a connection dropped after the request was read.
  stub.delayMs = 500;
  const impatient = new PlatformClient(stub.origin, 'run-token', { modelTimeoutMs: 50 });
  await assert.rejects(impatient.callModel(REQUEST), (error: unknown) => {
    assert.equal(isUnanswered(error), true);
    assert.equal(isUnsent(error), false);
    return true;
  });
  stub.delayMs = 0;
  const dropping = await droppingServer();
  try {
    const dropped = new PlatformClient(dropping.origin, 'run-token');
    await assert.rejects(dropped.callModel(REQUEST), (error: unknown) => {
      assert.equal(isUnanswered(error), true);
      assert.equal(isUnsent(error), false, 'a drop after the request was read may have been made');
      return true;
    });
  } finally {
    await dropping.close();
  }

  // Answered: a 503 is the platform's answer, not an unsent request.
  stub.answers.model = () => ({
    status: 503,
    body: { code: 'DEPENDENCY_FAILURE', detail: 'unavailable' },
  });
  const client = new PlatformClient(stub.origin, 'run-token');
  await assert.rejects(client.callModel(REQUEST), (error: unknown) => !isUnsent(error));
});

/** An automation whose first step calls the model, with the policy given. */
function extracting(when?: 'transient' | 'unsent') {
  const receive: Step = async (context) => {
    const completion = await context.platform.callModel(extract, { reference: 'INV-7' });
    return { outcome: 'ok', summary: `Extracted by ${completion.model}` };
  };
  return define({
    manifests: [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])],
    prompts: [extract],
    steps: { receive, validate: ok('v'), post: ok('p') },
    retry: {
      receive: { attempts: 2, backoffMs: 10_000, ...(when === undefined ? {} : { when }) },
    },
  });
}

/** A model that fails the first call with `failure`, then answers. */
function failingOnce(platform: RecordingPlatform, failure: unknown): void {
  const answer = platform.model;
  let calls = 0;
  platform.model = (call, model) => {
    calls += 1;
    return calls === 1 ? Promise.reject(failure) : answer(call, model);
  };
}

test("under when: 'unsent' a step is repeated only after a callback that never left", async () => {
  const automation = extracting('unsent');
  assert.deepEqual(automation.retry.receive, { attempts: 2, backoffMs: 10_000, when: 'unsent' });

  const repeated = new RecordingPlatform();
  failingOnce(repeated, await notSent());
  const result = await automation.execute(invoke(), repeated);
  assert.equal(result.outcome, 'success');
  assert.equal(repeated.modelCalls.length, 2, 'the call that never left was made once more');
  assert.deepEqual(waited, [10_000]);
  assert.equal(repeated.steps[0]?.summary, 'Extracted by test-model (after 2 attempts)');

  // Never repeated: a callback that may have reached the platform, and every answer.
  for (const failure of [
    await noAnswer('The operation was aborted due to timeout'),
    refusalFixture('model', { status: 503, code: 'DEPENDENCY_FAILURE', detail: 'unavailable' }),
    refusalFixture('model', { status: 502, code: 'DEPENDENCY_FAILURE', detail: 'unreachable' }),
  ]) {
    waited.length = 0;
    const once = new RecordingPlatform();
    failingOnce(once, failure);
    await assert.rejects(automation.execute(invoke(), once));
    assert.equal(once.modelCalls.length, 1, 'made once, never again');
    assert.deepEqual(waited, []);
  }
});

test('the default policy is unchanged: a transient failure is repeated, an unsent one among them', async () => {
  for (const failure of [
    await notSent(),
    await noAnswer(),
    refusalFixture('model', { status: 503, code: 'DEPENDENCY_FAILURE', detail: 'unavailable' }),
  ]) {
    const platform = new RecordingPlatform();
    failingOnce(platform, failure);
    const result = await extracting().execute(invoke(), platform);
    assert.equal(result.outcome, 'success');
    assert.equal(platform.modelCalls.length, 2);
  }
});

test('a policy that names any other test is refused at definition', () => {
  assert.throws(
    () =>
      define({
        retry: { post: { attempts: 2, backoffMs: 10_000, when: 'always' as never } },
      }),
    /the retry policy for step "post" must repeat on 'transient' or 'unsent' failures/u,
  );
});
