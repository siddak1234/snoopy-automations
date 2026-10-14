import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineAutomation, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { checkDocument, checkedSummary } from '../src/steps/check-document.js';
import { RUN_FAILS } from '../src/words.js';
import {
  bill,
  check,
  creditNote,
  documentOf,
  receipt,
  sampleAnswer,
  statement,
} from './check-world.js';
import { SEEDED_STATE } from './extract-world.js';
import { NONE, QUICKBOOKS, lines, reads, setUp } from './fixtures.js';
import { SAMPLES } from './sample-maker/samples.js';
import { SAMPLE_ROUTES } from './sample-routes.js';

/**
 * `check-document` as a step on the SDK's runner: what it keeps and drops of the state, its
 * timeline line, its guards, the run's clock, and every made-up sample's expected answer routed as
 * the plan says — a document that cannot be used failing on either path, one QuickBooks cannot
 * record going on, its details to be saved (v2's §2.6).
 */

/** check-document alone: a first step seeds the state the steps before it leave. */
function world(
  seeded: JsonObject,
  config: JsonObject = QUICKBOOKS,
  now = Date.parse('2026-10-11T12:00:00Z'),
) {
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [
      {
        templateId: TEMPLATE_ID,
        version: 2,
        requiredCapabilities: [],
        pipeline: [{ id: 'seed' }, { id: 'check-document' }],
      },
    ],
    steps: {
      seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: seeded }),
      'check-document': checkDocument({ now: () => now }),
    },
    result: (state) => ({ output: state }),
  });
  const platform = new RecordingPlatform();
  const request = invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 2, config });
  return { platform, run: () => automation.execute(request, platform) };
}

const seeded = (answer: unknown, more: JsonObject = {}): JsonObject => ({
  ...SEEDED_STATE,
  extraction: answer as JsonObject,
  modelServed: 'anthropic/claude-haiku-4.5',
  ...more,
});

test('the raw answer leaves the state; every earlier key stays, and the cleaned document joins them', async () => {
  const { platform, run } = world(seeded(bill()));
  const result = await run();
  assert.ok(result.outcome === 'success');
  const { extraction, document, ...rest } = result.output ?? {};
  assert.equal(extraction, undefined, 'the answer, its lines and their words, gone');
  const { extraction: _answer, ...earlier } = seeded(bill());
  assert.deepEqual(rest, earlier);
  assert.deepEqual(document, documentOf(check(bill())));
  assert.deepEqual(
    [platform.providerCalls, platform.modelCalls, platform.mails],
    [[], [], []],
    'no call of any kind',
  );
  assert.deepEqual(lines(platform).at(-1), ['check-document', 'ok', 'Checks passed']);
});

test('a document that cannot be used ends the run with its sentence, which is its line too; the code reaches no person', async () => {
  const { platform, run } = world(seeded(bill({ total: null })));
  assert.deepEqual(await run(), { outcome: 'failed', failureReason: RUN_FAILS.C11 });
  assert.deepEqual(lines(platform).at(-1), ['check-document', 'failed', RUN_FAILS.C11]);
});

test('a document QuickBooks cannot record goes on: not recorded, its reason in the state for the steps after', async () => {
  const { platform, run } = world(seeded(receipt({ cashBackPrinted: true })));
  const result = await run();
  assert.ok(result.outcome === 'success');
  assert.deepEqual(result.output?.quickBooks, { notRecorded: 'it includes cash back' });
  assert.ok(result.output?.document, 'the document kept, for its details');
  assert.deepEqual(lines(platform).at(-1), [
    'check-document',
    'ok',
    'Not recorded in QuickBooks: it includes cash back',
  ]);
});

test('with the vendor "None" no recording rule is weighed, and no company is needed', async () => {
  const { company: _company, chart: _chart, preferences: _prefs, ...noQuickBooks } = SEEDED_STATE;
  const { platform, run } = world(
    { ...noQuickBooks, extraction: receipt({ cashBackPrinted: true }), modelServed: 'm/x' },
    NONE,
  );
  const result = await run();
  assert.ok(result.outcome === 'success');
  assert.equal(result.output?.quickBooks, undefined);
  assert.deepEqual(lines(platform).at(-1), ['check-document', 'ok', 'Checks passed']);
});

test('the guards that should never fire: an answer that is not the schema, a company missing', async () => {
  const unusable = world(seeded({ documentType: 'bill' }));
  assert.deepEqual(await unusable.run(), {
    outcome: 'failed',
    failureReason: RUN_FAILS.unreadable,
  });
  for (const more of [{ company: undefined }, { company: { legalName: null } }]) {
    assert.deepEqual(
      await world(seeded(bill(), more)).run(),
      { outcome: 'failed', failureReason: RUN_FAILS.other },
      JSON.stringify(more),
    );
  }
});

test("the run's clock: a document dated tomorrow passes, two days ahead is not recorded, by the UTC date", async () => {
  const dated = (date: string) => seeded(bill({ documentDate: date, dueDate: null }));
  const late = Date.parse('2026-10-10T23:59:00Z');
  const early = Date.parse('2026-10-11T00:01:00Z');
  const quickBooksOf = async (date: string, now: number) => {
    const result = await world(dated(date), QUICKBOOKS, now).run();
    return result.outcome === 'success' ? result.output?.quickBooks : result;
  };
  assert.equal(await quickBooksOf('2026-10-11', late), undefined);
  assert.deepEqual(await quickBooksOf('2026-10-12', late), {
    notRecorded: "it's dated in the future",
  });
  assert.equal(await quickBooksOf('2026-10-12', early), undefined);
});

test('the same state and clock give the same answer: a run re-sent reaches it again', async () => {
  const first = await world(seeded(sampleAnswer('restaurant-tip-under-total'))).run();
  const second = await world(seeded(sampleAnswer('restaurant-tip-under-total'))).run();
  assert.deepEqual(first, second);
});

test("the line (§3.E): 'Checks passed', or what was found, in §2.6's words, joined by commas", () => {
  assert.equal(
    checkedSummary(documentOf(check(sampleAnswer('restaurant-tip-under-total')))),
    'Tip added to the total',
  );
  const many = documentOf(
    check(
      bill({
        currency: 'XYZ',
        total: 999,
        uncertainFields: ['total', 'documentDate', 'vendorName'],
      }),
    ),
  );
  assert.equal(
    checkedSummary(many),
    "Totals don't add up, unclear: total, seller +1, currency not recognised",
  );
  assert.equal(checkedSummary(documentOf(check(statement()))), 'Checks passed');
  assert.equal(checkedSummary(documentOf(check(creditNote()))), 'Checks passed');
  const said = checkedSummary(documentOf(check(sampleAnswer('handwritten-cash-receipt'))));
  assert.equal(said, 'Total not checked');
});

test("every sample's expected answer, run through check-document, takes the route its expected.json names", () => {
  assert.deepEqual(
    Object.keys(SAMPLE_ROUTES),
    SAMPLES.map((sample) => sample.name),
  );
  for (const sample of SAMPLES) {
    const outcome = check(sample.answer);
    const [route, findings] = SAMPLE_ROUTES[sample.name]!;
    if (outcome.outcome === 'failed') {
      assert.equal(outcome.rule, route, sample.name);
      continue;
    }
    assert.equal(outcome.recordingRule ?? outcome.document.route, route, sample.name);
    assert.deepEqual(outcome.document.findings, findings, sample.name);
    const said = JSON.stringify([outcome.document, checkedSummary(outcome.document)]);
    assert.ok(
      !said.includes(sample.marker),
      `${sample.name}: the marker reached the state or line`,
    );
  }
});

test('across the steps: a document that cannot be used fails after one read; one QuickBooks cannot take is saved, before decide', async () => {
  // A bank statement: C1 at check-document, one read, nothing more.
  const bank = setUp({ through: 'all' });
  bank.platform.model = reads(bill({ documentType: 'bank_statement' }));
  assert.deepEqual(await bank.run(), { outcome: 'failed', failureReason: RUN_FAILS.C1 });
  assert.equal(bank.platform.modelCalls.length, 1);
  // Cash back on a receipt printed in euros: check-document's C16 before decide's F1 — saved, one read.
  const euros = setUp({ through: 'all' });
  euros.platform.model = reads(receipt({ cashBackPrinted: true, currency: 'EUR' }));
  const result = await euros.run();
  assert.equal(result.outcome, 'success');
  assert.equal(
    result.outcome === 'success' ? result.summary : '',
    'Saved. Not recorded in QuickBooks: it includes cash back.',
  );
  assert.equal(euros.platform.modelCalls.length, 1, 'read 1 only');
});
