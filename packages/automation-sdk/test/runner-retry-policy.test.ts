import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_STEP_BACKOFF_MS, MIN_STEP_BACKOFF_MS, attempt, backoffWaits } from '../src/retry.js';
import { RecordingPlatform } from '../src/testing.js';
import { noAnswer, posting, recordedWaits, retrying } from './retry-fixtures.js';
import { define, invoke, ok } from './runner-fixtures.js';

/**
 * A retry policy at definition (platform BUILD-PLAN 25.5.1): refused when it is
 * malformed or would repeat sooner than the floor, clamped when it asks for more
 * than the ceilings allow. How the runner applies it is `runner-retry.test.ts`.
 */

const waited = recordedWaits();

test('the ceilings clamp a policy that asks for more: three attempts, thirty seconds of waiting in all', async () => {
  const automation = define({
    steps: { receive: ok('r'), validate: ok('v'), post: posting },
    retry: {
      receive: { attempts: 2, backoffMs: 12_000 },
      validate: { attempts: 2, backoffMs: 45_000 },
      post: { attempts: 9, backoffMs: 60_000 },
    },
  });
  assert.deepEqual(automation.retry, {
    receive: { attempts: 2, backoffMs: 12_000 },
    validate: { attempts: 2, backoffMs: 30_000 },
    post: { attempts: 3, backoffMs: 10_000 },
  });

  // The waits the runner sleeps are the clamped ones.
  const policy = automation.retry.post;
  assert.ok(policy);
  const failure = await noAnswer();
  const slept: number[] = [];
  const attempted = await attempt(
    () => Promise.reject(failure),
    backoffWaits(policy),
    new Date(Date.now() + 900_000).toISOString(),
    (milliseconds) => {
      slept.push(milliseconds);
      return Promise.resolve();
    },
  );
  assert.deepEqual(slept, [10_000, 20_000]);
  assert.equal(
    slept.reduce((sum, wait) => sum + wait, 0),
    MAX_STEP_BACKOFF_MS,
  );
  assert.ok(attempted.threw && attempted.attempts === 3);

  // A step that asks for nine attempts makes three.
  const platform = new RecordingPlatform();
  platform.provider = () => Promise.reject(failure);
  await assert.rejects(
    retrying({ post: { attempts: 9, backoffMs: MIN_STEP_BACKOFF_MS } }).execute(invoke(), platform),
  );
  assert.equal(platform.providerCalls.length, 3);
  assert.deepEqual(waited, [10_000, 20_000]);
  assert.equal(platform.steps.at(-1)?.summary, 'The post step failed (after 3 attempts)');
});

test('a retry policy is refused at definition when it names a step with no code, counts nothing, or repeats sooner than the floor', () => {
  for (const [retry, refusal] of [
    [
      { audit: { attempts: 2, backoffMs: MIN_STEP_BACKOFF_MS } },
      /names step "audit", which the code does not implement/u,
    ],
    [{ constructor: { attempts: 2, backoffMs: MIN_STEP_BACKOFF_MS } }, /names step "constructor"/u],
    [{ post: { attempts: 0, backoffMs: MIN_STEP_BACKOFF_MS } }, /must count at least one attempt/u],
    [
      { post: { attempts: 1.5, backoffMs: MIN_STEP_BACKOFF_MS } },
      /must count at least one attempt/u,
    ],
    [{ post: { attempts: 2, backoffMs: -1 } }, /must wait a whole number of milliseconds/u],
    [{ post: { attempts: 2, backoffMs: Number.NaN } }, /must wait a whole number of milliseconds/u],
    [
      { post: { attempts: 2, backoffMs: MIN_STEP_BACKOFF_MS - 1 } },
      /must wait at least 10000 milliseconds before a repeat/u,
    ],
    [
      { post: { attempts: 3, backoffMs: 0 } },
      /must wait at least 10000 milliseconds before a repeat/u,
    ],
  ] as const) {
    assert.throws(() => retrying(retry), refusal);
  }
});
