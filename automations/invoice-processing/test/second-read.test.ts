import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import type { Finding } from '../src/state.js';
import { secondReadDue } from '../src/steps/verify-read.js';
import { bill } from './check-world.js';
import { NONE, QUICKBOOKS, lines, reads, setUp } from './fixtures.js';
import { seededCompany } from './lookups-world.js';

/**
 * Guard A3 — one AI read, a second only when the first shows a problem (decision 3; v2's §2.4):
 * totals that don't add up, unclear details, a total that could not be checked — or, with
 * QuickBooks chosen, an amount over the approval limit. Otherwise verify-read is skipped: no
 * model call, no line, and the state says the second read was not needed.
 */

const doc = (findings: Finding[], amountCents = 10_000) => ({ findings, amountCents });

test('due on a problem, on either path; over the limit only with QuickBooks; never on anything else', () => {
  for (const finding of ['amounts_mismatch', 'unclear_fields', 'not_cross_checked'] as const) {
    assert.equal(secondReadDue(doc([finding]), {}, true), true, finding);
    assert.equal(secondReadDue(doc([finding]), {}, false), true, finding);
  }
  for (const finding of [
    'tip_added',
    'earlier_balance',
    'lists_other_invoices',
    'refund_method_not_shown',
    'currency_unrecognised',
  ] as const) {
    assert.equal(secondReadDue(doc([finding]), {}, true), false, finding);
  }
  assert.equal(secondReadDue(doc([]), {}, true), false);
  // Over the limit: $500 by default, the flow's own when set.
  assert.equal(secondReadDue(doc([], 50_001), {}, true), true);
  assert.equal(secondReadDue(doc([], 50_000), {}, true), false);
  assert.equal(secondReadDue(doc([], 10_001), { holdAboveAmount: 100 }, true), true);
  assert.equal(secondReadDue(doc([], 50_001), {}, false), false, 'with None, no limit applies');
});

/** A whole run of the sample bill, its total $413.34 — the model calls and verify-read's line. */
async function readsOf(config: JsonObject, answer: JsonObject = bill()) {
  const simulator = seededCompany(new QuickBooksSimulator({ refusal: refusalFixture }));
  simulator.expenseAmountSearchable = true;
  const world = setUp({ simulator, through: 'all', config });
  world.platform.model = reads(answer);
  await world.run();
  return {
    calls: world.platform.modelCalls.length,
    line: lines(world.platform).find(([stepId]) => stepId === 'verify-read'),
  };
}

test('whole runs: one model call when nothing looks wrong; two when a problem shows, or over the limit with QuickBooks', async () => {
  assert.deepEqual(await readsOf(QUICKBOOKS), { calls: 1, line: undefined });
  assert.deepEqual(await readsOf(NONE), { calls: 1, line: undefined });
  const over = { holdAboveAmount: 100 };
  assert.deepEqual(await readsOf({ ...QUICKBOOKS, ...over }), {
    calls: 2,
    line: ['verify-read', 'ok', 'Second read matches'],
  });
  assert.deepEqual(await readsOf({ ...NONE, ...over }), { calls: 1, line: undefined });
  // The parts not adding up to the total: a second read on either path.
  const mismatch = bill({ subtotal: 300 });
  for (const config of [QUICKBOOKS, NONE]) {
    const { calls, line } = await readsOf(config, mismatch);
    assert.equal(calls, 2, JSON.stringify(config));
    assert.equal(line?.[0], 'verify-read');
  }
});
