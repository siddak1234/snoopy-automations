import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { checkedSummary } from '../src/run/check.js';
import { runStateOf, type Entry } from '../src/run/state.js';
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
import { NONE, QUICKBOOKS, lines, reads, setUp } from './fixtures.js';
import { SAMPLES } from './sample-maker/samples.js';
import { SAMPLE_ROUTES } from './sample-routes.js';

/**
 * `check-documents` on the SDK's runner, for a file of one document: what it keeps of each
 * document's state, its timeline line, the run's clock, and every made-up sample's expected answer
 * routed as the plan says — a document the checks cannot use as read left for the second read and
 * never failing the run (B4), one QuickBooks cannot record going on, its details to be saved (v2's
 * §2.6), and any other financial document kept as read (AM8).
 */

/** A run through check-documents on one document's answer; its one entry and its line. */
async function checked(
  answer: JsonObject,
  config: JsonObject = QUICKBOOKS,
  now = Date.parse('2026-10-11T12:00:00Z'),
) {
  const world = setUp({ through: 'check-documents', config, now });
  world.platform.model = reads(answer);
  const result: RunResult = await world.run();
  assert.ok(result.outcome === 'success', JSON.stringify(result).slice(0, 300));
  const run = runStateOf(result.output ?? {});
  assert.ok(run);
  const entry = run.documents[0] as Entry;
  return { world, result, entry, line: lines(world.platform).at(-1) };
}

test("the first read stays for the second; the cleaned document joins the document's state; no call", async () => {
  const { world, entry, line } = await checked(bill());
  assert.ok(entry.answer, "the first read kept until decide, for a second read's gaps");
  assert.deepEqual(entry.engine.document, documentOf(check(bill())));
  assert.equal(entry.engine.quickBooks, undefined);
  assert.deepEqual(
    [world.platform.providerCalls, world.platform.mails],
    [[], []],
    'no QuickBooks call, no mail',
  );
  assert.equal(world.platform.modelCalls.length, 1, 'the first read alone');
  assert.deepEqual(line, ['check-documents', 'ok', 'Checks passed']);
});

test('a document the checks cannot use as read is left for the second read, its words its line; the run goes on (B4)', async () => {
  const { entry, line } = await checked(bill({ total: null }));
  assert.equal(entry.unsettled, 'C11');
  assert.deepEqual(entry.engine, {});
  assert.deepEqual(line, ['check-documents', 'ok', "The total can't be read"]);
});

test('a document QuickBooks cannot record goes on: not recorded, its reason in its state for the steps after', async () => {
  const { entry, line } = await checked(receipt({ cashBackPrinted: true }));
  assert.deepEqual(entry.engine.quickBooks, { notRecorded: 'it includes cash back' });
  assert.ok(entry.engine.document, 'the document kept, for its details');
  assert.deepEqual(line, [
    'check-documents',
    'ok',
    'Not recorded in QuickBooks: it includes cash back',
  ]);
});

test('with the vendor "None" no recording rule is weighed', async () => {
  const { entry, line } = await checked(receipt({ cashBackPrinted: true }), NONE);
  assert.equal(entry.engine.quickBooks, undefined);
  assert.deepEqual(line, ['check-documents', 'ok', 'Checks passed']);
});

test("the run's clock: a document dated tomorrow passes, two days ahead is not recorded, by the UTC date", async () => {
  const dated = (date: string) => bill({ documentDate: date, dueDate: null });
  const late = Date.parse('2026-10-10T23:59:00Z');
  const early = Date.parse('2026-10-11T00:01:00Z');
  const quickBooksOf = async (date: string, now: number) =>
    (await checked(dated(date), QUICKBOOKS, now)).entry.engine.quickBooks;
  assert.equal(await quickBooksOf('2026-10-11', late), undefined);
  assert.deepEqual(await quickBooksOf('2026-10-12', late), {
    notRecorded: "it's dated in the future",
  });
  assert.equal(await quickBooksOf('2026-10-12', early), undefined);
});

test('the same answer gives the same state: a run re-sent reaches it again', async () => {
  const first = await checked(sampleAnswer('restaurant-tip-under-total'));
  const second = await checked(sampleAnswer('restaurant-tip-under-total'));
  assert.deepEqual(first.entry, second.entry);
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

test("every sample's expected answer takes the route its expected.json names", () => {
  assert.deepEqual(
    Object.keys(SAMPLE_ROUTES),
    SAMPLES.map((sample) => sample.name),
  );
  for (const sample of SAMPLES) {
    const [route, findings] = SAMPLE_ROUTES[sample.name]!;
    // A bank or card statement is kept as read, never checked (AM8).
    if (route === 'kept') {
      assert.equal(sample.answer.documentType, 'bank_statement', sample.name);
      continue;
    }
    const outcome = check(sample.answer);
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

test('across the steps: a bank statement is saved after one read, never refused; one QuickBooks cannot take is saved, before decide', async () => {
  const bank = setUp({ through: 'all' });
  bank.platform.model = reads(bill({ documentType: 'bank_statement' }));
  const kept = await bank.run();
  assert.ok(kept.outcome === 'success', JSON.stringify(kept));
  assert.equal(
    kept.documents?.[0]?.statusText,
    'Saved. QuickBooks has no record for a bank statement.',
  );
  assert.equal(bank.platform.modelCalls.length, 1);
  assert.equal(bank.platform.providerCalls.length, 0, 'QuickBooks asked nothing for it');
  assert.notEqual(kept.summary, RUN_FAILS.other);
  // Cash back on a receipt printed in euros: the checks' C16 before decide's F1 — saved, one read.
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
