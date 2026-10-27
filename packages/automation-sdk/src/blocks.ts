import { Buffer } from 'node:buffer';

import {
  BLOCK_TONES,
  CHART_KINDS,
  TABLE_ALIGNS,
  TEXT_STYLES,
  TIMELINE_STATES,
  type BlockBadge,
  type ChartPoint,
  type EmittedBlock,
  type EmittedChartBlock,
  type EmittedGroupBlock,
  type EmittedLeaf,
  type ListItem,
  type MetricBlock,
  type SectionBlock,
  type TableBlock,
  type TableColumn,
  type TableRow,
  type TimelineBlock,
} from './block-types.js';
import {
  BLOCK_LIMITS as L,
  defined,
  first,
  flag,
  line,
  lines,
  oneOf,
  url,
} from './blocks-limits.js';
import { isObject, type JsonObject } from './contract.js';
import { ARTIFACT_ID_PATTERN } from './model-request.js';

export { BLOCK_LIMITS, isBlockUrl } from './blocks-limits.js';

/*
 * A result's `blocks` held to the platform's one rule for them before they are sent (platform
 * ADR-0048 decision 3 and amendment 1): `boundedBlocks`, which cuts or leaves out what the
 * platform would refuse. The limits and the string and url rules are `blocks-limits.ts`; the
 * shapes are `block-types.ts`.
 */

function badge(value: unknown): BlockBadge | undefined {
  const text = isObject(value) ? line(value.text, L.wordLength) : undefined;
  return text === undefined
    ? undefined
    : defined({ text, tone: oneOf(BLOCK_TONES, (value as JsonObject).tone) });
}

const metricItem = (value: unknown): MetricBlock['items'][number] | undefined => {
  if (!isObject(value)) return undefined;
  const label = line(value.label, L.wordLength);
  const shown = line(value.value, L.wordLength);
  return label === undefined || shown === undefined
    ? undefined
    : defined({ label, value: shown, tone: oneOf(BLOCK_TONES, value.tone) });
};

/** A row of `columns` cells: the first one line, the others one line or empty; a short row left out. */
function tableRow(value: unknown, columns: number): TableRow | undefined {
  if (!isObject(value) || !Array.isArray(value.cells) || value.cells.length < columns) {
    return undefined;
  }
  const [lead, ...rest] = value.cells.slice(0, columns) as unknown[];
  const head = line(lead, L.lineLength);
  if (head === undefined) return undefined;
  return defined({
    cells: [head, ...rest.map((cell) => line(cell, L.lineLength) ?? '')],
    note: line(value.note, L.lineLength),
    strong: flag(value.strong),
  });
}

function table(value: JsonObject): TableBlock | undefined {
  const columns = (Array.isArray(value.columns) ? value.columns : [])
    .slice(0, L.tableColumns)
    .map((column: unknown) =>
      isObject(column)
        ? defined<TableColumn>({
            title: line(column.title, L.titleLength),
            align: oneOf(TABLE_ALIGNS, column.align),
            muted: flag(column.muted),
          })
        : {},
    );
  if (columns.length < L.tableColumnsMinimum) return undefined;
  const rows = first(value.rows, L.tableRows, (row) => tableRow(row, columns.length));
  return rows.length === 0
    ? undefined
    : defined({ type: 'table', columns, rows, divided: flag(value.divided) });
}

function listItem(value: unknown): ListItem | undefined {
  const title = isObject(value) ? line(value.title, L.titleLength) : undefined;
  if (title === undefined) return undefined;
  const item = value as JsonObject;
  return defined({
    title,
    subtitle: line(item.subtitle, L.lineLength),
    text: lines(item.text, L.listTextLength),
    url: url(item.url),
    badge: badge(item.badge),
    lead: line(item.lead, L.wordLength),
    value: line(item.value, L.wordLength),
    valueLabel: line(item.valueLabel, L.wordLength),
    muted: flag(item.muted),
  });
}

const timelineItem = (value: unknown): TimelineBlock['items'][number] | undefined => {
  if (!isObject(value)) return undefined;
  const title = line(value.title, L.titleLength);
  const state = oneOf(TIMELINE_STATES, value.state);
  return title === undefined || state === undefined
    ? undefined
    : defined({ title, sub: line(value.sub, L.lineLength), state });
};

/** A point whose value the platform takes: finite, at most 1e15 in size, and none below 0 on a bar. */
function chartPoint(value: unknown, bar: boolean): ChartPoint | undefined {
  if (!isObject(value)) return undefined;
  const label = line(value.label, L.wordLength);
  const shown = value.value;
  if (label === undefined || typeof shown !== 'number' || !Number.isFinite(shown)) return undefined;
  if (Math.abs(shown) > L.chartValue || (bar && shown < 0)) return undefined;
  return defined({ label, value: shown, text: line(value.text, L.wordLength) });
}

/** A bar chart's first 24 points, or a line's first 60; a bar with none, or a line under 2, left out. */
function chart(value: JsonObject): EmittedChartBlock | undefined {
  const kind = oneOf(CHART_KINDS, value.kind);
  const title = line(value.title, L.titleLength);
  if (kind === undefined || title === undefined) return undefined;
  const bar = kind === 'bar';
  const points = first(value.points, bar ? L.chartBars : L.chartPoints, (point) =>
    chartPoint(point, bar),
  );
  return points.length < (bar ? 1 : L.chartPointsMinimum)
    ? undefined
    : { type: 'chart', kind, title, points };
}

const artifactId = (value: unknown): string | undefined =>
  typeof value === 'string' && ARTIFACT_ID_PATTERN.test(value) ? value : undefined;

/** Each leaf rebuilt from the fields its type takes: any other key, `open` among them, left off. */
const LEAVES: Record<EmittedLeaf['type'], (value: JsonObject) => EmittedLeaf | undefined> = {
  text: (value) => {
    const text = lines(value.text, L.textLength);
    return text === undefined
      ? undefined
      : defined({
          type: 'text',
          text,
          style: oneOf(TEXT_STYLES, value.style),
          tone: oneOf(BLOCK_TONES, value.tone),
        });
  },
  metric: (value) => {
    const items = first(value.items, L.metricItems, metricItem);
    return items.length === 0 ? undefined : { type: 'metric', items };
  },
  badge: (value) => {
    const kept = badge(value);
    return kept === undefined ? undefined : { type: 'badge', ...kept };
  },
  table,
  list: (value) =>
    defined({
      type: 'list',
      items: first(value.items, L.listItems, listItem),
      empty: line(value.empty, L.lineLength),
    }),
  file: (value) => {
    const fileId = artifactId(value.fileId);
    return fileId === undefined
      ? undefined
      : defined({ type: 'file', fileId, title: line(value.title, L.titleLength) });
  },
  link: (value) => {
    const title = line(value.title, L.titleLength);
    const target = url(value.url);
    return title === undefined || target === undefined
      ? undefined
      : { type: 'link', title, url: target };
  },
  timeline: (value) => {
    const items = first(value.items, L.timelineItems, timelineItem);
    return items.length === 0 ? undefined : { type: 'timeline', items };
  },
  image: (value) => {
    const fileId = artifactId(value.fileId);
    const alt = line(value.alt, L.altLength);
    return fileId === undefined || alt === undefined ? undefined : { type: 'image', fileId, alt };
  },
  chart,
};

/** A leaf of a type an automation may send; `questions`, a section, a group and an unknown type are not. */
function leaf(value: unknown): EmittedLeaf | undefined {
  if (!isObject(value) || typeof value.type !== 'string') return undefined;
  return Object.hasOwn(LEAVES, value.type)
    ? LEAVES[value.type as EmittedLeaf['type']](value)
    : undefined;
}

/** A section of 1–40 leaves: a section or a group inside it left out. */
function section(value: JsonObject): SectionBlock | undefined {
  const title = line(value.title, L.titleLength);
  const blocks = first(value.blocks, L.sectionBlocks, leaf);
  return title === undefined || blocks.length === 0
    ? undefined
    : defined({
        type: 'section',
        title,
        subtitle: line(value.subtitle, L.lineLength),
        badge: badge(value.badge),
        blocks,
      });
}

/** A group's first 12 sections, each held as a top-level section is; one with none left out. */
function group(value: JsonObject): EmittedGroupBlock | undefined {
  const title = line(value.title, L.titleLength);
  const sections = first(value.sections, L.groupSections, (entry) =>
    isObject(entry) && entry.type === 'section' ? section(entry) : undefined,
  );
  return title === undefined || sections.length === 0
    ? undefined
    : { type: 'group', title, sections };
}

function block(value: unknown): EmittedBlock | undefined {
  if (isObject(value) && value.type === 'section') return section(value);
  if (isObject(value) && value.type === 'group') return group(value);
  return leaf(value);
}

/** The blocks' size as the platform counts it: UTF-8 bytes of their JSON (its `blocksBytes`). */
const blocksBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** One block in all: itself, and a section's blocks, or a group's sections and their blocks. */
function counted(one: EmittedBlock): number {
  if (one.type === 'section') return 1 + one.blocks.length;
  if (one.type === 'group') return one.sections.reduce((sum, each) => sum + counted(each), 1);
  return 1;
}

/** The block within `room` of the 300: whole, or a section's first blocks, a group's first sections. */
function within<T extends EmittedBlock>(one: T, room: number): T | undefined {
  if (counted(one) <= room) return one;
  if (one.type === 'section') {
    return room < 2 ? undefined : ({ ...one, blocks: one.blocks.slice(0, room - 1) } as T);
  }
  if (one.type !== 'group') return undefined;
  const sections: SectionBlock[] = [];
  let left = room - 1;
  for (const each of one.sections) {
    const cut = within(each, left);
    if (cut === undefined) break;
    sections.push(cut);
    left -= counted(cut);
  }
  return sections.length === 0 ? undefined : ({ ...one, sections } as T);
}

/** The block with each image past the 20th in all left out, and a section or group left empty. */
function images<T extends EmittedBlock>(one: T, take: () => boolean): T | undefined {
  if (one.type === 'image') return take() ? one : undefined;
  if (one.type === 'section') {
    const blocks = one.blocks.filter((each) => each.type !== 'image' || take());
    return blocks.length === 0 ? undefined : ({ ...one, blocks } as T);
  }
  if (one.type !== 'group') return one;
  const sections = one.sections.flatMap((each) => images(each, take) ?? []);
  return sections.length === 0 ? undefined : ({ ...one, sections } as T);
}

/** The key a block's rows sit under, which a cut shortens from the end. */
const ROWS: Partial<Record<EmittedBlock['type'], string>> = {
  table: 'rows',
  list: 'items',
  timeline: 'items',
  metric: 'items',
  section: 'blocks',
  group: 'sections',
};

/** The block within `room` bytes: whole, or its first rows (a section's or a group's last one cut too). */
function fit<T extends EmittedBlock>(one: T, room: number): T | undefined {
  if (blocksBytes(one) <= room) return one;
  const key = ROWS[one.type];
  if (key === undefined) return undefined;
  let used = blocksBytes({ ...one, [key]: [] });
  const rows: unknown[] = [];
  for (const row of (one as unknown as Record<string, readonly EmittedLeaf[]>)[key] ?? []) {
    const comma = rows.length === 0 ? 0 : 1;
    const bytes = blocksBytes(row);
    if (used + comma + bytes > room) {
      const nested = one.type === 'section' || one.type === 'group';
      const cut = nested ? fit(row as EmittedBlock, room - used - comma) : undefined;
      if (cut !== undefined) rows.push(cut);
      break;
    }
    rows.push(row);
    used += comma + bytes;
  }
  return rows.length === 0 ? undefined : ({ ...one, [key]: rows } as unknown as T);
}

/**
 * The blocks as the wire accepts them (ADR-0048 decision 3, amendment 1), cut or left out, never refused — a
 * run whose work is done must not become unreportable because a model wrote a long line, as
 * `boundedDetails` holds its lines. Each block is rebuilt from the fields its type takes; each
 * string cut whole at its bound (a one-line field made one line first); a string the platform
 * would refuse — empty, a NUL, half a surrogate pair, a control character but a tab and a line
 * break, anything shaped like an HTML tag — left off when optional, and its row or block left out
 * when required (a table's later cell left empty); a url that is not `https:` with a host, or
 * names a user or password, likewise; a file or an image whose `fileId` is not an artifact id, an
 * image with no `alt` (cut whole at 200 on one line), `questions`, a section inside a section, a
 * group anywhere but the top level and an unknown type, left out; each list at its bound, the
 * first kept. A chart's point whose value is not finite, over 1e15 in size, or below 0 on a bar,
 * left out; a bar keeps its first 24 points and a line its first 60, and a bar with none or a line
 * under 2 is left out. A group keeps its first 12 sections, each held as a top-level section is.
 * Then at most 60 blocks at the top level and 300 in all (a group, its sections and their blocks
 * counted), a section or group that does not fit whole keeping its first blocks or sections; at
 * most 20 images in all, those in sections and groups counted, the first kept; then within 96 KiB
 * as UTF-8 JSON, the block that passes it keeping its first rows that fit, and none after it.
 * `undefined` when none is left.
 */
export function boundedBlocks(
  blocks: readonly EmittedBlock[] | undefined,
): EmittedBlock[] | undefined {
  const kept: EmittedBlock[] = [];
  let total = 0;
  let pictures = 0;
  const take = (): boolean => {
    if (pictures === L.images) return false;
    pictures += 1;
    return true;
  };
  for (const value of blocks ?? []) {
    const rebuilt = block(value);
    if (rebuilt === undefined) continue;
    const one = within(rebuilt, L.total - total);
    if (one === undefined) break;
    const shown = images(one, take);
    if (shown === undefined) continue;
    kept.push(shown);
    total += counted(shown);
    if (kept.length === L.topLevel || total === L.total) break;
  }
  if (blocksBytes(kept) > L.bytes) {
    let used = 2;
    for (const [index, one] of kept.entries()) {
      const comma = index === 0 ? 0 : 1;
      const cut = fit(one, L.bytes - used - comma);
      if (cut !== one) {
        kept.splice(index, kept.length - index, ...(cut === undefined ? [] : [cut]));
        break;
      }
      used += comma + blocksBytes(one);
    }
  }
  return kept.length === 0 ? undefined : kept;
}
