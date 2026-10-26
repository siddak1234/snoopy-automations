import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  BLOCK_TONES,
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
import { boundedResult } from '../src/platform.js';
import { held } from '../src/steps.js';
import { RecordingPlatform } from '../src/testing.js';
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

/** The platform's parity fixtures, copied byte for byte from its `packages/contracts/fixtures/blocks/`. */
const fixture = (name: string): Json[] =>
  (
    JSON.parse(
      readFileSync(resolve(import.meta.dirname, 'fixtures/blocks', `${name}.json`), 'utf8'),
    ) as { blocks: Json[] }
  ).blocks;

/** A drawn page as its automation sent it: a file by its artifact id, as the platform's test reads it. */
const asSent = (blocks: readonly Json[]): EmittedBlock[] =>
  blocks.map((block) =>
    block.type === 'file' ? { type: 'file', fileId: block.file.id, title: block.title } : block,
  ) as EmittedBlock[];

test("the types, their values and the limits are the published schema's", () => {
  const defs = published('automation-run-result').$defs;
  const byType = Object.fromEntries(
    (defs.emittedBlock.oneOf as Json[]).map((one) => [one.properties.type.const, one.properties]),
  ) as Record<string, Json>;
  assert.deepEqual(Object.keys(byType).sort(), [...EMITTED_BLOCK_TYPES].sort());
  assert.deepEqual(
    (defs.emittedLeaf.oneOf as Json[]).map((one) => one.properties.type.const).sort(),
    EMITTED_BLOCK_TYPES.filter((type) => type !== 'section').sort(),
    'a section holds every type but a section',
  );
  const { text, metric, badge, table, list, section, file, link, timeline } = byType as Record<
    string,
    Json
  >;
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
    },
  );
  assert.deepEqual(text!.style.enum, [...TEXT_STYLES]);
  assert.deepEqual(text!.tone.enum, [...BLOCK_TONES]);
  assert.deepEqual(table!.columns.items.properties.align.enum, [...TABLE_ALIGNS]);
  assert.deepEqual(timeline!.items.items.properties.state.enum, [...TIMELINE_STATES]);
  assert.equal(file!.fileId.pattern, ARTIFACT_ID_PATTERN.source, "the SDK's artifact-id rule");
});

test("a manifest's page parts are the published schema's closed set", () => {
  const pages = published('automation-manifest').properties.display.properties.pages;
  assert.equal(pages.additionalProperties, false);
  assert.deepEqual(Object.keys(pages.properties), Object.keys(PAGE_PARTS));
  for (const [page, parts] of Object.entries(PAGE_PARTS)) {
    assert.deepEqual(pages.properties[page].items.enum, [...parts], page);
  }
});

test("the platform's fixtures pass through unchanged; its drawn file is bounded to what may be sent", () => {
  const validate = validator('automation-run-result');
  for (const name of ['emitted-all-nine', 'oversize-run']) {
    const sent = asSent(fixture(name));
    assertValid(validate, { outcome: 'success', blocks: sent }, name);
    assert.deepEqual(boundedBlocks(sent), sent, name);
  }
  const drawn = fixture('emitted-all-nine');
  assert.deepEqual(new Set(drawn.map((block) => block.type)), new Set(EMITTED_BLOCK_TYPES));
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
