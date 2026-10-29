import type { JsonObject } from '@autom8x/automation-sdk';

import type { View } from './blocks.js';
import type { Ask, Row } from './checks.js';
import { readingOf } from './reading.js';

/** What the blocks read of the run's state, after `check-codes`. */
export function viewOf(state: JsonObject): View {
  const reading = readingOf(state.reading);
  return {
    patient: reading.patient,
    visitDate: typeof state.visitDate === 'string' ? state.visitDate : null,
    tableName: String(state.tableName ?? ''),
    rows: (Array.isArray(state.rows) ? state.rows : []) as Row[],
    asks: (Array.isArray(state.asks) ? state.asks : []) as Ask[],
    titles: (state.titles ?? {}) as Record<string, string>,
    directions: reading.directions,
  };
}
