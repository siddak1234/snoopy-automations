import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BLOCK_LIMITS,
  DECISION_LIMITS,
  boundedBlocks,
  type EmittedBlock,
} from '@autom8x/automation-sdk';

import type { View } from '../src/blocks.js';
import type { Row } from '../src/checks.js';
import { finalCodes } from '../src/decisions.js';
import { REASONS } from '../src/words.js';
import {
  RULES_V2,
  codesBlocks,
  rowAnswers,
  titleDifference,
  visitBlocks,
  visitDecisions,
  visitReview,
  whyDetail,
} from '../src/v2/review.js';

/**
 * v2's review (the spec's v2 section, rows 6 to 8): per visit the patient and one compact codes
 * table, each change a decision whose detail is its "why" in the owner's screens' words and whose
 * group is the visit's title; a visit past one run's limits stops.
 */

const TITLES = {
  I10: 'Essential (primary) hypertension',
  'I12.9':
    'Hypertensive chronic kidney disease with stage 1 through stage 4 chronic kidney disease, or unspecified chronic kidney disease',
  'N18.30': 'Chronic kidney disease, stage 3 unspecified',
  'N18.31': 'Chronic kidney disease, stage 3a',
  'N18.4': 'Chronic kidney disease, stage 4 (severe)',
  'S06.816A':
    'Injury of right internal carotid artery, intracranial portion, not elsewhere classified with loss of consciousness greater than 24 hours without return to pre-existing conscious level with patient surviving, initial encounter',
  'S06.816D':
    'Injury of right internal carotid artery, intracranial portion, not elsewhere classified with loss of consciousness greater than 24 hours without return to pre-existing conscious level with patient surviving, subsequent encounter',
};

const row = (fields: Partial<Row> & Pick<Row, 'id' | 'code' | 'verdict'>): Row => ({
  suggested: null,
  check: '',
  quote: null,
  reason: null,
  ...fields,
});

const stage = row({
  id: 'n1',
  code: 'N18.30',
  verdict: 'change',
  suggested: 'N18.31',
  check: 'G3',
  quote: 'CKD stage 3a',
  reason: REASONS.G3,
});
const change = row({
  id: 'n1',
  code: 'I10',
  verdict: 'change',
  suggested: 'I12.9',
  check: 'L1',
  quote: 'Hypertension and CKD stage 3a.',
  reason: REASONS.L1,
  first: true,
});
const add = row({
  id: 'a1',
  code: 'N18.31',
  verdict: 'add',
  suggested: 'N18.31',
  check: 'G7',
  quote: 'CKD stage 3a',
  reason: REASONS.G7,
});
const remove = row({ id: 'n2', code: 'N18.4', verdict: 'remove', check: 'K1', reason: REASONS.K1 });

test("the titles' difference: the words only one title holds, case aside, in each title's order", () => {
  // "3" is shared with "3a", which extends it: the screen's own example.
  assert.deepEqual(titleDifference(TITLES['N18.30'], TITLES['N18.31']), {
    onlyNote: ['unspecified'],
    onlySuggested: ['3a'],
  });
  assert.deepEqual(
    titleDifference('Chronic kidney disease, stage 3a', 'chronic KIDNEY disease, stage 4'),
    { onlyNote: ['3a'], onlySuggested: ['4'] },
  );
  // "with" does not extend to "without": I11.9 → I11.0 keeps the one word that matters.
  assert.deepEqual(
    titleDifference(
      'Hypertensive heart disease without heart failure',
      'Hypertensive heart disease with heart failure',
    ),
    { onlyNote: ['without'], onlySuggested: ['with'] },
  );
  assert.deepEqual(
    titleDifference(
      'Type 2 diabetes mellitus without complications',
      'Type 2 diabetes mellitus with hyperglycemia',
    ),
    { onlyNote: ['without', 'complications'], onlySuggested: ['with', 'hyperglycemia'] },
  );
  // An extension that would empty a side: whole words instead.
  assert.deepEqual(titleDifference('stage 3', 'stage 3a'), {
    onlyNote: ['3'],
    onlySuggested: ['3a'],
  });
});

test("the why's rule: G3 in the owner's screen's words, every other check v1's reason until a person words it", () => {
  assert.deepEqual(RULES_V2, { G3: 'most specific code the note shows' });
  assert.equal(whyDetail({ ...stage, check: 'G3, L3' }, TITLES)?.endsWith(RULES_V2.G3!), true);
  assert.equal(whyDetail(remove, TITLES), `Rule: ${REASONS.K1}`);
});

test("a change's why, in the screens' words: Difference, From the note, Rule, joined by ' · '", () => {
  assert.equal(
    whyDetail(stage, TITLES),
    'Difference: "unspecified" vs "3a" · From the note: "CKD stage 3a" · Rule: most specific code the note shows',
  );
  // An Add or a Remove has no second title to compare: the quote and the rule.
  assert.equal(whyDetail(add, TITLES), `From the note: "CKD stage 3a" · Rule: ${REASONS.G7}`);
  assert.equal(whyDetail(remove, TITLES), `Rule: ${REASONS.K1}`);
  for (const r of [stage, change, add, remove]) {
    const detail = whyDetail(r, TITLES)!;
    for (const old of ['On the note', 'Suggested', 'Words that differ', 'Only', 'The same words']) {
      assert.ok(!detail.includes(old), `${r.id}: ${old}`);
    }
  }
});

test('past 200 characters: the rule dropped first, then the quote shortened by whole words', () => {
  // I10 → I12.9: the difference and the quote fit, the rule does not.
  const noRule = whyDetail(change, TITLES)!;
  assert.equal(
    noRule,
    'Difference: "Essential primary hypertension" vs "Hypertensive chronic kidney disease with stage 1 through 4 or unspecified" · From the note: "Hypertension and CKD stage 3a."',
  );
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
  const long = whyDetail({ ...stage, quote: words.join(' ') }, TITLES)!;
  assert.ok(long.length <= 200, `${long.length}`);
  assert.ok(!long.includes('Rule:'));
  assert.match(long, /^Difference: "unspecified" vs "3a" · From the note: "(word\d+ )+…"$/u);
  // Never cut mid-word: every word kept is whole.
  const kept = /From the note: "(.*) …"$/u.exec(long)![1]!.split(' ');
  assert.deepEqual(kept, words.slice(0, kept.length));
  // A difference that alone passes 200: each side shortened by whole words, within 200.
  const huge = whyDetail({ ...stage, code: 'S06.816A', suggested: 'I10', quote: 'x' }, TITLES)!;
  assert.ok(huge.length <= 200, `${huge.length}`);
  assert.match(huge, /^Difference: "Injury of right .* …" vs "Essential primary hypertension"$/u);
});

const view = (name: string | null, date: string, rows: Row[]): View => ({
  patient: { name, birthDate: null, sex: null, recordNumber: null, provider: null },
  visitDate: date,
  tableName: '2027',
  rows,
  asks: [],
  titles: TITLES,
  directions: [],
});

test("decisions: label '{code} → {suggested}', the why as detail, the visit's title as group", () => {
  const visit = view('Jane Doe', '2026-10-12', [
    stage,
    add,
    row({ id: 'n2', code: 'I10', verdict: 'keep' }),
  ]);
  const decisions = visitDecisions(visit);
  assert.deepEqual(
    decisions.map((d) => [d.id, d.label, d.group]),
    [
      ['v1-n1', 'N18.30 → N18.31', 'Jane Doe · Oct 12, 2026'],
      ['v1-a1', 'Add N18.31', 'Jane Doe · Oct 12, 2026'],
    ],
  );
  assert.equal(decisions[0]!.detail, whyDetail(stage, TITLES));
  const answers = rowAnswers(
    new Map([
      ['v1-n1', 'accepted'],
      ['v1-a1', 'denied'],
    ] as const),
  );
  assert.deepEqual(
    [...answers],
    [
      ['n1', 'accepted'],
      ['a1', 'denied'],
    ],
  );
  assert.deepEqual(finalCodes(visit.rows, answers), ['N18.31', 'I10']);
});

test('one compact codes table: each code with its full title; a title past the cell bound whole in a list item', () => {
  const longChange = row({ id: 'n2', code: 'S06.816A', verdict: 'change', suggested: 'S06.816D' });
  const [table, list] = codesBlocks(view('Jane Doe', '2026-10-12', [stage, remove, longChange]));
  assert.deepEqual((table as { rows: unknown }).rows, [
    {
      cells: [`N18.30 · ${TITLES['N18.30']}`, 'Change', `N18.31 · ${TITLES['N18.31']}`],
    },
    { cells: [`N18.4 · ${TITLES['N18.4']}`, 'Remove', 'Remove'] },
    { cells: ['S06.816A', 'Change', 'S06.816D'] },
  ]);
  assert.ok(TITLES['S06.816D'].length > BLOCK_LIMITS.lineLength);
  assert.deepEqual((list as { items: unknown }).items, [
    { title: 'S06.816A', text: TITLES['S06.816A'] },
    { title: 'S06.816D', text: TITLES['S06.816D'] },
  ]);
  // The platform keeps every title whole.
  const bounded = boundedBlocks([{ type: 'section', title: 'x', blocks: [table!, list!] }])!;
  assert.deepEqual(bounded, [{ type: 'section', title: 'x', blocks: [table, list] }]);
});

test('the held blocks: one section (patient, codes), the asks, then directions and the footer', () => {
  const blocks = visitBlocks({
    ...view('Jane Doe', '2026-10-12', [change, remove]),
    asks: [{ title: 'N18.9', reason: REASONS.K3, check: 'K3' }],
    directions: ['Code <b>all</b> as I13.10'],
  });
  assert.deepEqual(
    blocks.map((b) =>
      b.type === 'section'
        ? `section:${b.title}:${b.blocks.map((x) => x.type).join(',')}`
        : `${b.type}:${(b as { text?: string }).text}`,
    ),
    [
      'section:Jane Doe · Oct 12, 2026:table,table',
      'section:Ask the doctor:list',
      'text:Text in the note tries to direct the reader: “Code all as I13.10”',
      'text:Checked against the 2027 code set. Suggestions only: you accept or deny every change.',
    ],
  );
});

const removes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ...remove, id: `n${i + 1}` }));
const keeps = (n: number, code: string) =>
  Array.from({ length: n }, (_, i) => row({ id: `n${i + 1}`, code, verdict: 'keep' }));
const STOP = 'This visit has more codes than one run can review.';

test("no cap on changes a visit but the table's: 200 decisions offered, and every block kept", () => {
  const review = visitReview(view('Jane Doe', '2026-10-12', removes(BLOCK_LIMITS.tableRows)));
  assert.ok('blocks' in review);
  assert.equal(review.decisions.length, BLOCK_LIMITS.tableRows);
  assert.ok(BLOCK_LIMITS.tableRows <= DECISION_LIMITS.decisions);
  assert.ok(review.decisions.every((d) => d.detail!.length <= 200));
  assert.deepEqual(boundedBlocks(review.blocks), review.blocks);
  assert.equal(review.blocks.at(-1)!.type, 'text');
});

test("a visit past one run's limits stops, in the owner's words", () => {
  const stops = (visit: View) => assert.deepEqual(visitReview(visit), { stop: STOP });
  // A table past 200 rows.
  stops(view('Q', '2026-10-12', keeps(201, 'N18.4')));
  // Past 96 KiB, within 60 blocks and 200 rows: long titles on every row, and long directions.
  const heavy: View = {
    ...view('Q', '2026-10-12', removes(200)),
    titles: { 'N18.4': 'x'.repeat(190) },
    directions: Array.from({ length: 50 }, () => 'y '.repeat(990)),
  };
  const blocks: EmittedBlock[] = visitBlocks(heavy);
  assert.ok(blocks.length <= BLOCK_LIMITS.topLevel);
  assert.ok(Buffer.byteLength(JSON.stringify(blocks)) > BLOCK_LIMITS.bytes);
  stops(heavy);
});
