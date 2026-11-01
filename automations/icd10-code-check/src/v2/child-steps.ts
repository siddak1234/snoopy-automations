import {
  failed,
  held,
  readJsonCompletion,
  settle,
  type JsonObject,
  type Step,
  type StepResult,
  type UnitArtifact,
} from '@autom8x/automation-sdk';

import { MODELS } from '../models.js';
import { prompt } from '../prompts.js';
import { readingOf, type Reading } from '../reading.js';
import { TABLE_NAMES, loadTable, pickTable, realDate, type TableId } from '../tables.js';
import { FAILURES, WORDS } from '../words.js';
import {
  loadPreferences,
  preferredFamilies,
  rankCandidates,
  specialtiesForRun,
  taxonomiesOf,
} from './candidates.js';
import { acceptedOf, ACCEPTED_KEY } from './memory.js';
import { labelsOf, npiOf, pickedSpecialties, specialtyOptions, v1NamesOf } from './specialties.js';
import { WORDS_V2 } from './words.js';

/**
 * A visit's run, the first half (the spec's v2 section; each batch unit is one child run): the
 * visit received from its unit, the specialties from the NPI when none are picked, the note read
 * page range by page range, the note checked, and the code choices ranked. The review and the save
 * are `review-steps.ts`; v1's `match-codes` and `check-codes` run between them unchanged.
 */

const nucc = (state: JsonObject): string[] =>
  Array.isArray(state.nucc) ? (state.nucc as string[]) : [];

/** Visit received: the unit's files, each one this run may read, and the setup's specialties. */
export const receiveVisit: Step = async (context) => {
  const { request, platform } = context;
  const unit = request.unit;
  if (unit === undefined || unit.artifacts.length === 0) return failed(FAILURES.noFile, 'no_file');
  for (const artifact of unit.artifacts) {
    const found = await settle(context, () => platform.readArtifact(artifact.artifactId));
    if (!found.ok) return failed(found.sentence, found.kind);
  }
  return {
    outcome: 'ok',
    summary: 'Visit received',
    state: {
      pieces: unit.artifacts.map((a) => ({ ...a })),
      nucc: pickedSpecialties(request.config),
    },
  };
};

/**
 * Specialties found: when none are picked and the setup holds an NPI, the NPI Registry's
 * taxonomies (the keyless `nppes` provider, `npi.lookup`), only codes the dropdown holds. A lookup
 * that fails is shown and the run goes on with none.
 */
export const lookUpNpi: Step = async (context) => {
  const { request, state, platform } = context;
  const npi = npiOf(request.config);
  if (nucc(state).length > 0 || npi === undefined) return { outcome: 'skipped' };
  const asked = await settle(context, () =>
    platform.callProvider({ providerId: 'nppes', operation: 'npi.lookup', input: { number: npi } }),
  );
  if (!asked.ok || asked.value.status < 200 || asked.value.status >= 300) {
    return { outcome: 'failed', summary: WORDS_V2.npiNotRead, state };
  }
  const known = new Set(specialtyOptions().map((option) => option.value));
  const found = specialtiesForRun([], taxonomiesOf(asked.value.body), known);
  return { outcome: 'ok', summary: 'Specialties found', state: { ...state, nucc: found } };
};

/** Several readings of one visit's pages as one: the first printed value, every list in order. */
export function mergeReadings(readings: readonly Reading[]): Reading {
  const first = <T>(pick: (r: Reading) => T | null): T | null =>
    readings.map(pick).find((value) => value !== null) ?? null;
  const once = (lists: string[][]) => [...new Set(lists.flat())];
  let offset = 0;
  const diagnoses = readings.flatMap((r) => {
    const shifted = r.diagnoses.map((d) => ({
      ...d,
      unrelatedTo: d.unrelatedTo.map((index) => index + offset),
    }));
    offset += r.diagnoses.length;
    return shifted;
  });
  return {
    isVisitNote: readings.some((r) => r.isVisitNote),
    readable: readings.some((r) => r.readable),
    patientCount: Math.max(0, ...readings.map((r) => r.patientCount)),
    patient: {
      name: first((r) => r.patient.name),
      birthDate: first((r) => r.patient.birthDate),
      sex: first((r) => r.patient.sex),
      recordNumber: first((r) => r.patient.recordNumber),
      provider: first((r) => r.patient.provider),
    },
    visitDate: first((r) => r.visitDate),
    codesOnNote: once(readings.map((r) => r.codesOnNote)),
    diagnoses,
    otherIdentifiers: once(readings.map((r) => r.otherIdentifiers)),
    directions: once(readings.map((r) => r.directions)),
  };
}

/**
 * Note read: v1's `read-note` on each of the unit's files, a PDF's page range at a time (the
 * platform cuts it), the readings joined as one visit's (`mergeReadings`).
 */
export const readVisit: Step = async (context) => {
  const { state, platform } = context;
  const pieces = Array.isArray(state.pieces) ? (state.pieces as UnitArtifact[]) : [];
  const specialties = labelsOf(nucc(state)).join(', ') || 'any specialty';
  const readings: Reading[] = [];
  for (const piece of pieces) {
    const asked = await settle(context, () =>
      platform.callModel(
        prompt('read-note'),
        { specialties },
        {
          models: MODELS,
          artifactId: piece.artifactId,
          ...(piece.pages === undefined ? {} : { pages: piece.pages }),
        },
      ),
    );
    if (!asked.ok) return failed(asked.sentence, asked.kind);
    readings.push(readingOf(readJsonCompletion(asked.value)));
  }
  const reading = mergeReadings(readings);
  return {
    outcome: 'ok',
    summary: 'Note read',
    state: { ...state, reading: { ...reading }, specialties: v1NamesOf(nucc(state)) },
  };
};

/**
 * Note checked: v1's gate A without its counts (the spec's v2 section, row 6): readable, a visit
 * note, one patient, and a visit date that picks a table (today's when the note prints none).
 */
export const checkVisit =
  (options: { today: () => string; tables: readonly TableId[] }): Step =>
  ({ state }) =>
    Promise.resolve(gateV2(state, options));

function gateV2(
  state: JsonObject,
  options: { today: () => string; tables: readonly TableId[] },
): StepResult {
  const reading = readingOf(state.reading);
  if (!reading.readable) return failed(FAILURES.unreadable, 'unreadable');
  if (!reading.isVisitNote || reading.patientCount < 1)
    return failed(FAILURES.notVisitNote, 'not_visit_note');
  if (reading.patientCount > 1) return failed(FAILURES.patients, 'patients');
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

/**
 * Code choices found: every code under each diagnosis's categories, ranked — the specialties'
 * preference families, then the clinic's memory (the codes it accepted before), then the words
 * shared (`rankCandidates`). A memory that cannot be read ranks without it.
 */
export const rankCodes: Step = async (context) => {
  const { state, platform } = context;
  const reading = readingOf(state.reading);
  const { codes } = loadTable(state.table as TableId);
  const preferred = preferredFamilies(nucc(state), loadPreferences());
  const kept = await settle(context, () => platform.memory.get(ACCEPTED_KEY));
  const remembered = kept.ok ? acceptedOf(kept.value) : {};
  const candidates = reading.diagnoses.map((diagnosis) =>
    rankCandidates(diagnosis, codes, preferred, remembered),
  );
  return { outcome: 'ok', summary: 'Code choices found', state: { ...state, candidates } };
};
