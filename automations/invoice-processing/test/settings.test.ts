import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { limitCentsOf } from '../src/decide/holds.js';
import { vendorChoiceOf } from '../src/quickbooks-path.js';
import { bill, receipt } from './check-world.js';
import { reads, setUp } from './fixtures.js';
import { seededCompany } from './lookups-world.js';

/**
 * Guard A1 — no setting can fail a run (U7; v2's §2.1): the vendor choice, the approval limit and
 * "Also email", missing, empty, of the wrong kind or out of range, and v1's account settings left
 * in a flow's config, each read as its default or ignored. A document that can be used is saved,
 * recorded or held — never failed for a setting.
 */

const SETTINGS: readonly JsonObject[] = [
  {},
  { vendor: null },
  { vendor: 42 },
  { vendor: {} },
  { vendor: 'QuickBooks' },
  { vendor: ' quickbooks ' },
  { vendor: 'none' },
  { vendor: 'xero' },
  { vendor: 'quickbooks' },
  { vendor: 'quickbooks', holdAboveAmount: 'lots' },
  { vendor: 'quickbooks', holdAboveAmount: -1 },
  { vendor: 'quickbooks', holdAboveAmount: null },
  { vendor: 'quickbooks', holdAboveAmount: 1e300 },
  { vendor: 'quickbooks', holdAboveAmount: Number.NaN },
  { vendor: 'quickbooks', notifyEmail: 42 },
  { vendor: 'quickbooks', notifyEmail: 'not an address' },
  { vendor: 'none', notifyEmail: ['books@example.com'] },
  // v1's settings, still in a flow moved to v2: ignored — the accounts come from QuickBooks.
  {
    vendor: 'quickbooks',
    expenseAccount: 'No such account',
    paidFromAccount: 'No such account',
    teamOwedAccount: 'No such account',
    ownerInvestmentAccount: 'No such account',
    owners: 'Pat Owner',
  },
];

test('the vendor choice: QuickBooks only when the setting says exactly that; anything else is None', () => {
  assert.equal(vendorChoiceOf({ vendor: 'quickbooks' }), 'quickbooks');
  for (const config of SETTINGS.filter((each) => each.vendor !== 'quickbooks')) {
    assert.equal(vendorChoiceOf(config), 'none', JSON.stringify(config));
  }
});

test('the approval limit: $500 when it is missing, not a number, or below zero', () => {
  for (const holdAboveAmount of [undefined, null, 'lots', -1, Number.NaN, {}]) {
    assert.equal(limitCentsOf({ holdAboveAmount } as JsonObject), 50_000, String(holdAboveAmount));
  }
  assert.equal(limitCentsOf({ holdAboveAmount: 0 }), 0);
  assert.equal(limitCentsOf({ holdAboveAmount: 1_000 }), 100_000);
});

test('no setting fails a run: a bill and a receipt under every setting above are saved, recorded or held', async () => {
  for (const answer of [bill(), receipt()]) {
    for (const config of SETTINGS) {
      const simulator = seededCompany(new QuickBooksSimulator({ refusal: refusalFixture }));
      simulator.expenseAmountSearchable = true;
      const world = setUp({ simulator, through: 'all', config });
      world.platform.model = reads(answer);
      const result = await world.run();
      const label = `${String(answer.documentType)} ${JSON.stringify(config)}`;
      assert.notEqual(result.outcome, 'failed', `${label}: ${JSON.stringify(result)}`);
      // No step failed with a reason either: the only failed line a setting may cause is notify's.
      for (const step of world.platform.steps) {
        if (step.outcome === 'failed') assert.equal(step.stepId, 'notify', label);
      }
      if (vendorChoiceOf(config) === 'none') {
        assert.deepEqual(world.platform.providerCalls, [], `${label}: no QuickBooks call`);
      }
    }
  }
});
