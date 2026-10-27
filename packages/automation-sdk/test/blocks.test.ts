import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  BLOCK_TONES,
  CHART_KINDS,
  EMITTED_BLOCK_TYPES,
  TABLE_ALIGNS,
  TEXT_STYLES,
  TIMELINE_STATES,
  type EmittedBlock,
} from '../src/block-types.js';
import { BLOCK_LIMITS as L, boundedBlocks } from '../src/blocks.js';
import type { RunResult } from '../src/contract.js';
import { PAGE_PARTS } from '../src/manifest.js';
import { ARTIFACT_ID_PATTERN } from '../src/model-request.js';
import { RESULT_BODY_LIMIT_BYTES, boundedResult } from '../src/platform.js';
import { held } from '../src/steps.js';
import { RecordingPlatform } from '../src/testing.js';
import { EXAMPLE } from './document-fixture.js';
import { assertValid, schemas, validator } from './published-schemas.js';
import { define, invoke } from './runner-fixtures.js';

/**
 * A result's blocks (platform ADR-0048, Round 21): the SDK's types, limits and page parts held
 * to the published schemas, the platform's own fixtures passed through, and the result that
 * carries them — on a success or a held run, never beside `sections` or `details`. The rules
 * `boundedBlocks` holds each block to are `blocks-bounds.test.ts`.
 */

/** A schema or a drawn block, read by path: the test reads what it names. */
type Json = Record<string, any>;

const published = (name: string): Json =>
  JSON.parse(readFileSync(resolve(schemas, `${name}.json`), 'utf8')) as Json;

/**
 * The platform's fixtures, copied byte for byte: its parity fixtures from its
 * `packages/contracts/fixtures/blocks/`, each `{blocks}`, and its emitted example of all twelve
 * sendable types from its `test/fixtures/`, a bare list.
 */
const fixture = (name: string): Json[] => {
  const read = JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'fixtures/blocks', `${name}.json`), 'utf8'),
  ) as Json[] | { blocks: Json[] };
  return Array.isArray(read) ? read : read.blocks;
};

/**
 * A drawn page as its automation sent it: a drawn file by its artifact id, as the platform's test
 * reads it. An emitted list (a file already by its `fileId`) is unchanged.
 */
const asSent = (blocks: readonly Json[]): EmittedBlock[] =>
  blocks.map((block) =>
    block.type === 'file' && block.file
      ? { type: 'file', fileId: block.file.id, title: block.title }
      : block,
  ) as EmittedBlock[];

test("the types, their values and the limits are the published schema's", () => {
  const defs = published('automation-run-result').$defs;
  // A chart is a `oneOf` of its two kinds; every other type one object.
  const branches = (of: Json): Json[] =>
    (of.oneOf as Json[]).flatMap((one) => (one.oneOf ? (one.oneOf as Json[]) : [one]));
  const byType = Object.fromEntries(
    branches(defs.emittedBlock).map((one) => [one.properties.type.const, one.properties]),
  ) as Record<string, Json>;
  assert.deepEqual(Object.keys(byType).sort(), [...EMITTED_BLOCK_TYPES].sort());
  assert.deepEqual(
    [...new Set(branches(defs.emittedLeaf).map((one) => one.properties.type.const))].sort(),
    EMITTED_BLOCK_TYPES.filter((type) => type !== 'section' && type !== 'group').sort(),
    'a section holds every type but a section and a group',
  );
  const { text, metric, badge, table, list, section, file, link, timeline, image, group } =
    byType as Record<string, Json>;
  const [bar, line] = (defs.emittedBlock.oneOf as Json[]).find((one) => one.oneOf)!.oneOf as Json[];
  assert.deepEqual([bar!.properties.kind.const, line!.properties.kind.const], [...CHART_KINDS]);
  const [barPoints, linePoints] = [bar!.properties.points, line!.properties.points] as Json[];
  const item = list!.items.items.properties;
  const row = table!.rows.items.properties;
  assert.deepEqual(
    {
      topLevel: [defs.emittedBlocks.minItems, defs.emittedBlocks.maxItems],
      sectionBlocks: section!.blocks.maxItems,
      metricItems: metric!.items.maxItems,
      tableColumns: [table!.columns.minItems, table!.columns.maxItems],
      tableRows: table!.rows.maxItems,
      listItems: list!.items.maxItems,
      timelineItems: timeline!.items.maxItems,
      textLength: text!.text.maxLength,
      titleLength: [section!.title, link!.title, file!.title, item.title].map((x) => x.maxLength),
      lineLength: [row.note, row.cells.items, item.subtitle, list!.empty].map((x) => x.maxLength),
      listTextLength: item.text.maxLength,
      wordLength: [badge!.text, item.lead, item.value, item.badge.properties.text].map(
        (x) => x.maxLength,
      ),
      urlLength: [link!.url.maxLength, item.url.maxLength],
      chartBars: [barPoints!.minItems, barPoints!.maxItems],
      chartPoints: [linePoints!.minItems, linePoints!.maxItems],
      chartValue: [
        barPoints!.items.properties.value.minimum,
        barPoints!.items.properties.value.maximum,
        linePoints!.items.properties.value.minimum,
        linePoints!.items.properties.value.maximum,
      ],
      chartWords: [barPoints!.items.properties.label, linePoints!.items.properties.text].map(
        (x) => x.maxLength,
      ),
      altLength: image!.alt.maxLength,
      groupSections: [group!.sections.minItems, group!.sections.maxItems],
    },
    {
      topLevel: [1, L.topLevel],
      sectionBlocks: L.sectionBlocks,
      metricItems: L.metricItems,
      tableColumns: [L.tableColumnsMinimum, L.tableColumns],
      tableRows: L.tableRows,
      listItems: L.listItems,
      timelineItems: L.timelineItems,
      textLength: L.textLength,
      titleLength: Array(4).fill(L.titleLength),
      lineLength: Array(4).fill(L.lineLength),
      listTextLength: L.listTextLength,
      wordLength: Array(4).fill(L.wordLength),
      urlLength: [L.urlLength, L.urlLength],
      chartBars: [1, L.chartBars],
      chartPoints: [L.chartPointsMinimum, L.chartPoints],
      chartValue: [0, L.chartValue, -L.chartValue, L.chartValue],
      chartWords: [L.wordLength, L.wordLength],
      altLength: L.altLength,
      groupSections: [1, L.groupSections],
    },
  );
  assert.deepEqual(text!.style.enum, [...TEXT_STYLES]);
  assert.deepEqual(text!.tone.enum, [...BLOCK_TONES]);
  assert.deepEqual(table!.columns.items.properties.align.enum, [...TABLE_ALIGNS]);
  assert.deepEqual(timeline!.items.items.properties.state.enum, [...TIMELINE_STATES]);
  assert.equal(file!.fileId.pattern, ARTIFACT_ID_PATTERN.source, "the SDK's artifact-id rule");
  assert.equal(image!.fileId.pattern, ARTIFACT_ID_PATTERN.source, "an image's, the same rule");
});

test("a manifest's page parts are the published schema's closed set", () => {
  const pages = published('automation-manifest').properties.display.properties.pages;
  assert.equal(pages.additionalProperties, false);
  assert.deepEqual(Object.keys(pages.properties), Object.keys(PAGE_PARTS));
  for (const [page, parts] of Object.entries(PAGE_PARTS)) {
    assert.deepEqual(pages.properties[page].items.enum, [...parts], page);
  }
  // `scores`, since the switch (amendment 1, point 3b): a flow with items may list it.
  const reviewer = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../manifests/candidate-reviewer.v2.json'),
      'utf8',
    ),
  ) as Json;
  const display = { ...reviewer.display, pages: { item: ['tiles', 'add', 'runs', 'scores'] } };
  assertValid(validator('automation-manifest'), { ...reviewer, display }, 'scores on an item page');
});

test("the platform's fixtures pass through unchanged; its drawn file is bounded to what may be sent", () => {
  const validate = validator('automation-run-result');
  for (const name of ['emitted-all-nine', 'emitted-all-twelve', 'oversize-run']) {
    const sent = asSent(fixture(name));
    assertValid(validate, { outcome: 'success', blocks: sent }, name);
    assert.deepEqual(boundedBlocks(sent), sent, name);
  }
  const all = fixture('emitted-all-twelve').map((block) => block.type);
  assert.deepEqual(new Set(all), new Set(EMITTED_BLOCK_TYPES), 'all twelve, each once');
  assert.equal(all.length, EMITTED_BLOCK_TYPES.length + 1, 'and a second text');
  const drawn = fixture('emitted-all-nine');
  assert.deepEqual(
    new Set(drawn.map((block) => block.type)),
    new Set(EMITTED_BLOCK_TYPES.slice(0, 9)),
    'the nine of block set 1',
  );
  // As drawn, its file is the platform's row — `open` and the file, no fileId — never sendable.
  assert.equal(validate({ outcome: 'success', blocks: drawn }), false);
  const bounded = boundedBlocks(drawn as unknown as EmittedBlock[]);
  assertValid(validate, { outcome: 'success', blocks: bounded }, 'the drawn page, bounded');
  assert.deepEqual(
    bounded,
    asSent(drawn).filter((block) => block.type !== 'file'),
  );
});

const blocks: EmittedBlock[] = [{ type: 'text', text: '  Two of three checks passed. ' }];
const trimmed = [{ type: 'text', text: 'Two of three checks passed.' }];
const HELD = { outcome: 'held', held: { stepId: 'review', reason: 'r', state: {} } } as const;

test('a success or a held result carries its blocks bounded, and a failed one none', () => {
  const validate = validator('automation-run-result');
  const success = boundedResult({ outcome: 'success', summary: 'Checked', blocks });
  assert.deepEqual(success, { outcome: 'success', summary: 'Checked', blocks: trimmed });
  assertValid(validate, { runId: 'r', ...success }, 'a success with blocks');
  const waiting = boundedResult({ ...HELD, blocks });
  assert.deepEqual(waiting, { ...HELD, blocks: trimmed });
  assertValid(validate, { runId: 'r', ...waiting }, 'a held result with blocks');
  assert.equal(validate({ outcome: 'failed', failureReason: 'x', blocks: trimmed }), false);
  assert.deepEqual(
    boundedResult({
      outcome: 'success',
      summary: 'Checked',
      blocks: [{ type: 'text', text: ' ' }],
    }),
    { outcome: 'success', summary: 'Checked' },
    'none left, none sent: the schema takes 1 to 60',
  );
});

test("a held result past the platform's 256 KiB leaves out its blocks after its documents, never its state", () => {
  const validate = validator('automation-run-result');
  const bytes = (result: RunResult) =>
    Buffer.byteLength(JSON.stringify({ runId: '00000000-0000-4000-8000-000000000000', ...result }));
  // Two tables at their 200 rows, within the 96 KiB blocks may take, beside a 200 KiB state.
  const table: EmittedBlock = {
    type: 'table',
    columns: [{ title: 'Item' }, { title: 'Amount' }],
    rows: Array.from({ length: L.tableRows }, (_, at) => ({
      cells: [`Item ${at + 1}: ${'2X4-8 STUD, KILN DRIED, '.repeat(6)}AISLE 14`, '1.25'],
    })),
  };
  const drawn = [table, table];
  assert.deepEqual(boundedBlocks(drawn), drawn, 'both tables within the blocks own bound');
  const state = { blob: 'z'.repeat(200 * 1024) };
  const kept = { ...HELD, held: { ...HELD.held, state } };
  const waiting = { ...kept, blocks: drawn };
  assert.ok(bytes(waiting) > RESULT_BODY_LIMIT_BYTES, `past the limit: ${bytes(waiting)} bytes`);
  for (const [given, name] of [
    [waiting, 'no documents'],
    [{ ...waiting, documents: [EXAMPLE] }, 'documents left out first'],
  ] as const) {
    const sent = boundedResult(given);
    assert.ok(bytes(sent) <= RESULT_BODY_LIMIT_BYTES, `${name}: within it, ${bytes(sent)} bytes`);
    assert.deepEqual(sent, kept, `${name}: the state kept whole, the blocks left out`);
    assertValid(validate, { runId: 'r', ...sent }, `${name}: what is sent validates`);
  }
  // Within the limit, the blocks stay.
  assert.deepEqual(boundedResult({ ...HELD, blocks: drawn }), { ...HELD, blocks: drawn });
});

test('blocks beside sections or details are refused before sending, in the platform words', () => {
  const validate = validator('automation-run-result');
  const sections = [{ title: 'Contact', entries: [{ title: 'jane@example.com' }] }];
  const details = [{ label: 'Seller', value: 'Contoso' }];
  // The schema says each alone; only the route refuses the two together.
  assert.ok(validate({ outcome: 'success', blocks: trimmed, sections, details }));
  for (const [other, given] of [
    ['sections', { sections }],
    ['details', { details }],
    ['sections', { sections: [] }],
  ] as const) {
    assert.throws(
      () => boundedResult({ outcome: 'success', blocks, ...given } as RunResult),
      new RegExp(`^Error: blocks is not allowed with ${other}: send one or the other$`, 'u'),
      other,
    );
    const platform = new RecordingPlatform();
    assert.throws(() => platform.reportResult('r', { outcome: 'success', blocks, ...given }));
    assert.equal(platform.results.length, 0, 'nothing reported');
  }
  assert.deepEqual(boundedResult({ outcome: 'success', sections }), {
    outcome: 'success',
    sections,
  });
});

test("the runner sends a success's blocks and a held step's, as the automation gave them", async () => {
  const success = await define({ result: () => ({ summary: 'Done', blocks }) }).execute(
    invoke(),
    new RecordingPlatform(),
  );
  assert.deepEqual(success, { outcome: 'success', summary: 'Done', blocks });
  const waiting = await define({
    steps: {
      receive: () => Promise.resolve({ outcome: 'ok', summary: 'Received' }),
      validate: () =>
        Promise.resolve(held({ summary: 'Above', heldReason: 'Approve it', state: {}, blocks })),
      post: () => Promise.resolve({ outcome: 'ok', summary: 'Posted' }),
    },
  }).execute(invoke(), new RecordingPlatform());
  assert.deepEqual(waiting, {
    outcome: 'held',
    held: { stepId: 'validate', reason: 'Approve it', state: {} },
    blocks,
  });
});
