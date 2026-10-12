import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleVendor } from '@autom8x/automation-kit/testing';

import { everythingSaid } from './fixtures.js';
import { PAID, routeRun } from './lookups-world.js';
import { SAMPLES } from './sample-maker/samples.js';
import { SAMPLE_ROUTES } from './sample-routes.js';

/**
 * The planted marker (the plan's §2.9), printed on each made-up sample where the automation must
 * never pass it on — a line's text or a notes box: through the whole run, every route's lookups
 * included, it is in no QuickBooks query, no timeline line, no reason and no output — and the
 * lookups ask by the seller's name and the document's number, carried by design, which never hold it.
 */

/** Every seller the samples print, a vendor in the made-up company, so every route's lookups run. */
const SELLERS = [...new Set(SAMPLES.map((sample) => String(sample.answer.vendorName)))];

test("no sample's marker reaches a query, a line, a reason or the run's output, on any route", async () => {
  let routed = 0;
  for (const sample of SAMPLES) {
    const [route] = SAMPLE_ROUTES[sample.name] ?? [''];
    const runs = [
      PAID.company,
      ...(sample.answer.documentType === 'receipt' ? [PAID.employee] : []),
    ];
    for (const paid of runs) {
      const world = await routeRun({
        answer: sample.answer,
        ...paid,
        bare: true,
        company: (sim) =>
          sim.company.vendors.push(
            ...SELLERS.map((name, index) => sampleVendor(String(700 + index), name)),
          ),
      });
      const said = `${everythingSaid(world.platform, world.result)}${JSON.stringify(world.platform.providerCalls)}`;
      assert.ok(!said.includes(sample.marker), `${sample.name}: the marker`);
      if (!/^C\d+$/u.test(route)) {
        routed += 1;
        assert.notEqual(
          world.result.outcome,
          'failed',
          `${sample.name}: ${JSON.stringify(world.result)}`,
        );
      }
    }
  }
  assert.ok(routed >= 20, `${routed} routed runs`);
});

test('the rows a bill lists, only counted (hold 5), never reach a query, a line or the output', async () => {
  const marker = 'QZ7LISTED';
  const sample = SAMPLES.find((each) => each.name === 'typed-text-pdf')!;
  const world = await routeRun({
    answer: {
      ...sample.answer,
      listedItems: [{ reference: marker, amount: 12.5, kind: 'invoice' }],
      listedItemsComplete: true,
    },
  });
  assert.ok(world.result.outcome === 'held', 'held: it may be a statement');
  const said = `${everythingSaid(world.platform, world.result)}${JSON.stringify(world.platform.providerCalls)}`;
  assert.ok(!said.includes(marker));
});
