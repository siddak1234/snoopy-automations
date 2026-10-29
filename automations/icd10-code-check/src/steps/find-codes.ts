import type { Step } from '@autom8x/automation-sdk';

import { candidatesFor } from '../candidates.js';
import { familiesOf } from '../families.js';
import { readingOf } from '../reading.js';
import { loadTable, type TableId } from '../tables.js';

/**
 * Code choices found: real codes for each diagnosis, from that year's code table (code alone,
 * `candidates.ts`). Only the visit's table is loaded; the state keeps each diagnosis's codes, and
 * `match-codes` reads their titles from the same table.
 */
export const findCodes: Step = ({ state }) => {
  const reading = readingOf(state.reading);
  const { codes } = loadTable(state.table as TableId);
  const families = familiesOf(
    Array.isArray(state.specialties) ? (state.specialties as string[]) : [],
  );
  const candidates = reading.diagnoses.map((diagnosis) =>
    candidatesFor(diagnosis, codes, families, reading.codesOnNote),
  );
  return Promise.resolve({
    outcome: 'ok',
    summary: 'Code choices found',
    state: { ...state, candidates },
  });
};
