import { truncateText } from './contract.js';

/*
 * The parts `blocks.ts` holds every block to (platform ADR-0048 decision 3 and its amendment 1):
 * the platform's limits, its one rule for a string and a url, and the small field helpers. As
 * the platform keeps its own in `snoopy-backend/packages/contracts/src/blocks-checks.ts`.
 */

/**
 * The platform's bounds on blocks: its `BLOCK_LIMITS`
 * (`snoopy-backend/packages/contracts/src/blocks-checks.ts`, ADR-0048 decision 3 and amendment 1),
 * key for key and number for number, which its result route, its emitted schema and its tests
 * share. The schema says all but `total`, `bytes` and `images`.
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
  /** Image blocks in all, at every depth: the job's file cap (amendment 1, point 2). */
  images: 20,
  /** A bar chart's most points; a line's least and most (amendment 1, point 3). */
  chartBars: 24,
  chartPointsMinimum: 2,
  chartPoints: 60,
  /** A chart value's largest size, either side of 0. */
  chartValue: 1e15,
  /** An image's `alt`, one line. */
  altLength: 200,
  /** A group's sections: as many as a run's (amendment 1, point 12; its `RUN_SECTION_LIMITS`). */
  groupSections: 12,
} as const;

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
export function line(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const kept = truncateText(value.replace(/\s+/gu, ' ').trim(), max).trimEnd();
  return kept !== '' && sendable(kept, false) ? kept : undefined;
}

/** Text that keeps its line breaks (a carriage return made one), trimmed and cut whole at `max`. */
export function lines(value: unknown, max: number): string | undefined {
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
  if (value.length > BLOCK_LIMITS.urlLength || !HTTPS.test(value) || !sendable(value, false)) {
    return false;
  }
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

export const url = (value: unknown): string | undefined =>
  typeof value === 'string' && isBlockUrl(value.trim()) ? value.trim() : undefined;

export const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  (values as readonly unknown[]).includes(value) ? (value as T) : undefined;

export const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** The object without its undefined fields, so an optional field is left off, never sent empty. */
export const defined = <T>(fields: Record<string, unknown>): T =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

/** The first `max` entries `bound` keeps. */
export function first<T>(
  value: unknown,
  max: number,
  bound: (entry: unknown) => T | undefined,
): T[] {
  const kept: T[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const one = bound(entry);
    if (one !== undefined) kept.push(one);
    if (kept.length === max) break;
  }
  return kept;
}
