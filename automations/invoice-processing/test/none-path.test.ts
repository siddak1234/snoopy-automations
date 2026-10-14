import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import type { DocumentRule } from '../src/checks/rules.js';
import { QUICKBOOKS_STEPS } from '../src/failures.js';
import { RUN_FAILS } from '../src/words.js';
import { bill } from './check-world.js';
import { NONE, everythingSaid, lines, reads, setUp } from './fixtures.js';
import { measure, referenceOf } from './measure.js';
import { assertOutputValid } from './output-schema.js';
import { SAMPLES, samplePath } from './sample-maker/samples.js';
import { SAMPLE_ROUTES } from './sample-routes.js';

/**
 * Guard A2 — the vendor "None" (v2's §2.2, "None path"): receive → extract → check-document →
 * (verify-read on a problem) → save-details → notify, and ZERO QuickBooks calls — not a read, not
 * a lookup, not a write — for every sample, whatever the document. Nothing waits for approval; a
 * document that can be used is saved, its details the run's result; one that cannot ends with one
 * of the spec's sentences, as on the QuickBooks path.
 */

/** The steps the None path may report. */
const NONE_STEPS = new Set([
  'receive',
  'extract',
  'check-document',
  'verify-read',
  'save-details',
  'notify',
]);

const outputOf = (result: RunResult): JsonObject => {
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 300));
  return (result as Extract<RunResult, { outcome: 'success' }>).output ?? {};
};

test('every sample, the vendor "None" — missing, or set — makes no QuickBooks call and never waits; a usable one is saved', async () => {
  let saved = 0;
  for (const sample of SAMPLES) {
    for (const config of [{}, NONE, { ...NONE, notifyEmail: 'books@example.com' }]) {
      const world = setUp({
        through: 'all',
        config,
        file: referenceOf(measure(readFileSync(samplePath(sample)))),
      });
      world.platform.model = reads(sample.answer);
      const result = await world.run();
      const label = `${sample.name} ${JSON.stringify(config)}`;
      assert.deepEqual(world.platform.providerCalls, [], `${label}: no QuickBooks call`);
      assert.notEqual(result.outcome, 'held', label);
      for (const [stepId] of lines(world.platform)) {
        assert.ok(NONE_STEPS.has(stepId), `${label}: ${stepId} reported`);
        assert.ok(!QUICKBOOKS_STEPS.has(stepId), `${label}: ${stepId}`);
      }
      const [route] = SAMPLE_ROUTES[sample.name] ?? [''];
      if (['C1', 'C5', 'C6'].includes(route)) {
        // A document no path can use: the same sentence as with QuickBooks.
        assert.deepEqual(
          result,
          { outcome: 'failed', failureReason: RUN_FAILS[route as DocumentRule] },
          label,
        );
        continue;
      }
      const output = outputOf(result);
      assert.equal(output.outcome, 'saved', label);
      assert.equal(output.notRecorded, null, label);
      assertOutputValid(output, label);
      const { summary, details } = result as Extract<RunResult, { outcome: 'success' }>;
      assert.match(summary ?? '', /^Saved: .+\.$/u, label);
      assert.deepEqual(
        (details ?? []).slice(0, 2).map((line) => line.label),
        ['Type', 'Seller'],
        label,
      );
      assert.ok(!everythingSaid(world.platform, result).includes(sample.marker), label);
      // notify last when an address is set; save-details last otherwise.
      assert.equal(
        lines(world.platform).at(-1)?.[0],
        typeof (config as JsonObject).notifyEmail === 'string' ? 'notify' : 'save-details',
        label,
      );
      saved += 1;
    }
  }
  assert.equal(saved, (SAMPLES.length - 3) * 3, 'every usable sample saved, three ways');
});

test('the None path, step by step: the four lines, one AI read, the saved details as the result', async () => {
  const world = setUp({ through: 'all', config: NONE });
  world.platform.model = reads(bill());
  const result = await world.run();
  assert.deepEqual(lines(world.platform), [
    ['receive', 'ok', 'PDF, 2 pages'],
    ['extract', 'ok', 'Read: bill from Harrowgate Office Supply, $413.34'],
    ['check-document', 'ok', 'Checks passed'],
    ['save-details', 'ok', 'Saved: Harrowgate Office Supply, $413.34'],
  ]);
  assert.equal(world.platform.modelCalls.length, 1);
  assert.deepEqual(result, {
    outcome: 'success',
    output: {
      outcome: 'saved',
      documentType: 'bill',
      seller: 'Harrowgate Office Supply',
      number: 'HOS-1042',
      date: '2026-09-14',
      dueDate: '2026-10-14',
      currency: 'USD',
      totalCents: 41334,
      taxCents: 3059,
      spendType: 'office_supplies',
      paymentMethod: 'not_shown',
      cardLast4: null,
      notRecorded: null,
    },
    summary: 'Saved: Harrowgate Office Supply, $413.34.',
    details: [
      { label: 'Type', value: 'Bill' },
      { label: 'Seller', value: 'Harrowgate Office Supply' },
      { label: 'Number', value: 'HOS-1042' },
      { label: 'Date', value: 'Sep 14, 2026' },
      { label: 'Due', value: 'Oct 14, 2026' },
      { label: 'Total', value: '$413.34' },
      { label: 'Tax', value: '$30.59' },
      { label: 'Category', value: 'Office supplies' },
    ],
  });
});

test('a document QuickBooks could not take is still saved with "None": no recording rule is weighed', async () => {
  // Dated in the future, and a total of zero: rules for QuickBooks alone.
  for (const changes of [{ documentDate: '2027-01-05' }, { total: 0, subtotal: 0, tax: 0 }]) {
    const world = setUp({ through: 'all', config: NONE });
    world.platform.model = reads(bill(changes as JsonObject));
    const result = await world.run();
    assert.equal(outputOf(result).outcome, 'saved', JSON.stringify(changes));
    assert.deepEqual(world.platform.providerCalls, []);
  }
});
