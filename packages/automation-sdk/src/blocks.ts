import { Buffer } from 'node:buffer';

import {
  BLOCK_TONES,
  TABLE_ALIGNS,
  TEXT_STYLES,
  TIMELINE_STATES,
  type BlockBadge,
  type EmittedBlock,
  type EmittedLeaf,
  type ListItem,
  type MetricBlock,
  type TableBlock,
  type TableColumn,
  type TableRow,
  type TimelineBlock,
} from './block-types.js';
import { isObject, truncateText, type JsonObject } from './contract.js';
import { ARTIFACT_ID_PATTERN } from './model-request.js';

/*
 * A result's `blocks` held to the platform's one rule for them before they are sent (platform
 * ADR-0048 decision 3): the limits, the string and url rules, and `boundedBlocks`, which cuts or
 * leaves out what the platform would refuse. The shapes are `block-types.ts`.
 */

/**
 * The platform's bounds on blocks: its `BLOCK_LIMITS`
 * (`snoopy-backend/packages/contracts/src/blocks-validation.ts`, ADR-0048 decision 3), which its
 * result route, its emitted schema and its tests share. The schema says all but `total` and `bytes`.
 */
export const BLOCK_LIMITS = {
  /** Blocks at the top level, 1 to this; and in all, sections' blocks counted. */
  topLevel: 60,
  total: 300,
  /** As UTF-8 JSON: 96 KiB of blocks and 128 KiB of documents fit a 256 KiB callback. */
  bytes: 96 * 1024,
  sectionBlocks: 40,
  metricItems: 4,
  tableColumnsMinimum: 2,
  tableColumns: 3,
  tableRows: 200,
  listItems: 100,
  timelineItems: 50,
  /** A text block's text, line breaks kept. */
  textLength: 2000,
  titleLength: 120,
  /** A subtitle, a note, a cell, a list's empty line. */
  lineLength: 200,
  listTextLength: 600,
  /** A label, a value, a badge, a lead. */
  wordLength: 40,
  urlLength: 2048,
} as const;

const L = BLOCK_LIMITS;

/** The platform's rule for every string a block carries (its `stringProblem`). */
const HALF_OR_NUL = /[\u0000\ud800-\udfff]/u;
/** Every control character but a tab and a line break. */
const CONTROL = /[\u0001-\u0008\u000b-\u001f\u007f-\u009f]/u;
/** A `<` that opens a tag, a closing tag, a comment or a declaration. */
const TAG = /<[A-Za-z!/?]/u;
/** How a url starts, in either case, with no white space: the schema's `pattern`, exactly. */
const HTTPS = /^[Hh][Tt][Tt][Pp][Ss]:\/\/[^\s]+$/u;

const sendable = (value: string, lines: boolean): boolean =>
  !HALF_OR_NUL.test(value) &&
  !CONTROL.test(value) &&
  (lines || !value.includes('\n')) &&
  !TAG.test(value);

/** One line: white space one space, trimmed, cut whole at `max`; undefined when empty or refused. */
function line(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const kept = truncateText(value.replace(/\s+/gu, ' ').trim(), max).trimEnd();
  return kept !== '' && sendable(kept, false) ? kept : undefined;
}

/** Text that keeps its line breaks (a carriage return made one), trimmed and cut whole at `max`. */
function lines(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const kept = truncateText(value.replace(/\r\n?/gu, '\n').trim(), max).trimEnd();
  return kept !== '' && sendable(kept, true) ? kept : undefined;
}

/**
 * Whether the platform keeps this url: at most 2,048 characters, `https://` in either case with
 * no white space, nothing a page could misread, and a URL parser reading it as `https:` with a
 * host and no user or password — which a schema cannot say. Never cut: a cut url goes elsewhere.
 */
export function isBlockUrl(value: string): boolean {
  if (value.length > L.urlLength || !HTTPS.test(value) || !sendable(value, false)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname !== '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

const url = (value: unknown): string | undefined =>
  typeof value === 'string' && isBlockUrl(value.trim()) ? value.trim() : undefined;

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  (values as readonly unknown[]).includes(value) ? (value as T) : undefined;

const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** The object without its undefined fields, so an optional field is left off, never sent empty. */
const defined = <T>(fields: Record<string, unknown>): T =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

/** The first `max` entries `bound` keeps. */
function first<T>(value: unknown, max: number, bound: (entry: unknown) => T | undefined): T[] {
  const kept: T[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const one = bound(entry);
    if (one !== undefined) kept.push(one);
    if (kept.length === max) break;
  }
  return kept;
}

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
  file: (value) =>
    typeof value.fileId === 'string' && ARTIFACT_ID_PATTERN.test(value.fileId)
      ? defined({ type: 'file', fileId: value.fileId, title: line(value.title, L.titleLength) })
      : undefined,
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
};

/** A leaf of a type an automation may send; `questions`, a section and an unknown type are not. */
function leaf(value: unknown): EmittedLeaf | undefined {
  if (!isObject(value) || typeof value.type !== 'string') return undefined;
  return Object.hasOwn(LEAVES, value.type)
    ? LEAVES[value.type as EmittedLeaf['type']](value)
    : undefined;
}

function block(value: unknown): EmittedBlock | undefined {
  if (!isObject(value) || value.type !== 'section') return leaf(value);
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

/** The blocks' size as the platform counts it: UTF-8 bytes of their JSON (its `blocksBytes`). */
const blocksBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

const counted = (one: EmittedBlock): number => 1 + (one.type === 'section' ? one.blocks.length : 0);

/** The key a block's rows sit under, which a cut shortens from the end. */
const ROWS: Partial<Record<EmittedBlock['type'], string>> = {
  table: 'rows',
  list: 'items',
  timeline: 'items',
  metric: 'items',
  section: 'blocks',
};

/** The block within `room` bytes: whole, or its first rows (a section's last one cut too), else none. */
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
      const cut = one.type === 'section' ? fit(row, room - used - comma) : undefined;
      if (cut !== undefined) rows.push(cut);
      break;
    }
    rows.push(row);
    used += comma + bytes;
  }
  return rows.length === 0 ? undefined : ({ ...one, [key]: rows } as unknown as T);
}

/**
 * The blocks as the wire accepts them (ADR-0048 decision 3), cut or left out, never refused — a
 * run whose work is done must not become unreportable because a model wrote a long line, as
 * `boundedDetails` holds its lines. Each block is rebuilt from the fields its type takes; each
 * string cut whole at its bound (a one-line field made one line first); a string the platform
 * would refuse — empty, a NUL, half a surrogate pair, a control character but a tab and a line
 * break, anything shaped like an HTML tag — left off when optional, and its row or block left out
 * when required (a table's later cell left empty); a url that is not `https:` with a host, or
 * names a user or password, likewise; a file whose `fileId` is not an artifact id, `questions`, a
 * section inside a section and an unknown type, left out; each list at its bound, the first kept.
 * Then at most 60 blocks at the top level and 300 in all, a section that does not fit whole
 * keeping its first blocks; then within 96 KiB as UTF-8 JSON, the block that passes it keeping
 * its first rows that fit, and none after it. `undefined` when none is left.
 */
export function boundedBlocks(
  blocks: readonly EmittedBlock[] | undefined,
): EmittedBlock[] | undefined {
  const kept: EmittedBlock[] = [];
  let total = 0;
  for (const value of blocks ?? []) {
    let one = block(value);
    if (one === undefined) continue;
    const room = L.total - total;
    if (counted(one) > room) {
      if (one.type !== 'section' || room < 2) break;
      one = { ...one, blocks: one.blocks.slice(0, room - 1) };
    }
    kept.push(one);
    total += counted(one);
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
