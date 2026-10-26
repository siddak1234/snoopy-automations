import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import type { EmittedBlock, EmittedLeaf, TableBlock } from '../src/block-types.js';
import { BLOCK_LIMITS as L, boundedBlocks, isBlockUrl } from '../src/blocks.js';
import { assertValid, validator } from './published-schemas.js';

/**
 * `boundedBlocks` against the platform's one rule for a result's blocks (its ADR-0048 decision 3,
 * `snoopy-backend/packages/contracts/src/blocks-validation.ts`): each string cut whole at its
 * bound, and what the platform would refuse left off or left out — never sent, since one refused
 * block refuses the whole result. Everything bounded here also validates against the published
 * `automation-run-result.json`, and stays within the two bounds no schema can say.
 */

const FILE = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';

/** A bounded block, read by path: the test reads what it names. */
type Json = Record<string, any>;

/** What a test hands in: anything, as a model's words or a careless cast could make it. */
const bound = (blocks: unknown[]): EmittedBlock[] | undefined =>
  boundedBlocks(blocks as EmittedBlock[]);

/** Sent as a success's blocks: valid by the schema, 300 in all at most, 96 KiB at most. */
function sendable(blocks: EmittedBlock[] | undefined): EmittedBlock[] {
  assert.ok(blocks !== undefined, 'something is left to send');
  assertValid(validator('automation-run-result'), { outcome: 'success', blocks }, 'the blocks');
  const total = blocks.reduce(
    (sum, b) => sum + 1 + (b.type === 'section' ? b.blocks.length : 0),
    0,
  );
  assert.ok(total <= L.total, `${total} blocks in all`);
  assert.ok(Buffer.byteLength(JSON.stringify(blocks)) <= L.bytes, 'within 96 KiB');
  return blocks;
}

const text = (value: string): unknown => ({ type: 'text', text: value });
const item = (fields: Record<string, unknown>): unknown => ({ type: 'list', items: [fields] });

test('each string is cut whole at its bound, a one-line field made one line, an empty one left off', () => {
  const [long, lines, list, badge, table] = sendable(
    bound([
      text('t'.repeat(2100)),
      text('  First line\r\nSecond\rThird\tand a tab  '),
      item({
        title: ` ${'x'.repeat(130)} `,
        subtitle: 'One\n  line',
        text: 'Kept\nbreaks',
        lead: ' ',
      }),
      { type: 'badge', text: `${'b'.repeat(39)}😀` },
      { type: 'table', columns: [{}, { title: '' }], rows: [{ cells: ['c'.repeat(250), ''] }] },
    ]),
  ) as Json[];
  assert.equal(long!.text.length, L.textLength);
  assert.equal(
    lines!.text,
    'First line\nSecond\nThird\tand a tab',
    'a line break kept, a CR made one',
  );
  assert.deepEqual(list!.items[0], {
    title: 'x'.repeat(L.titleLength),
    subtitle: 'One line',
    text: 'Kept\nbreaks',
  });
  assert.equal(badge!.text, 'b'.repeat(39), 'a cut never splits a pair');
  assert.deepEqual(table!.columns, [{}, {}]);
  assert.deepEqual(
    table!.rows[0].cells,
    ['c'.repeat(L.lineLength), ''],
    'a later cell may be empty',
  );
  assert.equal(bound([text(' \n '), item({ title: ' ' })])?.length, 1, 'an empty list stays');
});

test('anything shaped like an HTML tag is left off, or its row or block left out', () => {
  const kept = sendable(
    bound([
      text('<b>Hi</b>'),
      text('<!-- a comment'),
      text('1 < 2, and 3<4: no tag'),
      item({ title: 'Kept', subtitle: '</div>' }),
      item({ title: '<?xml version' }),
      { type: 'link', title: 'Help', url: 'https://example.com/?q=<script' },
      {
        type: 'table',
        columns: [{}, {}],
        rows: [{ cells: ['<i>', 'x'] }, { cells: ['Row', '<img src=x>'] }],
      },
    ]),
  );
  assert.deepEqual(kept, [
    { type: 'text', text: '1 < 2, and 3<4: no tag' },
    { type: 'list', items: [{ title: 'Kept' }] },
    { type: 'list', items: [] },
    { type: 'table', columns: [{}, {}], rows: [{ cells: ['Row', ''] }] },
  ]);
});

test('a control character is refused; a tab, and a line break where lines are kept, are not', () => {
  const kept = sendable(
    bound([
      text('bell\u0007'),
      text('nul\u0000'),
      text('next line\u0085'),
      text('escape\u001b[0m'),
      text('a\tb\nc'),
      { type: 'link', title: 'del\u007f', url: 'https://example.com' },
      item({ title: 'Row', text: 'vertical\u000btab' }),
    ]),
  );
  assert.deepEqual(kept, [
    { type: 'text', text: 'a\tb\nc' },
    { type: 'list', items: [{ title: 'Row' }] },
  ]);
});

test('half a surrogate pair is refused, and a whole one kept', () => {
  assert.deepEqual(sendable(bound([text('half \ud83d'), text('end \ude00'), text('whole 😀')])), [
    { type: 'text', text: 'whole 😀' },
  ]);
});

test('a url is kept only when https, with a host, and no user or password', () => {
  for (const kept of ['https://example.com/rules', 'HTTPS://EXAMPLE.COM', 'https://e.com/?q=a<1']) {
    assert.ok(isBlockUrl(kept), kept);
  }
  const refused = [
    'http://example.com',
    'ftp://example.com',
    'javascript:alert(1)',
    'example.com',
    'https://',
    'https://exa mple.com',
    'https://user:secret@example.com',
    'https://user@example.com',
    'https://:secret@example.com',
    `https://e.com/${'x'.repeat(L.urlLength - 13)}`,
  ];
  for (const url of refused) assert.equal(isBlockUrl(url), false, url);
  const links = refused.map((url) => ({ type: 'link', title: 'Help', url }));
  assert.equal(bound(links), undefined, 'a link without its url is left out');
  assert.deepEqual(
    sendable(bound(refused.map((url) => item({ title: 'Row', url })))),
    refused.map(() => ({ type: 'list', items: [{ title: 'Row' }] })),
    "a row's url left off, the row kept",
  );
  assert.deepEqual(bound([{ type: 'link', title: 'Help', url: ' https://example.com ' }]), [
    { type: 'link', title: 'Help', url: 'https://example.com' },
  ]);
});

test("a file is kept only by an artifact id, the SDK's rule", () => {
  const files = [FILE, FILE.toUpperCase(), 'doc-1', `${FILE.slice(0, 14)}9${FILE.slice(15)}`, ''];
  assert.deepEqual(
    sendable(bound(files.map((fileId) => ({ type: 'file', fileId, title: 'The upload' })))),
    [FILE, FILE.toUpperCase()].map((fileId) => ({ type: 'file', fileId, title: 'The upload' })),
  );
});

test("the platform's own and the unknown are left out: questions, open, a section's section", () => {
  const leafs: unknown[] = [
    text('Inside'),
    { type: 'section', title: 'Deeper', blocks: [text('x')] },
  ];
  const kept = sendable(
    bound([
      { type: 'questions', form: { kind: 'run' } },
      { type: 'chart', points: [1, 2] },
      { type: 'toString' },
      'text',
      null,
      { type: 'text', text: 'Shown', colour: 'red', open: true },
      { type: 'section', title: 'Outer', open: true, blocks: leafs },
      { type: 'section', title: 'Only deeper', blocks: [leafs[1]] },
      item({ title: 'Row', open: { target: 'run', runId: FILE } }),
    ]),
  );
  assert.deepEqual(kept, [
    { type: 'text', text: 'Shown' },
    { type: 'section', title: 'Outer', blocks: [{ type: 'text', text: 'Inside' }] },
    { type: 'list', items: [{ title: 'Row' }] },
  ]);
});

test("each block's list at its bound, the first kept, and a block left empty left out", () => {
  const many = (count: number, make: (at: number) => unknown) =>
    Array.from({ length: count }, (_, at) => make(at));
  const [metric, table, list, timeline, section] = sendable(
    bound([
      { type: 'metric', items: many(5, (at) => ({ label: `L${at}`, value: `${at}` })) },
      {
        type: 'table',
        columns: many(4, () => ({})),
        rows: [
          { cells: ['short', 'row'] },
          ...many(201, (at) => ({ cells: [`r${at}`, 'b', 'c', 'd'] })),
        ],
      },
      { type: 'list', items: many(101, (at) => ({ title: `i${at}` })) },
      {
        type: 'timeline',
        items: [
          { title: 'Odd', state: 'paused' },
          ...many(51, (at) => ({ title: `s${at}`, state: 'done' })),
        ],
      },
      { type: 'section', title: 'S', blocks: many(41, (at) => text(`b${at}`)) },
      { type: 'table', columns: [{}], rows: [{ cells: ['one column'] }] },
      { type: 'metric', items: [{ label: 'No value' }] },
      { type: 'timeline', items: [] },
    ]),
  ) as Json[];
  assert.equal(metric!.items.length, L.metricItems);
  assert.equal(table!.columns.length, L.tableColumns);
  assert.equal(table!.rows.length, L.tableRows, 'a row short of a cell left out');
  assert.deepEqual(table!.rows[0].cells, ['r0', 'b', 'c'], "a cut column's cells go with it");
  assert.equal(list!.items.length, L.listItems);
  assert.equal(timeline!.items.length, L.timelineItems, 'a state the platform has not, left out');
  assert.equal(section!.blocks.length, L.sectionBlocks);
  assert.equal(section!.blocks.at(-1).text, 'b39');
});

test('at most 60 at the top level and 300 in all, a section that does not fit keeping its first', () => {
  const sixtyOne = sendable(bound(Array.from({ length: 61 }, (_, at) => text(`t${at}`))));
  assert.equal(sixtyOne.length, L.topLevel);
  assert.deepEqual(sixtyOne.at(-1), { type: 'text', text: 't59' });
  const section = (at: number) => ({
    type: 'section',
    title: `S${at}`,
    blocks: Array.from({ length: 40 }, () => text('x')),
  });
  const sections = sendable(bound(Array.from({ length: 10 }, (_, at) => section(at))));
  // Seven whole sections are 287 blocks; the eighth keeps its title and 12 of its 40.
  assert.deepEqual(
    sections.map((b) => (b.type === 'section' ? b.blocks.length : 0)),
    [40, 40, 40, 40, 40, 40, 40, 12],
  );
});

test('within 96 KiB: the block that passes it keeps the first rows that fit, and none after it', () => {
  const cell = (at: number) => `${String(at).padStart(3, '0')}${'w'.repeat(197)}`;
  const rows = Array.from({ length: 200 }, (_, at) => ({
    cells: [cell(at), cell(at), cell(at)],
    note: 'n'.repeat(200),
  }));
  const big: TableBlock = { type: 'table', columns: [{}, {}, {}], rows };
  const kept = sendable(
    boundedBlocks([{ type: 'text', text: 'Before' }, big, { type: 'text', text: 'After' }]),
  );
  assert.equal(kept.length, 2, 'nothing after the block that was cut');
  const cut = kept[1] as TableBlock;
  assert.ok(cut.rows.length > 0 && cut.rows.length < rows.length);
  assert.deepEqual(cut.rows, rows.slice(0, cut.rows.length), 'the first rows, whole');
  const row = Buffer.byteLength(JSON.stringify(rows[0]));
  assert.ok(Buffer.byteLength(JSON.stringify(kept)) > L.bytes - row - 1, 'as many as fit');

  // Inside a section, its last block is cut the same way.
  const inner: EmittedLeaf[] = [{ type: 'text', text: 'Lead' }, big, big];
  const [section] = sendable(boundedBlocks([{ type: 'section', title: 'All', blocks: inner }]));
  assert.ok(section?.type === 'section');
  assert.equal(section.blocks.length, 2);
  assert.ok((section.blocks[1] as TableBlock).rows.length < rows.length);
});

test('whatever an automation gives, what is sent validates', () => {
  const messy: unknown[] = [
    { type: 'text', text: 'Summary\r\n\u0007', style: 'shout', tone: 'loud' },
    { type: 'metric', items: [{ label: ' Amount ', value: ' $120.50 ', tone: 'success' }, 'x'] },
    { type: 'badge', text: '', tone: 'error' },
    {
      type: 'table',
      columns: [{ align: 'middle', muted: 'yes' }, { title: 'v' }],
      rows: [{ cells: [1, 2] }],
    },
    {
      type: 'list',
      items: [{ title: 'A', badge: { text: '' }, value: 82, muted: 1 }],
      empty: '<i>',
    },
    { type: 'link', title: 'Docs', url: 'https://example.com/docs' },
    { type: 'timeline', items: [{ title: 'Read', state: 'done', sub: 7 }] },
  ];
  assert.deepEqual(sendable(bound(messy)), [
    { type: 'metric', items: [{ label: 'Amount', value: '$120.50', tone: 'success' }] },
    { type: 'list', items: [{ title: 'A' }] },
    { type: 'link', title: 'Docs', url: 'https://example.com/docs' },
    { type: 'timeline', items: [{ title: 'Read', state: 'done' }] },
  ]);
  assert.equal(boundedBlocks(undefined), undefined);
  assert.equal(boundedBlocks([]), undefined);
});
