import type { Step } from '@autom8x/automation-sdk';

import { runChecks } from '../checks.js';
import { readingOf } from '../reading.js';
import { loadTable, normalCode, type TableId } from '../tables.js';

/**
 * Codes checked: each code against the note and the coding rules (gate C, `checks.ts`). The state
 * keeps the rows, the asks and the title of every code they name, so the review and the result
 * read them without loading a table again.
 */
export const checkCodes: Step = ({ state }) => {
  const reading = readingOf(state.reading);
  const { codes, notes } = loadTable(state.table as TableId);
  const { rows, asks } = runChecks({
    reading,
    matches: (state.matches ?? {}) as Record<string, { code: string; quote: string }>,
    codes,
    notes,
    tableName: String(state.tableName),
    specialties: Array.isArray(state.specialties) ? (state.specialties as string[]) : [],
  });
  const named = [
    ...reading.codesOnNote.map(normalCode),
    ...rows.flatMap((r) => [r.code, r.suggested ?? '']),
  ];
  const titles = Object.fromEntries(
    named.filter((code) => code in codes).map((code) => [code, codes[code]!]),
  );
  return Promise.resolve({
    outcome: 'ok',
    summary: 'Codes checked',
    state: {
      ...state,
      rows: rows.map((r) => ({ ...r })),
      asks: asks.map((a) => ({ ...a })),
      titles,
    },
  });
};
