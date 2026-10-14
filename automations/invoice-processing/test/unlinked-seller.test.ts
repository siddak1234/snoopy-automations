import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { Decision } from '../src/decide/decide.js';
import { receipt, sampleAnswer } from './check-world.js';
import { decide, type DecideSetUp } from './decide-world.js';
import { lineOf, queriesOf, routeRun, sampleVendor, stateOf } from './lookups-world.js';

/**
 * A company receipt's or a card refund's seller that an inactive vendor has, or two vendors have
 * (the owner's "complete all", 2026-10-11): the seller is looked up only to link an existing vendor
 * (D20), so it is not linked rather than kept out — the record has no payee and the seller in its
 * memo and line text. A bill's, a credit note's or a statement's is not recorded (find-vendor.test.ts).
 */

const THROUGH = 'find-vendor-company';

function saved(decision: Decision) {
  assert.ok(decision.outcome === 'ok' || decision.outcome === 'held', decision.outcome);
  return decision.saved;
}
const plan = (setUp: DecideSetUp) => saved(decide(setUp)).plan;

test("a company receipt's or a card refund's seller that an inactive vendor has, or two vendors have, is not linked: the record has no payee, and the run goes on (D20)", async () => {
  type Company = NonNullable<Parameters<typeof routeRun>[0]['company']>;
  const cases: [string, Company, string, string, JsonObject][] = [
    [
      'inactive',
      (sim) => sim.company.vendors.push(sampleVendor('9', 'Tidewell Hardware', { Active: false })),
      'find-vendor',
      'Vendor found',
      { status: 'not_linked', reason: 'inactive', matchedBy: 'display name' },
    ],
    [
      'two',
      (sim) =>
        sim.company.vendors.push(
          sampleVendor('9', 'Tidewell Hardware'),
          sampleVendor('19', 'TIDEWELL HARDWARE'),
        ),
      'find-vendor',
      'Vendor found',
      { status: 'not_linked', reason: 'ambiguous', matchedBy: 'display name' },
    ],
    [
      'inactive by company name',
      (sim) =>
        sim.company.vendors.push(
          sampleVendor('61', 'Tidewell', { CompanyName: 'Tidewell Hardware', Active: false }),
        ),
      'find-vendor-company',
      'Vendor found',
      { status: 'not_linked', reason: 'inactive', matchedBy: 'company name' },
    ],
    [
      'two by company name',
      (sim) =>
        sim.company.vendors.push(
          sampleVendor('61', 'Tidewell East', { CompanyName: 'Tidewell Hardware' }),
          sampleVendor('62', 'Tidewell West', { CompanyName: 'Tidewell Hardware' }),
        ),
      'find-vendor-company',
      'Vendor found',
      { status: 'not_linked', reason: 'ambiguous', matchedBy: 'company name' },
    ],
  ];
  for (const [document, answer] of [
    ['receipt', receipt()],
    ['card refund', sampleAnswer('card-refund')],
  ] as const) {
    for (const [label, company, stepId, line, vendor] of cases) {
      const named = `${document}, ${label}`;
      const through = await routeRun({ answer, bare: true, company, through: THROUGH });
      assert.deepEqual(stateOf(through.result).vendor, vendor, named);
      assert.equal(lineOf(through, stepId), line, named);
      // Settled by its name: nothing is looked up by company name.
      const searched = Object.keys(queriesOf(through));
      assert.deepEqual(
        searched,
        stepId === 'find-vendor' ? ['find-vendor'] : ['find-vendor', 'find-vendor-company'],
        named,
      );
      const world = await routeRun({ answer, bare: true, company });
      assert.equal(world.result.outcome, 'success', `${named}: ${JSON.stringify(world.result)}`);
      const record = (stateOf(world.result).record ?? {}) as JsonObject;
      assert.deepEqual(record.payee, { kind: 'none' }, named);
      assert.equal(lineOf(world, 'decide'), 'Ready to record', named);
    }
  }
});

test("a receipt's or a card refund's seller not linked — an inactive vendor's name, or two vendors' — is recorded with no payee, the seller in the memo and the line text (D20)", () => {
  for (const reason of ['inactive', 'ambiguous'] as const) {
    const vendor = { status: 'not_linked', reason, matchedBy: 'display name' } as const;
    const receiptDecision = decide({ answer: receipt(), vendor });
    assert.equal(receiptDecision.outcome, 'ok', reason);
    const expense = saved(receiptDecision).plan;
    assert.deepEqual(
      [expense.payee, expense.memo, expense.lineDescription],
      [
        { kind: 'none' },
        `Receipt 55120 from Tidewell Hardware.`,
        'Receipt 55120 from Tidewell Hardware',
      ],
    );
    assert.deepEqual(expense.accounts.category, {
      id: '305',
      name: 'Repairs & Maintenance',
      why: 'its name',
    });
    const refund = plan({ answer: sampleAnswer('card-refund'), vendor });
    assert.deepEqual(
      [refund.payee, refund.memo, refund.lineDescription],
      [
        { kind: 'none' },
        `Refund R-6603 from Tidewell Hardware.`,
        'Refund R-6603 from Tidewell Hardware',
      ],
    );
  }
  // A seller nobody has, as before: no payee.
  assert.deepEqual(plan({ answer: receipt(), vendor: { status: 'new' } }).payee, { kind: 'none' });
});
