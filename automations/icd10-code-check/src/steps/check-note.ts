import { failed, held, type JsonObject, type Step, type StepResult } from '@autom8x/automation-sdk';

import { readingOf } from '../reading.js';
import { TABLE_NAMES, pickTable, realDate, type TableId } from '../tables.js';
import { FAILURES, WORDS } from '../words.js';

/** The most diagnoses one visit may hold (the spec, section 8: our choice, section 11). */
export const MAX_DIAGNOSES = 40;

/** The most codes one note may print: each may be a change, and the review takes at most 40. */
export const MAX_CODES_ON_NOTE = 40;

export interface CheckNoteOptions {
  /** The day the run starts, `YYYY-MM-DD`: the table for a note that prints no visit date. */
  today: () => string;
  /** The tables this build holds (`tables.ts`). */
  tables: readonly TableId[];
}

/**
 * Note checked (gate A, the spec's section 7): one patient's visit note that can be read, at most
 * 40 diagnoses and at most 40 codes on the note (the owner, 2026-10-28 ~23:17Z, "Stop past 40
 * changes"), and a visit date that picks a table — the day the run starts when the note prints
 * none, said on the result. Each failure stops in section 8's words. Between Apr 1 and Sep 30,
 * 2026 with no April table in the build, the run is held for a person; approved, it goes on with
 * the October table, the one this build holds for 2026.
 */
export const checkNote =
  (options: CheckNoteOptions): Step =>
  ({ state }) =>
    Promise.resolve(gateA(state, options));

function gateA(state: JsonObject, options: CheckNoteOptions): StepResult {
  {
    const reading = readingOf(state.reading);
    if (!reading.readable) return failed(FAILURES.unreadable, 'unreadable');
    if (!reading.isVisitNote || reading.patientCount < 1)
      return failed(FAILURES.notVisitNote, 'not_visit_note');
    if (reading.patientCount > 1) return failed(FAILURES.patients, 'patients');
    if (reading.diagnoses.length > MAX_DIAGNOSES) return failed(FAILURES.tooMany, 'too_many');
    if (reading.codesOnNote.length > MAX_CODES_ON_NOTE)
      return failed(FAILURES.tooManyChanges, 'too_many_changes');
    const visitDate = realDate(reading.visitDate) ?? null;
    const pick = pickTable(visitDate ?? options.today(), options.tables);
    if (pick.kind === 'early') return failed(FAILURES.tooEarly, 'too_early');
    if (pick.kind === 'late') return failed(FAILURES.tooLate, 'too_late');
    const table: TableId = pick.kind === 'table' ? pick.table : '2026-oct';
    const next = { ...state, visitDate, table, tableName: TABLE_NAMES[table] };
    if (pick.kind === 'hold') {
      return held({ summary: 'Note checked', heldReason: WORDS.aprilHold, state: next });
    }
    return { outcome: 'ok', summary: 'Note checked', state: next };
  }
}
