import { isObject } from '@autom8x/automation-sdk';

import { readingOf, type Reading } from '../reading.js';

/**
 * v2's `read-note` answer (the spec, "v2 (draft, 2026-11-01)", F3): one file may hold several
 * visits, each read on its own — its patient, date, codes and diagnoses — and one patient per
 * visit. Each visit is read as v1 reads its one visit (`readingOf`), so a step never trusts a
 * shape it did not check; the file-wide answers (a visit note at all, readable, text that tries to
 * direct the reader) are read once.
 *
 * Seam: v1's prompt and step (`read-note.v1.json`, `automations/icd10-code-check/src/steps/read-note.ts`) are unchanged and still
 * served; the v2 prompt that answers `visits[]` is written with the step that sends it, once the
 * platform's v2 contract (several files, a review grouped by visit) is pinned.
 */
export type Visit = Pick<
  Reading,
  'patientCount' | 'patient' | 'visitDate' | 'codesOnNote' | 'diagnoses' | 'otherIdentifiers'
>;

export interface VisitsReading {
  isVisitNote: boolean;
  readable: boolean;
  visits: Visit[];
  directions: string[];
}

/** The reading of a v2 answer; anything out of shape is read as not printed. */
export function visitsOf(value: unknown): VisitsReading {
  const source = isObject(value) ? value : {};
  const file = readingOf(source);
  const visits = (Array.isArray(source.visits) ? source.visits : [])
    .filter(isObject)
    .map((one): Visit => {
      const read = readingOf(one);
      return {
        patientCount: read.patientCount,
        patient: read.patient,
        visitDate: read.visitDate,
        codesOnNote: read.codesOnNote,
        diagnoses: read.diagnoses,
        otherIdentifiers: read.otherIdentifiers,
      };
    });
  return {
    isVisitNote: file.isVisitNote,
    readable: file.readable,
    visits,
    directions: file.directions,
  };
}

/**
 * What v2's gate A stops on (its words are v1's where they still hold; the rest wait, the spec says).
 * No count of visits, diagnoses or codes stops here: a file stops only past the platform's limits
 * (the spec's "v2 (draft, 2026-11-01)", row 6), which `fileReview` (`review.ts`) applies.
 */
export type VisitsStop = 'notVisitNote' | 'unreadable' | 'noVisit' | 'patients';

/** Gate A, per visit: a visit note, readable, at least one visit, and each visit one patient. */
export function visitsGate(reading: VisitsReading): VisitsStop | undefined {
  if (!reading.isVisitNote) return 'notVisitNote';
  if (!reading.readable) return 'unreadable';
  if (reading.visits.length === 0) return 'noVisit';
  if (reading.visits.some((visit) => visit.patientCount !== 1)) return 'patients';
  return undefined;
}
