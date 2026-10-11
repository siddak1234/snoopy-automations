import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_REFUSALS } from '@autom8x/automation-kit/testing';

import { callsOf, lines, setUp } from './fixtures.js';

/**
 * The SDK's own step retry, in real time — its 10-second floor is not a clock a suite
 * can replace, so this is the one test that waits: about 20 seconds. The deadline is
 * 25 seconds away, which leaves room for one repeat at each of two steps and no more.
 */

test('a QuickBooks call with no answer is repeated 10 s later under the same key, then the attempts are spent', async () => {
  const world = setUp({ deadlineInMs: 25_000 });
  world.simulator.script('companyInfo.get', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]);
  world.simulator.script('preferences.get', [
    { refuse: PROVIDER_REFUSALS.noAnswer() },
    { refuse: PROVIDER_REFUSALS.noAnswer() },
  ]);
  const started = Date.now();
  const result = await world.run();
  const elapsed = Date.now() - started;
  assert.deepEqual(lines(world.platform).slice(1), [
    ['read-company', 'ok', 'QuickBooks company: Sample Bakery (US) (after 2 attempts)'],
    ['read-preferences', 'failed', 'The read-preferences step failed (after 2 attempts)'],
  ]);
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason:
      'Autom8x could not reach QuickBooks. Run it again in a few minutes; nothing was created.',
  });
  for (const stepId of ['read-company', 'read-preferences']) {
    const sent = callsOf(world.platform, world.request, stepId);
    assert.equal(sent.length, 2, stepId);
    assert.equal(new Set(sent.map((call) => JSON.stringify(call))).size, 1, 'the same request');
  }
  assert.ok(elapsed >= 20_000 && elapsed < 24_000, `two 10-second waits, not more: ${elapsed} ms`);
  assert.deepEqual(world.waits, [], 'no QuickBooks wait: the SDK repeated the step');
});
