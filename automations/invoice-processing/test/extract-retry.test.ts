import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isUnanswered, isUnsent } from '@autom8x/automation-sdk';
import { refusalFixture, type RecordingPlatform } from '@autom8x/automation-sdk/testing';

import { RUN_FAILS } from '../src/words.js';
import { everythingSaid, isSecondRead, lines, reads, setUp } from './fixtures.js';
import { droppedConnection, proxyPage, refusedConnection, timedOut } from './wire.js';

/**
 * The model call's one retry, on a real wire: `extract` declares `{ attempts: 2, backoffMs:
 * 10_000, when: 'unsent' }`, so the step is repeated once, after the SDK's 10-second floor in
 * real time, only when the call provably never reached the platform — a connection refused,
 * or a 503 naming no code (D8) — and never after an answer that may have been made and billed.
 * Each failure comes from the SDK's own client on a local socket, so its marks are the SDK's.
 */

/**
 * The model fails the first read's first `failures.length` calls with each failure in turn, then
 * reads the document; the second read is answered.
 */
function failing(platform: RecordingPlatform, failures: readonly unknown[]): void {
  let calls = 0;
  platform.model = (call, model) => {
    if (isSecondRead(call)) return reads()(call, model);
    const failure = failures[calls];
    calls += 1;
    return failure === undefined ? reads()(call, model) : Promise.reject(failure);
  };
}

function extractLine(world: ReturnType<typeof setUp>) {
  return lines(world.platform).find(([stepId]) => stepId === 'extract');
}

test('repeated once, 10 s later, when nothing reached the platform: a refused connection, a page in front of it; twice is the end', async () => {
  const [refused, page, refusedAgain, refusedTwice, refusedFirst, pageLast] = await Promise.all([
    refusedConnection(),
    proxyPage(503),
    refusedConnection(),
    refusedConnection(),
    refusedConnection(),
    proxyPage(503),
  ]);
  assert.ok(isUnsent(refused) && isUnanswered(refused), 'the SDK marked it unsent');
  assert.ok(isUnsent(page) && !isUnanswered(page), 'a 503 naming no code: an answer, and unsent');

  const once = setUp();
  failing(once.platform, [refused]);
  const paged = setUp();
  failing(paged.platform, [page]);
  const twice = setUp();
  failing(twice.platform, [refusedAgain, refusedTwice]);
  const thenPaged = setUp();
  failing(thenPaged.platform, [refusedFirst, pageLast]);

  const started = Date.now();
  const [onceResult, pagedResult, twiceResult, thenPagedResult] = await Promise.all([
    once.run(),
    paged.run(),
    twice.run(),
    thenPaged.run(),
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 10_000 && elapsed < 15_000, `one 10-second wait each: ${elapsed} ms`);

  for (const [world, result] of [
    [once, onceResult],
    [paged, pagedResult],
  ] as const) {
    assert.equal(result.outcome, 'success');
    assert.equal(world.platform.modelCalls.length, 2, 'the same call, made once more');
    assert.deepEqual(extractLine(world), [
      'extract',
      'ok',
      'Read: bill from Harrowgate Office Supply, $461.53 (after 2 attempts)',
    ]);
  }

  // Two in a row: the attempts are spent, the run fails — AI is busy — no address.
  assert.deepEqual(twiceResult, { outcome: 'failed', failureReason: RUN_FAILS.ai_busy });
  assert.equal(twice.platform.modelCalls.length, 2);
  assert.deepEqual(lines(twice.platform).at(-1), [
    'extract',
    'failed',
    'The extract step failed (after 2 attempts)',
  ]);
  const said = everythingSaid(twice.platform, twiceResult);
  assert.ok(!said.includes('127.0.0.1') && !said.includes('fetch failed'), said);
  assert.deepEqual(twice.logs, [
    [
      'error',
      'run_failed_on_a_throw',
      { runId: twice.request.runId, stepId: 'extract', error: 'TypeError' },
    ],
  ]);
  // Refused, then a page in front of the platform: the same sentence, the page's words nowhere.
  assert.deepEqual(thenPagedResult, twiceResult);
  assert.equal(thenPaged.platform.modelCalls.length, 2);
  const saidPaged = everythingSaid(thenPaged.platform, thenPagedResult);
  assert.ok(!saidPaged.includes('no upstreams'), saidPaged);
});

test('never repeated after an answer that may have been made: a timeout, a dropped connection, a 503 naming its code, a 502', async () => {
  const [timeout, dropped, badGateway] = await Promise.all([
    timedOut(),
    droppedConnection(),
    proxyPage(502),
  ]);
  for (const error of [timeout, dropped]) {
    assert.ok(isUnanswered(error) && !isUnsent(error), 'no answer, but it may have been sent');
  }
  const started = Date.now();
  const thrown = [timeout, dropped];
  for (const failure of thrown) {
    const world = setUp();
    failing(world.platform, [failure]);
    assert.deepEqual(await world.run(), { outcome: 'failed', failureReason: RUN_FAILS.ai_busy });
    assert.equal(world.platform.modelCalls.length, 1, 'made once, never again');
    assert.deepEqual(lines(world.platform).at(-1), [
      'extract',
      'failed',
      'The extract step failed',
    ]);
  }
  const answered = [
    refusalFixture('model', { status: 503, code: 'DEPENDENCY_FAILURE', detail: 'unavailable' }),
    refusalFixture('model', { status: 502, code: 'DEPENDENCY_FAILURE', detail: 'unreachable' }),
    badGateway,
  ];
  for (const failure of answered) {
    const world = setUp();
    failing(world.platform, [failure]);
    assert.deepEqual(await world.run(), { outcome: 'failed', failureReason: RUN_FAILS.ai_busy });
    assert.equal(world.platform.modelCalls.length, 1, 'made once, never again');
  }
  assert.ok(Date.now() - started < 5_000, 'no wait: nothing was repeated');
});
