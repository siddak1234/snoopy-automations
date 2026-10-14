import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { PROVIDER_REFUSALS, QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import type { JsonObject, RunResult } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { FINDING_WORDS } from '../src/steps/check-document.js';
import { NOT_RECORDED, UNCONFIRMED_LINE } from '../src/quickbooks-path.js';
import { readLine } from '../src/steps/extract.js';
import { LINE_MAXIMUM, RESULTS, RUN_FAILS, lineWith } from '../src/words.js';
import { NONE, QUICKBOOKS, lines, manifestsRoot, reads, setUp } from './fixtures.js';
import { seededCompany } from './lookups-world.js';
import { SAMPLES } from './sample-maker/samples.js';

/**
 * Guards A6 and A8 — the words a person reads (v2's §3.E, §3.F; the owner's "short, plain, no
 * codes"): no reason code — `(recipient_inside_workspace)`, `qb_refused`, `HTTP 503` — in any
 * sentence, reason, line, approval reason or detail, on either path; every timeline line at most
 * 80 characters; and the old name, "Bills & Receipts", nowhere in v2's code, manifest or image.
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
});

test('a line naming a long seller fits 80 characters: the name shortened, the total whole', () => {
  const long = `Harrowgate ${'Office '.repeat(60)}Supply`;
  for (const line of [
    lineWith('Saved: ', long, ', $1,234,567.89'),
    lineWith('QuickBooks: ', long),
    readLine({
      documentType: 'credit_note',
      vendorName: long,
      total: 1_234_567.89,
      currency: 'CAD',
    }),
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

/** Every word a run gave a person: its lines, its result or failure, its approval reason, its details. */
function wordsOf(steps: readonly { summary: string; heldReason?: string }[], result: RunResult) {
  const said: [string, string][] = steps.map((step) => ['line', step.summary]);
  for (const step of steps) if (step.heldReason) said.push(['approval', step.heldReason]);
  if (result.outcome === 'failed') said.push(['failure', result.failureReason]);
  if (result.outcome === 'held') said.push(['approval', result.held.reason]);
  if (result.outcome === 'success') {
    said.push(['result', result.summary ?? '']);
    for (const detail of result.details ?? []) {
      said.push(['detail', `${detail.label}: ${detail.value}`]);
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
        config: how === 'none' ? NONE : { ...QUICKBOOKS, notifyEmail: 'books@example.com' },
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
      for (const mail of world.platform.mails)
        plain(`${mail.subject}\n${mail.body}`, `${label} (mail)`);
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

test('the old name, "Bills & Receipts", is nowhere in v2: its code, its manifest, its image, its package', () => {
  const root = resolve(import.meta.dirname, '..');
  const files = [
    ...filesUnder(join(root, 'src')),
    ...filesUnder(join(root, 'scripts')),
    join(root, 'Dockerfile'),
    join(root, 'package.json'),
    join(manifestsRoot, 'invoice-processing.v2.json'),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/Bills\s*(?:&|&amp;|and)\s*Receipts/u.test(text), file);
  }
  assert.ok(files.length > 50, `${files.length} files read`);
});
