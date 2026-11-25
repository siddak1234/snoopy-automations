import { failed, type Step } from '@autom8x/automation-sdk';

import { prompt } from '../prompts.js';
import { readingOf, type Reading } from '../reading.js';
import { WORDS } from '../words.js';
import { askModel, type AuditRecord } from '../v2/audit.js';
import { mergeReadings } from '../v2/child-steps.js';
import { labelsOf, pickedSpecialties, v1NamesOf } from '../v2/specialties.js';
import { notesOf } from './paths.js';

/**
 * A hook run's own steps where v5's read a file (README, "v6", row 3): the visit received with no
 * file, its notes' texts read by `read-note` v3, and the note checked with no hold. Everything
 * after them — the specialties, the code choices, the match, the checks — is v5's, unchanged.
 */

const nucc = (state: Record<string, unknown>): string[] =>
  Array.isArray(state.nucc) ? (state.nucc as string[]) : [];

/** Visit received: the chart's visit, no file; the setup's specialties, as an upload's. */
export const receiveChart: Step = ({ request, state }) =>
  Promise.resolve({
    outcome: 'ok',
    summary: 'Visit received',
    state: { ...state, pieces: [], nucc: pickedSpecialties(request.config) },
  });

/**
 * Note read: `read-note` v3 on each note's text, as v5's `readVisit` reads each file — the
 * readings joined as one visit's (`mergeReadings`), each call's audit record kept. Only the
 * patient's own notes were read, so `readOnly` is null.
 */
export const readNotes: Step = async (context) => {
  const { state } = context;
  const specialties = labelsOf(nucc(state)).join(', ') || 'any specialty';
  const readings: Reading[] = [];
  const audit: AuditRecord[] = [];
  for (const noteText of notesOf(state)) {
    const asked = await askModel(context, prompt('read-note', 3), {
      specialties,
      readOnly: null,
      noteText,
    });
    if (!asked.ok) return failed(asked.sentence, asked.kind);
    const reading = readingOf(asked.answer);
    readings.push(reading);
    audit.push({ ...asked.record, gate: `diagnoses read: ${reading.diagnoses.length}` });
  }
  return {
    outcome: 'ok',
    summary: 'Note read',
    state: {
      ...state,
      reading: { ...mergeReadings(readings) },
      specialties: v1NamesOf(nucc(state)),
      audit: audit.map((r) => ({ ...r })),
    },
  };
};

/**
 * Note checked, with no hold: v5's check, but a visit whose code table this build lacks (the April
 * 2026 hold, never on this build: `TABLES` holds it) stops — a held hook run shows no card, and
 * the clinician's tick on the card is the approval (ADR-0051 Amendment 2, point 5).
 */
export const neverHeld =
  (check: Step): Step =>
  async (context) => {
    const checked = await check(context);
    return checked.outcome === 'held' ? failed(WORDS.aprilHold, 'no_table') : checked;
  };
