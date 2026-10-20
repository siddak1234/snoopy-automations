import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { PROVIDER_REFUSALS, QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import type { JsonObject, RunResult } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { NOT_RECORDED, UNCONFIRMED_LINE } from '../src/quickbooks-path.js';
import { partAnswerOf } from '../src/run/answer.js';
import { FINDING_WORDS } from '../src/run/check.js';
import { DOUBTS, NO_RECORD_FOR, approvalReason, readLine } from '../src/run/words.js';
import { LINE_MAXIMUM, RESULTS, RUN_FAILS, lineWith } from '../src/words.js';
import {
  GOOD_ANSWER,
  NONE,
  QUICKBOOKS,
  documentAnswer,
  lines,
  manifestsRoot,
  partAnswer,
  reads,
  setUp,
} from './fixtures.js';
import { seededCompany } from './lookups-world.js';
import { SAMPLES } from './sample-maker/samples.js';

/**
 * Guards A6 and A8 — the words a person reads (v2's §3.E, §3.F; the owner's "short, plain, no
 * codes"): no reason code — `(recipient_inside_workspace)`, `qb_refused`, `HTTP 503` — in any
 * sentence, reason, line, approval reason, document status or detail, on either path; every
 * timeline line at most 80 characters; no mail sent by the run (the platform sends the results:
 * AM3, whose recipients Build 22's D1 changed); and the old name, "Bills & Receipts", nowhere in
 * v3's or v4's code, manifest or image.
 */

/** A code as a person must never read it: snake_case, an HTTP status, or a code in brackets. */
const CODE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\bHTTP \d{3}\b|\([^)\s]*[_\d][^)\s]*\)/u;

const plain = (text: string, label: string) =>
  assert.ok(!CODE.test(text), `${label}: "${text}" carries a code`);

test("the spec's sentences, reasons and phrases are plain: no code, a sentence ends with a full stop, a reason does not", () => {
  for (const [key, sentence] of Object.entries(RUN_FAILS)) {
    plain(sentence, key);
    assert.match(sentence, /^[A-Z].*\.$/u, key);
  }
  for (const [key, reason] of Object.entries(NOT_RECORDED)) {
    plain(reason, key);
    assert.match(reason, /^[a-zA-Z].*[^.]$/u, key);
    plain(RESULTS.notRecorded(reason), key);
  }
  plain(UNCONFIRMED_LINE, 'unconfirmed');
  plain(RESULTS.unconfirmed, 'unconfirmed');
  plain(RESULTS.saved('Harrowgate Office Supply', '$1.00'), 'saved');
  plain(RESULTS.recorded('vendor credit', 'Harrowgate Office Supply', '$1.00'), 'recorded');
  plain(RESULTS.compared(2), 'compared');
  for (const [finding, words] of Object.entries(FINDING_WORDS)) {
    plain(words({ unclearFields: ['total', 'documentDate'] } as never), finding);
  }
  // A doubt, a reason QuickBooks keeps none, and the approval's reason: plain, a phrase.
  for (const [key, doubt] of Object.entries({ ...DOUBTS, ...NO_RECORD_FOR })) plain(doubt, key);
  plain(approvalReason([{ index: 2, reason: DOUBTS.C11 }]), 'approval');
});

test("the approval's reason names each waiting document, a sentence each — or, past 200 characters, counts them (B4)", () => {
  assert.equal(
    approvalReason([
      { index: 1, reason: DOUBTS.C11 },
      { index: 3, reason: DOUBTS.not_financial },
    ]),
    "Document 1: the total can't be read. Document 3: this doesn't look like a bill, receipt or invoice.",
  );
  const many = Array.from({ length: 8 }, (_, at) => ({ index: at + 1, reason: DOUBTS.C21 }));
  assert.equal(approvalReason(many), '8 documents need approval.');
  assert.equal(
    approvalReason([{ index: 1, reason: 'x'.repeat(250) }]),
    '1 document needs approval.',
  );
});

test('a line naming a long seller fits 80 characters: the name shortened, the total whole', () => {
  const long = `Harrowgate ${'Office '.repeat(60)}Supply`;
  for (const line of [
    lineWith('Saved: ', long, ', $1,234,567.89'),
    lineWith('QuickBooks: ', long),
    readLine(
      partAnswerOf(
        partAnswer([
          documentAnswer({
            ...GOOD_ANSWER,
            documentType: 'credit_note',
            vendorName: long,
            total: 1_234_567.89,
            currency: 'CAD',
          }),
        ]),
      )?.documents ?? [],
    ),
  ]) {
    assert.ok(line.length <= LINE_MAXIMUM, `${line.length}: ${line}`);
    assert.match(line, /^(Saved: |QuickBooks: |Read: credit note from )Harrowgate Office/u);
    assert.ok(line.includes('…'), line);
  }
  assert.match(lineWith('Saved: ', long, ', $1,234,567.89'), /…, \$1,234,567\.89$/u);
  assert.equal(
    lineWith('Saved: ', 'Tidewell Hardware', ', $60.63'),
    'Saved: Tidewell Hardware, $60.63',
  );
});

/**
 * Every word a run gave a person in its own voice: its lines, its result or failure, its approval
 * reason, each document's status and details. What a document says it read is the document's.
 */
function wordsOf(steps: readonly { summary: string; heldReason?: string }[], result: RunResult) {
  const said: [string, string][] = steps.map((step) => ['line', step.summary]);
  for (const step of steps) if (step.heldReason) said.push(['approval', step.heldReason]);
  if (result.outcome === 'failed') said.push(['failure', result.failureReason]);
  if (result.outcome === 'held') said.push(['approval', result.held.reason]);
  if (result.outcome === 'success') said.push(['result', result.summary ?? '']);
  if (result.outcome !== 'failed') {
    for (const document of result.documents ?? []) {
      said.push(['status', document.statusText]);
      for (const detail of document.details) {
        said.push(['detail', `${detail.label}: ${detail.value}`]);
      }
    }
  }
  return said;
}

/** Each create answering as `answer` says, whatever the record. */
const everyCreate =
  (answer: { status: number; body?: JsonObject }) =>
  (sim: QuickBooksSimulator): void => {
    for (const operation of ['bill.create', 'purchase.create', 'vendorCredit.create'] as const) {
      sim.script(operation, [answer]);
    }
  };

/** Ways QuickBooks fails a run on purpose: each must still read plain. */
const QUICKBOOKS_FAILS: readonly [string, (sim: QuickBooksSimulator) => void][] = [
  ['as it is', () => undefined],
  [
    'not connected',
    (sim) => sim.script('companyInfo.get', [{ refuse: PROVIDER_REFUSALS.notConnected() }]),
  ],
  [
    'closed books',
    everyCreate({
      status: 400,
      body: { Fault: { Error: [{ code: '6210', Message: 'x (y_z)' }], type: 'ValidationFault' } },
    }),
  ],
  ['a write not confirmed', everyCreate({ status: 503 })],
];

test('no code reaches anything a run says, on either path, for every sample and the ways QuickBooks fails; every line fits 80 characters', async () => {
  let runs = 0;
  const results = new Set<string>();
  for (const sample of SAMPLES) {
    for (const [how, company] of [['none', undefined], ...QUICKBOOKS_FAILS] as const) {
      const simulator = seededCompany(new QuickBooksSimulator({ refusal: refusalFixture }));
      simulator.expenseAmountSearchable = true;
      company?.(simulator);
      const world = setUp({
        simulator,
        through: 'all',
        config: how === 'none' ? NONE : QUICKBOOKS,
      });
      world.platform.model = reads(sample.answer);
      const result = await world.run();
      const label = `${sample.name}, ${how}`;
      if (result.outcome === 'success') results.add(result.summary ?? '');
      for (const [kind, text] of wordsOf(world.platform.steps, result)) {
        plain(text, `${label} (${kind})`);
      }
      for (const [stepId, , summary] of lines(world.platform)) {
        assert.ok(summary.length <= LINE_MAXIMUM, `${label}: ${stepId} "${summary}"`);
      }
      assert.deepEqual(world.platform.mails, [], `${label}: the run sends no mail (AM3)`);
      runs += 1;
    }
  }
  assert.equal(runs, SAMPLES.length * (QUICKBOOKS_FAILS.length + 1));
  // Each way was met: saved, recorded, compared, not recorded, not confirmed.
  for (const said of [
    RESULTS.unconfirmed,
    RESULTS.notRecorded(NOT_RECORDED.not_connected),
    RESULTS.notRecorded(NOT_RECORDED.closed_books),
    'Recorded in QuickBooks: bill from Harrowgate Office Supply, $413.34.',
    'Saved: Harrowgate Office Supply, $413.34.',
  ]) {
    assert.ok(results.has(said), said);
  }
});

/** Every file under a directory. */
function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('the old name, "Bills & Receipts", is nowhere in v3, v4 or v5: its code, its manifests, its image, its package', () => {
  const root = resolve(import.meta.dirname, '..');
  const files = [
    ...filesUnder(join(root, 'src')),
    ...filesUnder(join(root, 'scripts')),
    join(root, 'Dockerfile'),
    join(root, 'package.json'),
    join(manifestsRoot, 'invoice-processing.v3.json'),
    join(manifestsRoot, 'invoice-processing.v4.json'),
    join(manifestsRoot, 'invoice-processing.v5.json'),
    join(manifestsRoot, 'invoice-processing.v6.json'),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/Bills\s*(?:&|&amp;|and)\s*Receipts/u.test(text), file);
  }
  assert.ok(files.length > 50, `${files.length} files read`);
});
