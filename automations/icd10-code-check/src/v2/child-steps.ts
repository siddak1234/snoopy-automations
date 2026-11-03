import {
  failed,
  held,
  settle,
  type JsonObject,
  type Step,
  type StepResult,
  type UnitArtifact,
} from '@autom8x/automation-sdk';

import { gateB, type MatchInput } from '../candidates.js';
import { prompt } from '../prompts.js';
import { readingOf, withoutPatient, type Reading } from '../reading.js';
import {
  TABLE_NAMES,
  loadTable,
  normalCode,
  pickTable,
  realDate,
  type TableId,
} from '../tables.js';
import { askModel, atOnce, auditOf, type AuditRecord } from './audit.js';
import { FAILURES, WORDS } from '../words.js';
import {
  loadPreferences,
  preferredFamilies,
  rankCandidates,
  specialtiesForRun,
  taxonomiesOf,
} from './candidates.js';
import { lookUp, loadIndex } from './lookup.js';
import {
  ACCEPTED_KEY,
  EXAMPLES_KEY,
  EXAMPLES_SENT,
  acceptedOf,
  examplesFor,
  examplesOf,
  learning,
  type Example,
} from './memory.js';
import { labelsOf, npiOf, pickedSpecialties, specialtyOptions, v1NamesOf } from './specialties.js';
import { WORDS_V2 } from './words.js';

/**
 * A visit's run, the first half (the spec's v2 section; each batch unit is one child run): the
 * visit received from its unit, the specialties from the NPI when none are picked, the note read
 * page range by page range, the note checked, the code choices found and matched. The review and
 * the save are `review-steps.ts`; v1's `check-codes` runs between them unchanged.
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
 * Note read: `read-note` v2 on each of the unit's files, a PDF's page range at a time (the
 * platform cuts it), told the patient to read when a page holds another's too (`readOnly`), the
 * readings joined as one visit's (`mergeReadings`); each call's audit record kept.
 */
export const readVisit: Step = async (context) => {
  const { state, request } = context;
  const pieces = Array.isArray(state.pieces) ? (state.pieces as UnitArtifact[]) : [];
  const specialties = labelsOf(nucc(state)).join(', ') || 'any specialty';
  const only = request.unit?.data?.readOnly;
  const readOnly = typeof only === 'string' ? only : null;
  const readings: Reading[] = [];
  const audit: AuditRecord[] = [];
  for (const piece of pieces) {
    const asked = await askModel(
      context,
      prompt('read-note', 2),
      { specialties, readOnly },
      {
        artifactId: piece.artifactId,
        ...(piece.pages === undefined ? {} : { pages: piece.pages }),
      },
    );
    if (!asked.ok) return failed(asked.sentence, asked.kind);
    const reading = readingOf(asked.answer);
    readings.push(reading);
    audit.push({ ...asked.record, gate: `diagnoses read: ${reading.diagnoses.length}` });
  }
  const reading = mergeReadings(readings);
  return {
    outcome: 'ok',
    summary: 'Note read',
    state: {
      ...state,
      reading: { ...reading },
      specialties: v1NamesOf(nucc(state)),
      audit: audit.map((r) => ({ ...r })),
    },
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

/** The most code choices one diagnosis is sent with (the owner's audit fixes). */
export const MAX_CHOICES = 30;

/**
 * Code choices found: each diagnosis looked up in the official Alphabetic Index and verified in
 * the Tabular (`lookUp`), then every code under its categories ranked — the specialties'
 * preference families, the clinic's memory, the words shared (`rankCandidates`) — at most
 * `MAX_CHOICES`. A diagnosis whose lookup settles on a code the note prints is kept with no AI
 * (the owner's I2), its quote its statement. The clinic's examples of the families still to match
 * are read when it learns. A memory that cannot be read ranks and matches without it.
 */
export const rankCodes: Step = async (context) => {
  const { state, platform, request } = context;
  const reading = readingOf(state.reading);
  const table = state.table as TableId;
  const { codes } = loadTable(table);
  const index = loadIndex(table);
  const preferred = preferredFamilies(nucc(state), loadPreferences());
  const kept = await settle(context, () => platform.memory.get(ACCEPTED_KEY));
  const remembered = kept.ok ? acceptedOf(kept.value) : {};
  const onNote = new Set(reading.codesOnNote.map(normalCode));
  const settled: Record<string, { code: string; quote: string }> = {};
  const candidates = reading.diagnoses.map((diagnosis, at) => {
    const found = lookUp(diagnosis.statement, index, codes);
    if (found.settled !== null && onNote.has(found.settled)) {
      settled[String(at)] = { code: found.settled, quote: diagnosis.statement };
    }
    const ranked = rankCandidates(diagnosis, codes, preferred, remembered);
    return [...new Set([...found.codes, ...ranked])].slice(0, MAX_CHOICES);
  });
  const families = reading.diagnoses.flatMap((diagnosis, at) =>
    String(at) in settled
      ? []
      : [...diagnosis.categories, ...candidates[at]!.slice(0, 1).map((c) => c.slice(0, 3))],
  );
  let examples: Example[] = [];
  if (learning(request.config) && families.length > 0) {
    const read = await settle(context, () => platform.memory.get(EXAMPLES_KEY));
    if (read.ok) examples = examplesFor(examplesOf(read.value), families);
  }
  return {
    outcome: 'ok',
    summary: 'Code choices found',
    state: { ...state, candidates, settled, examples: examples.map((e) => ({ ...e })) },
  };
};

/** How many diagnoses one `match-codes` call is sent, and how many calls are asked at once. */
export const DIAGNOSES_A_CALL = 8;
export const CALLS_AT_ONCE = 3;

/**
 * Codes matched (v2): v1's `match-codes` on the diagnoses the lookup did not settle, in calls of
 * at most `DIAGNOSES_A_CALL`, `CALLS_AT_ONCE` at a time, with `match-codes` v2 — each call sent,
 * for each diagnosis, at most `EXAMPLES_SENT` of the clinic's examples of its families that
 * `rank-codes` read, in the order read, after the prompt's own, their ids in its audit record — and
 * every pick held to gate B (`gateB`), examples or not. The run's counts go to `measures`.
 */
export const matchVisit: Step = async (context) => {
  const { state } = context;
  const reading = readingOf(state.reading);
  const { codes } = loadTable(state.table as TableId);
  const lists = Array.isArray(state.candidates) ? (state.candidates as string[][]) : [];
  const settled = (state.settled ?? {}) as Record<string, { code: string; quote: string }>;
  const examples = Array.isArray(state.examples) ? (state.examples as unknown as Example[]) : [];
  const sent: MatchInput[] = reading.diagnoses
    .map((diagnosis, index) => ({
      diagnosis: index,
      statement: withoutPatient(diagnosis.statement, reading),
      certainty: diagnosis.certainty,
      evidence: diagnosis.evidence === null ? null : withoutPatient(diagnosis.evidence, reading),
      candidates: (lists[index] ?? []).map((code, at) => ({
        number: at + 1,
        code,
        title: codes[code] ?? code,
      })),
    }))
    .filter((input) => input.candidates.length > 0 && !(String(input.diagnosis) in settled));
  const calls: MatchInput[][] = [];
  for (let at = 0; at < sent.length; at += DIAGNOSES_A_CALL) {
    calls.push(sent.slice(at, at + DIAGNOSES_A_CALL));
  }
  const matches: Record<string, { code: string; quote: string }> = { ...settled };
  const audit: AuditRecord[] = [];
  let stop: { sentence: string; kind: string } | undefined;
  await atOnce(calls.length, CALLS_AT_ONCE, async (at) => {
    const call = calls[at]!;
    // Each diagnosis its first `EXAMPLES_SENT` of its families' examples, in the order read.
    const chosen = new Set(
      call.flatMap((input) => {
        const families = new Set([
          ...reading.diagnoses[input.diagnosis]!.categories,
          input.candidates[0]!.code.slice(0, 3),
        ]);
        return examples.filter((e) => families.has(e.code.slice(0, 3))).slice(0, EXAMPLES_SENT);
      }),
    );
    const clinic = examples.filter((e) => chosen.has(e));
    const asked = await askModel(
      context,
      prompt('match-codes', 2),
      {
        clinicExamples: clinic.map(({ statement, code, verdict }) => ({
          statement,
          code,
          verdict,
        })),
        diagnoses: call.map((input) => ({ ...input })),
      },
      {},
      clinic.map((e) => e.id),
    );
    if (!asked.ok) {
      stop ??= { sentence: asked.sentence, kind: asked.kind };
      return false;
    }
    const picks = gateB(call, asked.answer, codes);
    for (const [index, match] of picks) matches[String(index)] = match;
    audit[at] = { ...asked.record, gate: `gate B kept ${picks.size} of ${call.length}` };
    return true;
  });
  if (stop !== undefined) return failed(stop.sentence, stop.kind);
  const { candidates: _c, settled: _s, examples: _e, ...rest } = state;
  const used = new Set(audit.flatMap((r) => r.examples));
  return {
    outcome: 'ok',
    summary: 'Codes matched',
    state: {
      ...rest,
      matches,
      audit: [...auditOf(state), ...audit].map((r) => ({ ...r })),
      measures: {
        diagnoses: reading.diagnoses.length,
        settled: Object.keys(settled).length,
        sent: sent.length,
        kept: Object.keys(matches).length - Object.keys(settled).length,
        examplesUsed: used.size,
      },
    },
  };
};
