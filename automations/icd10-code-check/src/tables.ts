import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The code tables (the spec, section 7, "The visit date"): one per visit, picked by its date, and
 * only that one loaded — a table is about 7 MB of JSON, and the slot holds 88M (the menu's
 * `limits.slot.memory`), so the service keeps one table at a time (`automations/icd10-code-check/test/tables.test.ts` holds a
 * load under 40 MB of heap). Built by `automations/icd10-code-check/scripts/build-assets.ts` from the official files.
 */
export type TableId = '2026-oct' | '2026-apr' | '2027-oct';

/** Every table this build holds: the April 1, 2026 update was confirmed and built (2026-10-28). */
export const TABLES: readonly TableId[] = ['2026-oct', '2026-apr', '2027-oct'];

/** How a person reads each table's name, in "Checked against the {table} code set." and G1. */
export const TABLE_NAMES: Readonly<Record<TableId, string>> = {
  '2026-oct': '2026',
  '2026-apr': 'April 2026',
  '2027-oct': '2027',
};

export type TablePick =
  { kind: 'table'; table: TableId } | { kind: 'hold' } | { kind: 'early' } | { kind: 'late' };

/**
 * The table for a visit date (`YYYY-MM-DD`): 2025-10-01 to 2026-03-31 October's (`p4-rules-1`),
 * 2026-04-01 to 2026-09-30 April's — or a hold when this build has none (the owner, ~21:24Z) —
 * and 2026-10-01 to 2027-09-30 the 2027 table (`p4-rules-2`); any other date has none.
 */
export function pickTable(date: string, available: readonly TableId[] = TABLES): TablePick {
  if (date < '2025-10-01') return { kind: 'early' };
  if (date <= '2026-03-31') return { kind: 'table', table: '2026-oct' };
  if (date <= '2026-09-30') {
    return available.includes('2026-apr') ? { kind: 'table', table: '2026-apr' } : { kind: 'hold' };
  }
  if (date <= '2027-09-30') return { kind: 'table', table: '2027-oct' };
  return { kind: 'late' };
}

/** A date the note printed as `YYYY-MM-DD` that is a real day, or undefined. */
export function realDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));

/** A table's flag-1 codes, `code → title`, in the table's order. */
export type CodeTable = Readonly<Record<string, string>>;

/** One "code first" or "use additional code" note, as the table words it. */
export interface TableNote {
  kind: string;
  note: string;
}

let loaded:
  { id: TableId; codes: CodeTable; notes: Readonly<Record<string, TableNote[]>> } | undefined;

/** The visit's table and its notes; the one table held, replaced when another visit needs another. */
export function loadTable(id: TableId): {
  codes: CodeTable;
  notes: Readonly<Record<string, TableNote[]>>;
} {
  if (loaded?.id !== id) {
    loaded = undefined;
    const codes = JSON.parse(readFileSync(`${ASSETS}codes-${id}.json`, 'utf8')) as CodeTable;
    const notes = JSON.parse(readFileSync(`${ASSETS}code-notes-${id}.json`, 'utf8')) as Record<
      string,
      TableNote[]
    >;
    loaded = { id, codes, notes };
  }
  return loaded;
}

/** `n1831`, `N18.31 ` → `N18.31`: a code as printed, upper case and with its dot. */
export function normalCode(value: string): string {
  const bare = value.trim().toUpperCase().replace(/\./gu, '');
  return bare.length > 3 ? `${bare.slice(0, 3)}.${bare.slice(3)}` : bare;
}

/** A code's own notes and its parents' (`N18.6`, then `N18`), as the table writes them. */
export function notesOf(notes: Readonly<Record<string, TableNote[]>>, code: string): TableNote[] {
  const prefixes = new Set<string>();
  for (let end = code.length; end >= 3; end -= 1)
    prefixes.add(code.slice(0, end).replace(/\.$/u, ''));
  return [...prefixes].flatMap((prefix) => notes[prefix] ?? []);
}
