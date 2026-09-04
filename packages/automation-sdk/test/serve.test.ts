import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';

import type { InvokeRequest, RunResult } from '../src/contract.js';
import type { AutomationPlatform } from '../src/platform.js';
import { type Logger, type RunningAutomation, type ServeOptions, serve } from '../src/serve.js';
import { invokeFixture } from '../src/testing.js';
import { type StubPlatform, startStubPlatform, waitFor } from './stub-platform.js';

/**
 * The shell as the platform sees it: two routes, strict acknowledgements, work
 * that happens after the answer, backpressure that is a real number, and logs
 * that never carry the document.
 */

const TEMPLATE = 'under-test';
const RUN_ID = invokeFixture().runId;
let stub: StubPlatform;
const logs: { level: string; message: string; fields: Record<string, unknown> }[] = [];
const log: Logger = (level, message, fields = {}) => {
  logs.push({ level, message, fields });
};

type Execute = (request: InvokeRequest, platform: AutomationPlatform) => Promise<RunResult>;
const SUCCEED: Execute = () => Promise.resolve({ outcome: 'success' });
let execute: Execute = SUCCEED;
/** Hands the test a handle on a run that finishes only when told to. */
function controllable(): (result: RunResult) => void {
  let finish: (result: RunResult) => void = () => {};
  execute = () => new Promise<RunResult>((resolve) => (finish = resolve));
  return (result) => finish(result);
}
const running: RunningAutomation[] = [];

async function start(overrides: Partial<ServeOptions> = {}): Promise<RunningAutomation> {
  const automation = await serve({
    templateId: TEMPLATE,
    execute: (request, platform) => execute(request, platform),
    port: 0,
    handleSignals: false,
    log,
    ...overrides,
  });
  running.push(automation);
  return automation;
}

function invoke(automation: RunningAutomation, overrides: Partial<InvokeRequest> = {}) {
  return fetch(`http://127.0.0.1:${automation.port}/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      invokeFixture({ templateId: TEMPLATE, callbackOrigin: stub.origin, ...overrides }),
    ),
  });
}

before(async () => {
  stub = await startStubPlatform();
});
beforeEach(() => {
  execute = SUCCEED;
  stub.calls = [];
  stub.answers = {};
  logs.length = 0;
});
after(async () => {
  await Promise.all(running.map((automation) => automation.close()));
  await stub.close();
});

test('the liveness probe answers what the catalog reads, and nothing else is served', async () => {
  const automation = await start();
  const live = await fetch(`http://127.0.0.1:${automation.port}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: 'ok', templateId: TEMPLATE, contractVersion: 1 });
  const other = await fetch(`http://127.0.0.1:${automation.port}/anything`);
  assert.equal(other.status, 404);
});

test('an invoke that is not one is refused with 400, a huge one with 413', async () => {
  const automation = await start({ bodyLimitBytes: 512 });
  const url = `http://127.0.0.1:${automation.port}/v1/invoke`;
  const json = { 'content-type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers: json, body: 'not json' })).status, 400);
  assert.equal(
    (await fetch(url, { method: 'POST', headers: json, body: '{"runId":1}' })).status,
    400,
  );
  const badContinuation = await invoke(automation, {
    continuation: { ofRunId: 'x', kind: 'approval' } as never,
  });
  assert.equal(badContinuation.status, 400);
  const huge = await fetch(url, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ ...invokeFixture(), input: { pad: 'x'.repeat(2048) } }),
  });
  assert.equal(huge.status, 413);
});

test('another template is refused as unknown, with a 200 the platform can read', async () => {
  const automation = await start();
  const response = await invoke(automation, { templateId: 'someone-else' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    accepted: false,
    runId: RUN_ID,
    reason: 'unknown-template',
  });
});

test('the acknowledgement precedes the work, and the result reaches the platform with the token', async () => {
  const automation = await start();
  const finish = controllable();

  const response = await invoke(automation, { runToken: 'token-for-r1' });
  assert.deepEqual(await response.json(), { accepted: true, runId: RUN_ID });
  assert.equal(automation.inFlight(), 1, 'the run is in flight after the ack');
  assert.equal(stub.calls.length, 0, 'nothing reported yet');

  finish({ outcome: 'success', summary: 'Done' });
  await waitFor(() => stub.calls.length === 1);
  const call = stub.calls[0]!;
  assert.equal(call.path, '/v1/automations/callbacks/result');
  assert.equal(call.headers.authorization, 'Bearer token-for-r1');
  assert.deepEqual(call.body, { runId: RUN_ID, outcome: 'success', summary: 'Done' });
  await waitFor(() => automation.inFlight() === 0);
});

test('above capacity is refused with a retry hint, and counted before the ack is written', async () => {
  const automation = await start({ maxConcurrentRuns: 1 });
  const finish = controllable();
  const first = await invoke(automation, { runId: 'aaaaaaaa-0000-4000-8000-000000000001' });
  assert.equal(((await first.json()) as { accepted: boolean }).accepted, true);
  const second = await invoke(automation, { runId: 'aaaaaaaa-0000-4000-8000-000000000002' });
  assert.deepEqual(await second.json(), {
    accepted: false,
    runId: 'aaaaaaaa-0000-4000-8000-000000000002',
    reason: 'at-capacity',
    retryAfterSeconds: 10,
  });
  finish({ outcome: 'success' });
  await waitFor(() => automation.inFlight() === 0);
});

test('a blank or misspelt capacity or port in the environment stops the container', async () => {
  for (const [name, value] of [
    ['MAX_CONCURRENT_RUNS', ''],
    ['MAX_CONCURRENT_RUNS', '4O'],
    ['MAX_CONCURRENT_RUNS', '0'],
    ['PORT', ''],
    ['PORT', 'http'],
  ] as const) {
    const previous = process.env[name];
    process.env[name] = value;
    // `port` is passed only when the case is about capacity: an explicit option
    // wins over the environment, so passing it here would mean the PORT cases
    // never reached the parser under test.
    const options = {
      templateId: TEMPLATE,
      execute: SUCCEED,
      handleSignals: false,
      log,
      ...(name === 'PORT' ? {} : { port: 0 }),
    };
    let started: RunningAutomation | undefined;
    try {
      await assert.rejects(
        serve(options).then((automation) => {
          // Closed rather than leaked: a server left listening outside `running`
          // keeps the test runner alive forever, which turns one failed
          // assertion into a hung suite.
          started = automation;
          return automation;
        }),
        new RegExp(`${name} must be an integer`, 'u'),
        `${name}=${JSON.stringify(value)} was accepted`,
      );
    } finally {
      await started?.close();
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

test('a throwing automation is reported as failed with its reason, bounded and never empty', async () => {
  const automation = await start();
  execute = () => Promise.reject(new Error('x'.repeat(500)));
  await invoke(automation);
  await waitFor(() => stub.calls.length === 1);
  const body = stub.calls[0]!.body as { outcome: string; failureReason: string };
  assert.equal(body.outcome, 'failed');
  assert.equal(body.failureReason.length, 200);

  stub.calls = [];
  execute = () => Promise.reject(new Error('   '));
  await invoke(automation, { runId: 'aaaaaaaa-0000-4000-8000-000000000004' });
  await waitFor(() => stub.calls.length === 1);
  assert.equal((stub.calls[0]!.body as { failureReason: string }).failureReason, 'unknown error');
});

test('a platform that refuses the result is logged once, not re-reported as a failure', async () => {
  const automation = await start();
  stub.answers.result = () => ({ status: 409, body: { error: { code: 'CONFLICT' } } });
  await invoke(automation);
  await waitFor(() => logs.some((line) => line.message === 'result_unreportable'));
  await waitFor(() => automation.inFlight() === 0);
  assert.equal(stub.calls.length, 1, 'the refused success was not re-sent as a failure');
  assert.equal(
    logs.find((line) => line.message === 'result_unreportable')?.fields.outcome,
    'success',
  );
});

test('draining refuses new runs, fails the probe, and close waits for accepted ones to report', async () => {
  const automation = await start();
  const finish = controllable();
  await invoke(automation);
  automation.drain();
  const refused = await invoke(automation, { runId: 'aaaaaaaa-0000-4000-8000-000000000003' });
  assert.equal(((await refused.json()) as { reason: string }).reason, 'draining');
  const live = await fetch(`http://127.0.0.1:${automation.port}/health/live`);
  assert.equal(live.status, 503, 'a draining container must not be reported available');

  stub.calls = [];
  let closed = false;
  const closing = automation.close().then(() => (closed = true));
  await sleep(50);
  assert.equal(closed, false, 'close waits for the in-flight run');
  finish({ outcome: 'success' });
  await closing;
  assert.equal(stub.calls.length, 1, 'the accepted run still reported');
});

test('the log never carries the payload or the token', async () => {
  const automation = await start();
  const marker = 'ACCOUNT-9911-ROUTING-2200';
  await invoke(automation, { input: { note: marker }, runToken: 'token-secret-value' });
  await waitFor(() => logs.some((line) => line.message === 'run_finished'));
  const everything = JSON.stringify(logs);
  assert.ok(!everything.includes(marker), 'the document leaked into a log line');
  assert.ok(!everything.includes('token-secret-value'), 'the token leaked into a log line');
});
