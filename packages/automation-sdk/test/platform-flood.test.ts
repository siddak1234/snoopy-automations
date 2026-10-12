import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import type { JsonObject } from '../src/contract.js';
import { FLOOD_WAIT_MAX_MS, floodClock, floodWaitMs, isFloodRefusal } from '../src/flood.js';
import { PlatformClient } from '../src/platform.js';
import { CallbackRefusedError } from '../src/refusals.js';
import { type Logger, serve } from '../src/serve.js';
import { invokeFixture, problemFixture, refusalFixture } from '../src/testing.js';
import {
  type Answer,
  type StubPlatform,
  defaultAnswer,
  startStubPlatform,
  waitFor,
} from './stub-platform.js';

/**
 * The Edge's flood valve, waited out (the owner's "Wait and retry" of 2026-10-12): every
 * callback it turns away — 429 `TOO_MANY_REQUESTS`, no reason — is sent again, the same bytes,
 * once its window turns, while the deadline allows; any other refusal is thrown as before. Each
 * wait is recorded here, not slept.
 */

const TOKEN = 'run-token-under-test';
let stub: StubPlatform;
const waits: number[] = [];

before(async () => {
  stub = await startStubPlatform();
});
after(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.calls = [];
  stub.answers = {};
  waits.length = 0;
  floodClock.now = () => Date.now();
  floodClock.sleep = (milliseconds) => {
    waits.push(milliseconds);
    return Promise.resolve();
  };
});

/** The Edge's refusal, in the bytes its `createProblem` writes, with the header it sets. */
function flood(retryAfter?: string): Answer {
  return {
    status: 429,
    body: problemFixture({
      status: 429,
      code: 'TOO_MANY_REQUESTS',
      detail: 'Too many requests. Retry after the interval in the retry-after header.',
    }),
    ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }),
  };
}

/** `message` refused by the flood valve `times` times, then answered as the handler answers it. */
function floodedFirst(message: string, times = 1, retryAfter = '7') {
  let refused = 0;
  return (body: Record<string, unknown>): Answer =>
    refused++ < times ? flood(retryAfter) : defaultAnswer(message, body);
}

const deadlineIn = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
/** A client held to `deadline`, 15 minutes away unless given; `null` for none at all. */
const client = (deadline: string | null = deadlineIn(900_000)) =>
  new PlatformClient(stub.origin, TOKEN, {
    timeoutMs: 1000,
    modelTimeoutMs: 1000,
    ...(deadline === null ? {} : { deadline }),
  });

const sentTo = (message: string) =>
  stub.calls.filter((call) => call.path === `/v1/automations/callbacks/${message}`);

test('every callback the flood valve turns away is sent again, the same bytes, once its window turns', async () => {
  const platform = client();
  const callbacks: [string, () => Promise<unknown>][] = [
    [
      'step',
      () =>
        platform.reportStep({ runId: 'r1', stepId: 'receive', outcome: 'ok', summary: 'Got it' }),
    ],
    ['result', () => platform.reportResult('r1', { outcome: 'success', summary: 'Done' })],
    [
      'model',
      () =>
        platform.callModel({
          capability: 'document-extraction',
          prompt: 'Extract.',
          input: { text: 'INV-1' },
          outputSchema: { type: 'object' },
        }),
    ],
    [
      'provider',
      () =>
        platform.callProvider({
          providerId: 'quickbooks',
          operation: 'query.run',
          input: { query: 'SELECT * FROM Vendor' },
          idempotencyKey: 'find-vendor-0123456789abcdef',
        }),
    ],
    [
      'mail',
      () =>
        platform.sendMail({
          to: 'books@example.com',
          subject: 'Recorded',
          body: 'Bill 1001 was recorded.',
          idempotencyKey: 'notify-0123456789abcdef',
        }),
    ],
    ['artifact', () => platform.readArtifact('a9')],
    ['artifact', () => platform.listArtifacts()],
  ];
  for (const [message, send] of callbacks) {
    stub.calls = [];
    waits.length = 0;
    stub.answers[message] = floodedFirst(message);
    await send();
    const sent = sentTo(message);
    assert.equal(sent.length, 2, `${message}: refused once, then sent again`);
    assert.deepEqual(sent[1]?.body, sent[0]?.body, `${message}: the same body`);
    assert.equal(sent[1]?.headers.authorization, `Bearer ${TOKEN}`, message);
    assert.deepEqual(waits, [7_000], `${message}: one wait, as retry-after says`);
  }
});

test('a step report waits as long as each refusal says, and as often as the time allows', async () => {
  stub.answers.step = floodedFirst('step', 3, '60');
  await client().reportStep({
    runId: 'r1',
    stepId: 'read-company',
    outcome: 'ok',
    summary: 'Read',
  });
  assert.equal(sentTo('step').length, 4);
  assert.deepEqual(waits, [60_000, 60_000, 60_000]);
});

test('a result the flood valve turns away is reported once its window turns: the run is not left unreportable', async () => {
  const logs: Parameters<Logger>[] = [];
  const automation = await serve({
    templateId: 'under-test',
    execute: () => Promise.resolve({ outcome: 'success', summary: 'Done' }),
    port: 0,
    handleSignals: false,
    log: (...line) => logs.push(line),
  });
  try {
    stub.answers.result = floodedFirst('result', 1, '3');
    const request = invokeFixture({ templateId: 'under-test', callbackOrigin: stub.origin });
    await fetch(`http://127.0.0.1:${automation.port}/v1/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    await waitFor(() => logs.some(([, message]) => message === 'run_finished'));
    const results = sentTo('result');
    assert.equal(results.length, 2);
    assert.deepEqual(results[1]?.body, {
      runId: request.runId,
      outcome: 'success',
      summary: 'Done',
    });
    assert.deepEqual(waits, [3_000], "the invoke's deadline let the client wait");
    assert.ok(!logs.some(([, message]) => message === 'result_unreportable'));
  } finally {
    await automation.close();
  }
});

test('a 429 that names a reason, or any other refusal, is thrown at once and never waited for', async () => {
  const refusals: [string, string, Answer][] = [
    [
      "the mail allowance's 429",
      'mail',
      {
        status: 429,
        body: problemFixture({
          status: 429,
          code: 'TOO_MANY_REQUESTS',
          detail: 'The outbound mail allowance for this run or workspace is spent',
          details: { reason: 'per_run_cap' },
        }),
        headers: { 'retry-after': '5' },
      },
    ],
    [
      "a workspace quota's 429",
      'step',
      {
        status: 429,
        body: problemFixture({
          status: 429,
          code: 'TOO_MANY_REQUESTS',
          detail: 'This workspace has reached its plan’s request limit.',
          details: { reason: 'over_workspace_quota' },
        }),
        headers: { 'retry-after': '5' },
      },
    ],
    ['a 429 page that is no problem', 'step', { status: 429, headers: { 'retry-after': '5' } }],
    [
      'a 429 with another code',
      'step',
      {
        status: 429,
        body: problemFixture({ status: 429, code: 'CONFLICT', detail: 'x' }),
        headers: { 'retry-after': '5' },
      },
    ],
    [
      'a 503 with retry-after',
      'step',
      {
        status: 503,
        body: problemFixture({ status: 503, code: 'DEPENDENCY_FAILURE', detail: 'x' }),
        headers: { 'retry-after': '5' },
      },
    ],
  ];
  const platform = client();
  for (const [label, message, answer] of refusals) {
    stub.calls = [];
    stub.answers[message] = () => answer;
    const send =
      message === 'mail'
        ? platform.sendMail({
            to: 'v@example.com',
            subject: 's',
            body: 'b',
            idempotencyKey: 'k'.repeat(16),
          })
        : platform.reportStep({ runId: 'r1', stepId: 'receive', outcome: 'ok', summary: 's' });
    await assert.rejects(
      send,
      (error: unknown) => error instanceof CallbackRefusedError && error.status === answer.status,
      label,
    );
    assert.equal(sentTo(message).length, 1, `${label}: sent once`);
  }
  assert.deepEqual(waits, [], 'no wait for any of them');
});

test('no wait that would not end before the deadline: the refusal is thrown as before', async () => {
  const report = { runId: 'r1', stepId: 'receive', outcome: 'ok' as const, summary: 's' };
  const refused = (error: unknown) =>
    error instanceof CallbackRefusedError && error.status === 429 && isFloodRefusal(error);
  const cases: [string, string | null, string][] = [
    ['a minute to wait, half a minute left', deadlineIn(30_000), '60'],
    ['the window, unread, with 59 seconds left', deadlineIn(59_000), 'soon'],
    ['a client given no deadline', null, '1'],
    ['a deadline that does not parse', 'tomorrow', '1'],
  ];
  for (const [label, deadline, retryAfter] of cases) {
    stub.calls = [];
    stub.answers.step = () => flood(retryAfter);
    await assert.rejects(client(deadline).reportStep(report), refused, label);
    assert.equal(sentTo('step').length, 1, label);
  }
  assert.equal(waits.length, 0, 'no wait for any of them');

  // Time passes as each wait is slept: 60 s twice, then a third would end past the deadline.
  let now = Date.now();
  const deadline = new Date(now + 150_000).toISOString();
  floodClock.now = () => now;
  floodClock.sleep = (milliseconds) => {
    waits.push(milliseconds);
    now += milliseconds;
    return Promise.resolve();
  };
  stub.calls = [];
  stub.answers.step = () => flood('60');
  await assert.rejects(client(deadline).reportStep(report), refused);
  assert.equal(sentTo('step').length, 3);
  assert.deepEqual(waits, [60_000, 60_000]);
});

test('the wait: retry-after in whole seconds, else the whole window; never above a minute nor below a second', () => {
  const cases: [string | null, number][] = [
    ['7', 7_000],
    [' 12 ', 12_000],
    ['60', 60_000],
    ['600', FLOOD_WAIT_MAX_MS],
    ['0', 1_000],
    [null, FLOOD_WAIT_MAX_MS],
    ['', FLOOD_WAIT_MAX_MS],
    ['soon', FLOOD_WAIT_MAX_MS],
    ['1.5', FLOOD_WAIT_MAX_MS],
    ['-3', FLOOD_WAIT_MAX_MS],
    ['Mon, 12 Oct 2026 10:00:00 GMT', FLOOD_WAIT_MAX_MS],
  ];
  for (const [header, wait] of cases) assert.equal(floodWaitMs(header), wait, String(header));
});

test('the flood valve is a 429 TOO_MANY_REQUESTS that names no reason, and nothing else', () => {
  const problem = (details?: JsonObject) => ({
    status: 429,
    code: 'TOO_MANY_REQUESTS',
    detail: 'Too many requests.',
    ...(details ? { details } : {}),
  });
  assert.equal(isFloodRefusal(refusalFixture('step', problem())), true);
  assert.equal(isFloodRefusal(refusalFixture('model', problem())), true);
  assert.equal(isFloodRefusal(refusalFixture('mail', problem({ reason: 'per_run_cap' }))), false);
  assert.equal(
    isFloodRefusal(refusalFixture('step', { status: 429, code: 'BAD_REQUEST', detail: 'x' })),
    false,
  );
  assert.equal(isFloodRefusal(new CallbackRefusedError('step', 429, '')), false);
  assert.equal(isFloodRefusal(refusalFixture('step', { ...problem(), status: 503 })), false);
  assert.equal(isFloodRefusal(new Error('Too many requests')), false);
});
