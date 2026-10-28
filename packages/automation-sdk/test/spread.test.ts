import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_STEP_ATTEMPTS,
  MAX_STEP_BACKOFF_MS,
  MIN_STEP_BACKOFF_MS,
  backoffWaits,
  boundedPolicy,
  spreadWaits,
} from '../src/retry.js';

/**
 * 5a's SDK half (Round 21, D2.4; `defineFlow` only): each wait spread upward by up to half of
 * itself, never subtracted, cut so the waits sum to at most the cap. Over 1,000 drawn policies no
 * wait is under its unspread value or under the 10 s floor, and no sum is over 30 s.
 */

test('5a: over 1,000 drawn policies, no wait is under its unspread value or 10 s, and no sum is over 30 s', () => {
  let spread = 0;
  for (let draw = 0; draw < 1_000; draw += 1) {
    const policy = boundedPolicy('step', {
      attempts: 1 + Math.floor(Math.random() * MAX_STEP_ATTEMPTS),
      backoffMs: MIN_STEP_BACKOFF_MS + Math.floor(Math.random() * 30_000),
    });
    const plain = backoffWaits(policy);
    const waits = spreadWaits(policy);
    assert.equal(waits.length, plain.length);
    for (const [index, wait] of waits.entries()) {
      assert.ok(wait >= plain[index]!, `${wait} is under its unspread ${plain[index]}`);
      assert.ok(wait >= MIN_STEP_BACKOFF_MS, `${wait} is under the floor`);
      assert.ok(wait <= plain[index]! * 1.5, `${wait} is more than half again`);
      if (wait > plain[index]!) spread += 1;
    }
    assert.ok(waits.reduce((sum, wait) => sum + wait, 0) <= MAX_STEP_BACKOFF_MS);
  }
  assert.ok(spread > 0, 'some wait was spread');
});

test('5a: at three attempts there is no room, at two the wait spreads inside the cap', () => {
  const three = boundedPolicy('step', { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS });
  assert.deepEqual(
    spreadWaits(three, () => 0.999),
    [10_000, 20_000],
  );
  const two = boundedPolicy('step', { attempts: 2, backoffMs: MIN_STEP_BACKOFF_MS });
  assert.deepEqual(
    spreadWaits(two, () => 0.999),
    [14_995],
  );
  assert.deepEqual(
    spreadWaits(two, () => 0),
    [10_000],
  );
  const long = boundedPolicy('step', { attempts: 2, backoffMs: 25_000 });
  assert.deepEqual(
    spreadWaits(long, () => 0.999),
    [30_000],
    'cut at the cap',
  );
});
