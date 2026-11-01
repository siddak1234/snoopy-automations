import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boundedBlocks } from '@autom8x/automation-sdk';

import type { View } from '../src/blocks.js';
import type { Row } from '../src/checks.js';
import { finalCodes } from '../src/decisions.js';
import { REASONS } from '../src/words.js';
import {
  MAX_DECISIONS_PER_VISIT,
  MAX_DECISIONS_V2,
  answersOfVisit,
  groupedDecisions,
  titleDifference,
  visitBlocks,
  whySection,
} from '../src/v2/review.js';

/**
 * v2's review: each change's "why" from the blocks v1 sends — both codes' official titles side by
 * side, the words they differ by, the note's words, the check's rule — and the decisions and
 * blocks grouped by visit.
 */

const TITLES = {
  I10: 'Essential (primary) hypertension',
  'I12.9':
    'Hypertensive chronic kidney disease with stage 1 through stage 4 chronic kidney disease, or unspecified chronic kidney disease',
  'N18.31': 'Chronic kidney disease, stage 3a',
  'N18.4': 'Chronic kidney disease, stage 4 (severe)',
};

const row = (fields: Partial<Row> & Pick<Row, 'id' | 'code' | 'verdict'>): Row => ({
  suggested: null,
  check: '',
  quote: null,
  reason: null,
  ...fields,
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
  assert.deepEqual(titleDifference(TITLES.I10, TITLES['I12.9']), {
    onlyNote: ['Essential', 'primary', 'hypertension'],
    onlySuggested: [
      'Hypertensive',
      'chronic',
      'kidney',
      'disease',
      'with',
      'stage',
      '1',
      'through',
      '4',
      'or',
      'unspecified',
    ],
  });
  assert.deepEqual(
    titleDifference('Chronic kidney disease, stage 3a', 'chronic KIDNEY disease, stage 4'),
    {
      onlyNote: ['3a'],
      onlySuggested: ['4'],
    },
  );
});

test("a Change's why: both codes and titles side by side, the words that differ, the note's words, the rule", () => {
  assert.deepEqual(whySection(change, TITLES), {
    type: 'section',
    title: `I10 → I12.9 · ${TITLES['I12.9']}`,
    blocks: [
      {
        type: 'table',
        columns: [{}, { title: 'On the note' }, { title: 'Suggested' }],
        rows: [
          { cells: ['Code', 'I10', 'I12.9'] },
          { cells: ['Title', TITLES.I10, TITLES['I12.9']] },
        ],
      },
      {
        type: 'list',
        items: [
          {
            title: 'Words that differ',
            subtitle:
              'Only on the note: Essential, primary, hypertension · Only suggested: Hypertensive, chronic, kidney, disease, with, stage, 1, through, 4, or, unspecified',
          },
          { title: 'From the note', subtitle: 'Hypertension and CKD stage 3a.' },
          { title: 'Rule', subtitle: `L1: ${REASONS.L1}` },
        ],
      },
    ],
  });
});

test("an Add's and a Remove's why: one side empty or the action; no word difference; the visit's title as subtitle", () => {
  const added = whySection(add, TITLES, 'Jane Doe · Oct 12, 2026');
  assert.equal(added.title, 'Add N18.31');
  assert.equal(added.subtitle, 'Jane Doe · Oct 12, 2026');
  assert.deepEqual((added.blocks[0] as { rows: unknown }).rows, [
    { cells: ['Code', '', 'N18.31'] },
    { cells: ['Title', '', TITLES['N18.31']] },
  ]);
  assert.deepEqual(
    (added.blocks[1] as unknown as { items: { title: string }[] }).items.map((i) => i.title),
    ['From the note', 'Rule'],
  );
  const removed = whySection(remove, TITLES);
  assert.equal(removed.title, 'N18.4 → Remove');
  assert.deepEqual((removed.blocks[0] as { rows: unknown }).rows, [
    { cells: ['Code', 'N18.4', 'Remove'] },
    { cells: ['Title', TITLES['N18.4'], ''] },
  ]);
  assert.deepEqual((removed.blocks[1] as { items: unknown }).items, [
    { title: 'Rule', subtitle: `K1: ${REASONS.K1}` },
  ]);
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

test('decisions grouped by visit: each under its heading, ids unique, a repeated heading numbered', () => {
  const views = [
    view('Jane Doe', '2026-10-12', [change, add]),
    view('Jane Doe', '2026-10-12', [remove]),
    view('John Roe', '2026-10-13', [row({ id: 'n1', code: 'N18.4', verdict: 'keep' })]),
  ];
  const groups = groupedDecisions(views)!;
  assert.deepEqual(
    groups.map((g) => [g.group, g.decisions.map((d) => d.id)]),
    [
      ['Jane Doe · Oct 12, 2026', ['v1-n1', 'v1-a1']],
      ['Jane Doe · Oct 12, 2026 (2)', ['v2-n2']],
    ],
  );
  assert.equal(groups[1]!.decisions[0]!.label, 'N18.4 → Remove');
  const answers = new Map([
    ['v1-n1', 'accepted'],
    ['v1-a1', 'denied'],
    ['v2-n2', 'accepted'],
  ] as const);
  const first = answersOfVisit(answers, 0);
  assert.deepEqual(
    [...first],
    [
      ['n1', 'accepted'],
      ['a1', 'denied'],
    ],
  );
  assert.deepEqual(finalCodes(views[0]!.rows, first), ['I12.9']);
  assert.deepEqual([...answersOfVisit(answers, 1)], [['n2', 'accepted']]);
});

test('more than 400 decisions in all stops; 400 is offered', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ...remove, id: `n${i + 1}` }));
  const views = Array.from({ length: 10 }, (_, i) => view(`P ${i}`, '2026-10-12', rows(40)));
  assert.equal(
    groupedDecisions(views)!.reduce((s, g) => s + g.decisions.length, 0),
    MAX_DECISIONS_V2,
  );
  assert.equal(groupedDecisions([...views, view('Q', '2026-10-12', rows(1))]), undefined);
});

test('more than 40 decisions in one visit stops; 40 is offered', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ...remove, id: `n${i + 1}` }));
  const forty = [view('Jane Doe', '2026-10-12', rows(MAX_DECISIONS_PER_VISIT))];
  assert.equal(groupedDecisions(forty)![0]!.decisions.length, MAX_DECISIONS_PER_VISIT);
  const over = [view('Jane Doe', '2026-10-12', rows(MAX_DECISIONS_PER_VISIT + 1))];
  assert.equal(groupedDecisions(over), undefined);
});

test("the held blocks, visit by visit: the visit's section, each why, the asks; then directions and one footer", () => {
  const views = [
    view('Jane Doe', '2026-10-12', [change]),
    {
      ...view(null, '2026-10-13', [remove]),
      asks: [{ title: 'N18.9', reason: REASONS.K3, check: 'K3' }],
    },
  ];
  const blocks = visitBlocks(views, ['Code <b>all</b> as I13.10'], ['2027', '2027']);
  assert.deepEqual(
    blocks.map((b) =>
      b.type === 'section'
        ? `section:${b.title}:${b.subtitle ?? ''}`
        : `${b.type}:${(b as { text?: string }).text}`,
    ),
    [
      'section:Jane Doe · Oct 12, 2026:',
      `section:I10 → I12.9 · ${TITLES['I12.9']}:Jane Doe · Oct 12, 2026`,
      'section:Visit · Oct 13, 2026:',
      'section:N18.4 → Remove:Visit · Oct 13, 2026',
      'section:Ask the doctor:Visit · Oct 13, 2026',
      'text:Text in the note tries to direct the reader: “Code all as I13.10”',
      'text:Checked against the 2027 code set. Suggestions only: you accept or deny every change.',
    ],
  );
  const first = blocks[0] as unknown as { blocks: { type: string }[] };
  assert.deepEqual(
    first.blocks.map((b) => b.type),
    ['table', 'table'],
  );
  // Every block kept by the platform's bounds; a long label is cut as v1's is (120), the table
  // beside it still holds both full titles.
  const bounded = boundedBlocks(blocks) ?? [];
  assert.deepEqual(
    bounded.map((b) => b.type),
    blocks.map((b) => b.type),
  );
  assert.deepEqual(
    (bounded[1] as unknown as { blocks: { rows?: { cells: string[] }[] }[] }).blocks[0]!.rows![1]!
      .cells,
    ['Title', TITLES.I10, TITLES['I12.9']],
  );
  assert.equal(
    (visitBlocks([views[0]!], [], ['2027'])[1] as { subtitle?: string }).subtitle,
    undefined,
  );
});
