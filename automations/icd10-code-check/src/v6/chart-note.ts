import { Buffer } from 'node:buffer';

import type { JsonObject } from '@autom8x/automation-sdk';

import { realDate } from '../tables.js';
import type { DiagnosisCode } from './codes.js';
import { WORDS_V6 } from './words.js';

/**
 * Every choice of what an upload writes to the EHR, in this one module (README, "v6", row 4): how
 * the patient and the visit are searched, and the chart note — a FHIR R4 DocumentReference. **Each
 * is the session's choice, to verify in Epic's sandbox** (BUILD-PLAN 30.21.4): US Core's "Writing
 * Clinical Notes" (https://hl7.org/fhir/us/core/writing-clinical-notes.html, read 2026-11-25) says
 * a client "SHALL supply status, type, category, subject, content, and
 * content.attachment.contentType" and a server "SHALL accept: text/plain; charset=utf-8"; Epic's
 * own required fields for "DocumentReference.Create (Clinical Notes) (R4)" are not published
 * outside its specification pages, which need a browser (BUILD-PLAN U44).
 */

/**
 * The patient by the record number the note prints, its value alone (`identifier=<mrn>`): an
 * organisation's MRN system is not known — Epic's sandbox's is
 * `urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.14`, and "this system value will differ in each
 * customer environment" (https://fhir.epic.com/Documentation?docId=testpatients). Open question.
 * A value alone can match a patient whose OTHER identifier has the same characters, so the one
 * match is written to only when its `birthDate` is the note's too (`birthDateOf`).
 */
export const patientSearch = (recordNumber: string): JsonObject => ({ identifier: recordNumber });

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** A month's number, 1 to 12, from its name or its first three letters or more; else 0. */
const monthOf = (word: string): number =>
  word.length >= 3 ? MONTHS.findIndex((month) => month.startsWith(word)) + 1 : 0;

/**
 * The birth date the note prints (`read-note`'s `patient.birthDate`, "exactly as printed"), as a
 * FHIR `date`, `YYYY-MM-DD`, to compare with the one patient's `birthDate`: year first
 * (`1958-03-14`, `1958/3/14`), the month first as a US note prints it (`03/14/1958`, `3-14-1958`),
 * or the month's name (`March 14, 1958`, `14 Mar 1958`) — the year always of four digits, the
 * date a real one. Anything else is undefined: no date is guessed.
 */
export function birthDateOf(printed: string): string | undefined {
  const words = printed
    .trim()
    .toLowerCase()
    .split(/[\s,./-]+/u)
    .filter((word) => word !== '');
  if (words.length !== 3) return undefined;
  const named = words.findIndex((word) => /^\p{L}+$/u.test(word));
  let year: string, month: string, day: string;
  if (named >= 0) {
    const [first, second] = words.filter((_, index) => index !== named) as [string, string];
    const number = monthOf(words[named]!);
    if (number === 0) return undefined;
    month = String(number);
    [year, day] = /^\d{4}$/u.test(first) ? [first, second] : [second, first];
  } else if (/^\d{4}$/u.test(words[0]!)) [year, month, day] = words as [string, string, string];
  else [month, day, year] = words as [string, string, string];
  if (!/^\d{4}$/u.test(year) || !/^\d{1,2}$/u.test(month) || !/^\d{1,2}$/u.test(day)) {
    return undefined;
  }
  return realDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
}

/** The visit: the patient's encounters on the visit's date (`date=YYYY-MM-DD`, FHIR's day). */
export const visitSearch = (patientId: string, visitDate: string): JsonObject => ({
  patient: patientId,
  date: visitDate,
});

/**
 * A record number the search takes as it is: letters, digits, dots and hyphens, at most 64 — no
 * FHIR search character (`|`, `,`, `$`, `\`).
 */
export const RECORD_NUMBER = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,63}$/u;

/** The note's status: in force (DocumentReference.status, `current`). */
export const NOTE_STATUS = 'current';

/** The note's type: LOINC 34109-9, "Note" — no US Core "Common Clinical Notes" kind is a code review. */
export const NOTE_TYPE = {
  coding: [{ system: 'http://loinc.org', code: '34109-9', display: 'Note' }],
};

/** The note's category: US Core's `clinical-note`. */
export const NOTE_CATEGORY = [
  {
    coding: [
      {
        system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category',
        code: 'clinical-note',
        display: 'Clinical Note',
      },
    ],
  },
];

/** The note's content type: the plain text every US Core server accepts. */
export const NOTE_CONTENT_TYPE = 'text/plain; charset=utf-8';

/** The note's words: a heading, then each approved code with its name and the line on why. */
export const chartNoteText = (codes: readonly DiagnosisCode[]): string =>
  [
    WORDS_V6.noteHeading,
    ...codes.map((one) => WORDS_V6.noteLine(one.code, one.display, one.reason)),
  ].join('\n');

/** The DocumentReference `notes.create` sends: the fields above, the patient and the visit. */
export const chartNote = (
  patientId: string,
  encounterId: string,
  codes: readonly DiagnosisCode[],
): JsonObject => ({
  resourceType: 'DocumentReference',
  status: NOTE_STATUS,
  type: NOTE_TYPE,
  category: NOTE_CATEGORY,
  subject: { reference: `Patient/${patientId}` },
  context: { encounter: [{ reference: `Encounter/${encounterId}` }] },
  content: [
    {
      attachment: {
        contentType: NOTE_CONTENT_TYPE,
        data: Buffer.from(chartNoteText(codes), 'utf8').toString('base64'),
      },
    },
  ],
});
