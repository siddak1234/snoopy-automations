import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_REFUSALS } from '@autom8x/automation-kit/testing';

import { callsOf, lines, setUp } from './fixtures.js';

/**
 * The SDK's own step retry, in real time — its 10-second floor is not a clock a suite can
 * replace, so this is the one test that waits: about 30 seconds. v3 reads the file first, so the
 * deadline leaves the model call its time; QuickBooks' first read then gets its three attempts.
 */

test('a QuickBooks call with no answer is repeated under the same key, 10 s then 20 s later, then the attempts are spent', async () => {
  const world = setUp({ through: 'all', deadlineInMs: 300_000 });
  world.simulator.script(
    'companyInfo.get',
    Array.from({ length: 3 }, () => ({ refuse: PROVIDER_REFUSALS.noAnswer() })),
  );
  const started = Date.now();
  const result = await world.run();
  const elapsed = Date.now() - started;
  // Its attempts spent, read-company keeps every document out of QuickBooks (decision 6): each is
  // saved, and nothing more is asked of QuickBooks.
  assert.deepEqual(lines(world.platform).slice(3), [
    [
      'read-company',
      'failed',
      "Not recorded in QuickBooks: QuickBooks didn't answer (after 3 attempts)",
    ],
    ['decide', 'ok', "Not recorded in QuickBooks: QuickBooks didn't answer"],
    ['save-documents', 'ok', 'Saved: Harrowgate Office Supply, $461.53'],
  ]);
  assert.ok(result.outcome === 'success');
  assert.equal(result.summary, "Saved. Not recorded in QuickBooks: QuickBooks didn't answer.");
  const sent = callsOf(world.platform, world.request, 'read-company');
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map((call) => JSON.stringify(call))).size, 1, 'the same request');
  assert.equal(world.platform.providerCalls.length, 3, 'nothing more asked of QuickBooks');
  assert.ok(
    elapsed >= 30_000 && elapsed < 34_000,
    `waits of 10 s and 20 s, not more: ${elapsed} ms`,
  );
  assert.deepEqual(world.waits, [], 'no QuickBooks wait: the SDK repeated the step');
});
