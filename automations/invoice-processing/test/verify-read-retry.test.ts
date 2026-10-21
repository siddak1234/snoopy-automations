import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isUnanswered, isUnsent } from '@autom8x/automation-sdk';
import type { RecordingPlatform } from '@autom8x/automation-sdk/testing';

import { RUN_FAILS } from '../src/words.js';
import { receipt } from './check-world.js';
import {
  QUICKBOOKS,
  completion,
  documentAnswer,
  everythingSaid,
  isSecondRead,
  jpeg,
  lines,
  partAnswer,
  positionsOf,
  reads,
  secondAnswer,
  setUp,
  verifyAnswer,
} from './fixtures.js';
import { proxyPage, refusedConnection, timedOut } from './wire.js';

/**
 * The second read's one retry, as `extract`'s, on a real wire: `{ attempts: 2, backoffMs: 10_000,
 * when: 'unsent' }` repeats the step once, 10 s later in real time, only when the call provably
 * never reached the platform; twice, or an answer that never came, is the platform's fault, and
 * fails the run: "AI is busy" (Group 2's D6, D8). A second read is made only when due: here, the
 * amount over a limit of 0 on the QuickBooks path.
 */

/** A run whose second read is due: over the approval limit, QuickBooks chosen. */
const due = () => setUp({ config: { ...QUICKBOOKS, holdAboveAmount: 0 } });

/** The second read fails its first `failures.length` calls in turn; the first read is answered. */
function failingSecond(platform: RecordingPlatform, failures: readonly unknown[]): void {
  let calls = 0;
  platform.model = (call, model) => {
    if (!isSecondRead(call)) return reads()(call, model);
    const failure = failures[calls];
    calls += 1;
    return failure === undefined ? reads()(call, model) : Promise.reject(failure);
  };
}

const verifyLine = (platform: RecordingPlatform) =>
  lines(platform).find(([stepId]) => stepId === 'verify-read');

test('repeated once, 10 s later, when nothing reached the platform; twice, the run fails in one sentence', async () => {
  const [refused, page, again, twice, timeout] = await Promise.all([
    refusedConnection(),
    proxyPage(503),
    refusedConnection(),
    refusedConnection(),
    timedOut(),
  ]);
  assert.ok(isUnsent(refused) && isUnsent(page) && isUnsent(again));
  assert.ok(isUnanswered(timeout) && !isUnsent(timeout));

  const once = due();
  failingSecond(once.platform, [refused]);
  const paged = due();
  failingSecond(paged.platform, [page]);
  const both = due();
  failingSecond(both.platform, [again, twice]);
  const unanswered = due();
  failingSecond(unanswered.platform, [timeout]);

  const started = Date.now();
  const [onceResult, pagedResult, bothResult, unansweredResult] = await Promise.all([
    once.run(),
    paged.run(),
    both.run(),
    unanswered.run(),
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 10_000 && elapsed < 15_000, `one 10-second wait each: ${elapsed} ms`);

  for (const [world, result] of [
    [once, onceResult],
    [paged, pagedResult],
  ] as const) {
    assert.equal(result.outcome, 'success');
    assert.equal(world.platform.modelCalls.length, 3, 'read 1, then read 2 twice');
    assert.deepEqual(verifyLine(world.platform), [
      'verify-read',
      'ok',
      'Second read matches (after 2 attempts)',
    ]);
  }
  // Twice unsent: the platform is not there — a fault, not a hold.
  assert.deepEqual(bothResult, { outcome: 'failed', failureReason: RUN_FAILS.ai_busy });
  assert.equal(both.platform.modelCalls.length, 3);
  assert.deepEqual(verifyLine(both.platform), [
    'verify-read',
    'failed',
    'The verify-read step failed (after 2 attempts)',
  ]);
  assert.ok(!everythingSaid(both.platform, bothResult).includes('127.0.0.1'));
  // No answer after it was sent: never repeated — it may have been made and billed.
  assert.deepEqual(unansweredResult, { outcome: 'failed', failureReason: RUN_FAILS.ai_busy });
  assert.equal(unanswered.platform.modelCalls.length, 2, 'read 1 and one read 2');
  assert.deepEqual(unanswered.logs.at(-1)?.[2], {
    runId: unanswered.request.runId,
    stepId: 'verify-read',
    error: 'TimeoutError',
  });
});

test("a repeat goes on from the call that never left: 21 doubtful documents, the second call unsent — three second-read calls, never the answered one again (Gate 25's R5d)", async () => {
  const refused = await refusedConnection();
  const documents = Array.from({ length: 21 }, (_, at) =>
    documentAnswer(receipt({ vendorName: `Store ${at + 1}`, documentNumber: `R-${at + 1}` })),
  );
  const world = setUp({
    config: { ...QUICKBOOKS, holdAboveAmount: 0 },
    file: jpeg(),
    through: 'all',
  });
  let seconds = 0;
  world.platform.model = (call, model) => {
    if (!isSecondRead(call)) {
      return Promise.resolve(completion(model, partAnswer(documents)));
    }
    seconds += 1;
    if (seconds === 2) return Promise.reject(refused);
    const named = positionsOf(call).map(
      (position) => [position, secondAnswer({ ...documents[position - 1] })] as const,
    );
    return Promise.resolve(completion(model, verifyAnswer(named, documents.length)));
  };
  const result = await world.run();
  assert.equal(result.outcome, 'held', JSON.stringify(result).slice(0, 300));
  const twenty = Array.from({ length: 20 }, (_, at) => at + 1);
  assert.deepEqual(world.platform.modelCalls.filter(isSecondRead).map(positionsOf), [
    twenty,
    [21],
    [21],
  ]);
  assert.match(verifyLine(world.platform)?.[2] ?? '', / \(after 2 attempts\)$/u);
});
