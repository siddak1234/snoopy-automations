import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import type { EmittedGroupBlock, TableBlock } from '../src/block-types.js';
import { BLOCK_LIMITS as L } from '../src/blocks.js';
import { FILE, bound, sendable, text, type Json } from './blocks-fixtures.js';

/**
 * `boundedBlocks` for the platform's amendment 1 to ADR-0048 (block set v2): an image, a chart
 * and a group held to its `BLOCK_LIMITS` (`snoopy-backend/packages/contracts/src/blocks-checks.ts`)
 * and its checks (`blocks-validation-v2.ts`), cut or left out, and what is sent valid by the
 * published `automation-run-result.json`. The nine of block set 1 are `blocks-bounds.test.ts`.
 */

const many = (count: number, make: (at: number) => unknown): unknown[] =>
  Array.from({ length: count }, (_, at) => make(at));

const chart = (kind: string, points: unknown[]): unknown => ({
  type: 'chart',
  kind,
  title: 'By week',
  points,
});

const point = (at: number, value: unknown = at): unknown => ({ label: `P${at}`, value });

const image = (alt: unknown = 'A page', fileId: unknown = FILE): unknown => ({
  type: 'image',
  fileId,
  alt,
});

const section = (title: string, blocks: unknown[]): unknown => ({
  type: 'section',
  title,
  blocks,
});

test('a chart: 25 bars send 24 and 61 line points 60; a bar with none or a line of 1 left out', () => {
  const [bars, line] = sendable(
    bound([
      chart(
        'bar',
        many(25, (at) => point(at)),
      ),
      chart(
        'line',
        many(61, (at) => point(at, at - 30)),
      ),
      chart('line', [point(1)]),
      chart('bar', []),
      chart('pie', [point(1), point(2)]),
      { type: 'chart', kind: 'bar', points: [point(1)] },
    ]),
  ) as Json[];
  assert.equal(bars!.points.length, L.chartBars);
  assert.deepEqual(bars!.points.at(-1), point(23), 'the first 24 kept');
  assert.equal(line!.points.length, L.chartPoints);
  assert.deepEqual(line!.points.at(-1), point(59, 29), 'the first 60 kept');
});

test('a point not finite, over 1e15 in size, or below 0 on a bar is left out; its words cut at 40', () => {
  const odd = [-1, NaN, Infinity, -Infinity, 1e16, '3', null];
  const [bar, line] = sendable(
    bound([
      chart('bar', [...odd.map((value, at) => point(at, value)), point(9, L.chartValue)]),
      chart('line', [point(0, -L.chartValue), point(1, -1e16), point(2, -2.5)]),
      chart('line', [point(0, NaN), point(1, 4)]),
    ]),
  ) as Json[];
  assert.deepEqual(
    bar!.points,
    [point(9, L.chartValue)],
    'only the finite, in-range, non-negative',
  );
  assert.deepEqual(
    line!.points,
    [point(0, -L.chartValue), point(2, -2.5)],
    'a line may go below 0',
  );
  const [cut] = sendable(
    bound([
      chart('bar', [
        { label: ` ${'l'.repeat(50)} `, value: 1, text: 'Up\n1' },
        { label: '<b>', value: 2 },
      ]),
    ]),
  ) as Json[];
  assert.deepEqual(cut!.points, [{ label: 'l'.repeat(L.wordLength), value: 1, text: 'Up 1' }]);
});

test('an image: its alt cut whole at 200 on one line; no alt or no artifact id, left out; a url never sent', () => {
  const kept = sendable(
    bound([
      { ...(image(`${'a'.repeat(199)}😀`) as Json), url: 'https://example.com/a.png' },
      image(` ${'b'.repeat(201)} `),
      image('Two\n lines'),
      image(''),
      { type: 'image', fileId: FILE },
      image('<img src=x>'),
      image('Upper', FILE.toUpperCase()),
      image('No id', 'doc-1'),
      { type: 'image', alt: 'No id' },
    ]),
  ) as Json[];
  assert.deepEqual(kept, [
    { type: 'image', fileId: FILE, alt: 'a'.repeat(199) },
    { type: 'image', fileId: FILE, alt: 'b'.repeat(L.altLength) },
    { type: 'image', fileId: FILE, alt: 'Two lines' },
    { type: 'image', fileId: FILE.toUpperCase(), alt: 'Upper' },
  ]);
  assert.ok(
    kept.every((one) => !('url' in one)),
    "an image's url key is never sent",
  );
});

test('21 images send 20, those in a section and a group counted, and a section left empty left out', () => {
  const kept = sendable(
    bound([
      ...many(10, (at) => image(`Top ${at}`)),
      section('Pages', [image('In a section'), text('Between')]),
      {
        type: 'group',
        title: 'More',
        sections: [
          section(
            'Some',
            many(8, (at) => image(`Grouped ${at}`)),
          ),
        ],
      },
      image('The 20th'),
      image('The 21st'),
      section('Only images', [image('Over')]),
      text('After'),
    ]),
  ) as Json[];
  const alts = JSON.stringify(kept).match(/"alt":"[^"]*"/gu) ?? [];
  assert.equal(alts.length, L.images);
  assert.equal(alts.at(-1), '"alt":"The 20th"', 'the first 20 kept');
  assert.deepEqual(kept.at(-1), { type: 'text', text: 'After' }, 'what follows still sent');
  assert.equal(kept.length, 14, 'the 21st and the section of only it left out');
});

test('a group: 13 sections send 12; a group inside a section, a section in its section, none, left out', () => {
  const kept = sendable(
    bound([
      {
        type: 'group',
        title: 'Details',
        sections: many(13, (at) => section(`S${at}`, [text('x')])),
      },
      section('Outer', [
        { type: 'group', title: 'Inside', sections: [section('S', [text('x')])] },
        text('Kept'),
      ]),
      section('Only a group', [
        { type: 'group', title: 'Inside', sections: [section('S', [text('x')])] },
      ]),
      {
        type: 'group',
        title: 'Nested',
        sections: [section('S', [section('Deeper', [text('x')])])],
      },
      { type: 'group', title: 'Empty', sections: [] },
      { type: 'group', sections: [section('Untitled', [text('x')])] },
      {
        type: 'group',
        title: 'Not one',
        sections: [{ type: 'list', title: 'L', blocks: [text('x')] }],
      },
    ]),
  ) as Json[];
  assert.equal(kept.length, 2, 'only the first group and the outer section');
  const [group, outer] = kept;
  assert.equal(group!.sections.length, L.groupSections);
  assert.equal(group!.sections.at(-1).title, 'S11', 'the first 12 kept');
  assert.deepEqual(outer, {
    type: 'section',
    title: 'Outer',
    blocks: [{ type: 'text', text: 'Kept' }],
  });
});

test('a group counts toward the 300 with its sections and their blocks, and keeps the first that fit', () => {
  const sections = many(12, (at) =>
    section(
      `S${at}`,
      many(40, () => text('x')),
    ),
  );
  const [group, after] = sendable(
    bound([{ type: 'group', title: 'All', sections }, text('After')]),
  ) as [EmittedGroupBlock, unknown];
  // The group is 1; seven whole sections 287 more; the eighth keeps its title and 11 of its 40.
  assert.deepEqual(
    group.sections.map((each) => each.blocks.length),
    [40, 40, 40, 40, 40, 40, 40, 11],
  );
  assert.equal(after, undefined, 'the 300 is reached: nothing after it');
});

test('within 96 KiB, a group keeps its first sections that fit, its last one cut', () => {
  const cell = (at: number) => `${String(at).padStart(3, '0')}${'w'.repeat(197)}`;
  const rows = many(200, (at) => ({ cells: [cell(at), cell(at), cell(at)] }));
  const big = { type: 'table', columns: [{}, {}, {}], rows };
  const [group, ...rest] = sendable(
    bound([
      {
        type: 'group',
        title: 'All',
        sections: [section('A', [text('Lead')]), section('B', [big, big])],
      },
      text('After'),
    ]),
  ) as EmittedGroupBlock[];
  assert.equal(rest.length, 0, 'nothing after the block that was cut');
  assert.equal(group!.sections.length, 2);
  const [, cut] = group!.sections;
  assert.equal(cut!.blocks.length, 1, 'the last section keeps its first table, cut');
  assert.ok((cut!.blocks[0] as TableBlock).rows.length < rows.length);
  assert.ok(Buffer.byteLength(JSON.stringify([group])) > L.bytes - 700, 'as many rows as fit');
});
