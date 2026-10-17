import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { bill } from './check-world.js';
import { NONE, everythingSaid, lines, reads, setUp } from './fixtures.js';
import { measure, referenceOf } from './measure.js';
import { assertOutputValid, assertResultValid } from './output-schema.js';
import { SAMPLES, samplePath } from './sample-maker/samples.js';

/**
 * Guard A2 — the vendor "None" (v2's §2.2, "None path", as v3 keeps it): receive → extract →
 * check-documents → (verify-read on a doubt) → decide → save-documents, or ask-approval for a
 * document that waits — and ZERO QuickBooks calls — not a read, not a lookup, not a write — for every sample,
 * whatever the document. A document that can be used is saved, its details its result; one the
 * checks cannot settle waits for approval (B4); nothing fails the run for one document.
 */

/** The steps the None path may report. */
const NONE_STEPS = new Set([
  'receive',
  'extract',
  'check-documents',
  'verify-read',
  'decide',
  'save-documents',
  'ask-approval',
]);

test('every sample, the vendor "None" — missing, or set — makes no QuickBooks call; each is saved, or waits, and none fails the run', async () => {
  let saved = 0;
  let waited = 0;
  for (const sample of SAMPLES) {
    for (const config of [{}, NONE]) {
      const world = setUp({
        through: 'all',
        config,
        file: referenceOf(measure(readFileSync(samplePath(sample)))),
      });
      world.platform.model = reads(sample.answer);
      const result = await world.run();
      const label = `${sample.name} ${JSON.stringify(config)}`;
      assertResultValid(result, label);
      assert.deepEqual(world.platform.providerCalls, [], `${label}: no QuickBooks call`);
      assert.notEqual(result.outcome, 'failed', label);
      for (const [stepId] of lines(world.platform)) {
        assert.ok(NONE_STEPS.has(stepId), `${label}: ${stepId} reported`);
      }
      const { documents = [] } = result as Extract<RunResult, { outcome: 'success' | 'held' }>;
      assert.equal(documents.length, 1, label);
      if (result.outcome === 'held') {
        assert.equal(documents[0]?.status, 'waiting', label);
        assert.match(result.held.reason, /^Document 1: .+[.?]$/u, label);
        waited += 1;
      } else {
        assert.ok(result.outcome === 'success', label);
        assert.equal(documents[0]?.status, 'saved', label);
        assert.equal(documents[0]?.statusText, 'Saved', label);
        assert.match(result.summary ?? '', /^Saved: .+\.$/u, label);
        assertOutputValid(result.output, label);
        saved += 1;
      }
      assert.ok(!everythingSaid(world.platform, result).includes(sample.marker), label);
    }
  }
  assert.equal(saved + waited, SAMPLES.length * 2);
  // The missing page waits, "pages may be missing"; a bank statement is saved, never refused (AM8).
  assert.ok(waited >= 2, `${waited} waited`);
});

test('the None path, step by step: the four lines, one AI read, the document saved as the result', async () => {
  const world = setUp({ through: 'all', config: NONE });
  world.platform.model = reads(bill());
  const result = await world.run();
  assert.deepEqual(lines(world.platform), [
    ['receive', 'ok', 'PDF, 2 pages'],
    ['extract', 'ok', 'Read: bill from Harrowgate Office Supply, $413.34'],
    ['check-documents', 'ok', 'Checks passed'],
    ['decide', 'ok', 'Ready to save'],
    ['save-documents', 'ok', 'Saved: Harrowgate Office Supply, $413.34'],
  ]);
  assert.equal(world.platform.modelCalls.length, 1);
  assert.equal(result.outcome, 'success');
  const success = result as Extract<RunResult, { outcome: 'success' }>;
  assert.equal(success.summary, 'Saved: Harrowgate Office Supply, $413.34.');
  assert.deepEqual(success.output, {
    outcome: 'documents',
    documents: [
      { index: 1, outcome: 'saved', documentType: 'bill', notRecorded: null, unconfirmed: false },
    ],
  });
  const [document] = success.documents ?? [];
  assert.deepEqual(
    [document?.status, document?.vendor.name, document?.number, document?.total, document?.date],
    ['saved', 'Harrowgate Office Supply', 'HOS-1042', '413.34', '2026-09-14'],
  );
  assert.deepEqual(document?.details, [
    { label: 'Category', value: 'Office supplies' },
    { label: 'Due', value: 'Oct 14, 2026' },
    { label: 'Shipping', value: '$12.00' },
  ]);
});

test('a document QuickBooks could not take is still saved with "None": no recording rule is weighed', async () => {
  // Dated in the future, and a total of zero that adds up: rules for QuickBooks alone.
  const zero = { total: 0, subtotal: 0, tax: 0, shipping: null, lineItems: [] };
  for (const changes of [{ documentDate: '2027-01-05' }, zero]) {
    const world = setUp({ through: 'all', config: NONE });
    world.platform.model = reads(bill(changes as JsonObject));
    const result = await world.run();
    assert.equal(result.outcome, 'success', JSON.stringify(changes));
    const [document] = (result as Extract<RunResult, { outcome: 'success' }>).documents ?? [];
    assert.equal(document?.status, 'saved', JSON.stringify(changes));
    assert.deepEqual(world.platform.providerCalls, []);
  }
});
