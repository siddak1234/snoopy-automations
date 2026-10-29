import { isObject, type JsonObject } from '@autom8x/automation-sdk';

/**
 * `read-note`'s answer (the spec, section 4), as the steps keep it in the run's state. The platform
 * holds the answer to the prompt's schema; this reads it again on the way out of the state, so a
 * step never trusts a shape it did not check.
 */
export interface Patient {
  name: string | null;
  birthDate: string | null;
  sex: string | null;
  recordNumber: string | null;
  provider: string | null;
}

export interface Diagnosis {
  statement: string;
  certainty: 'confirmed' | 'uncertain';
  byProvider: boolean;
  thisVisit: boolean;
  evidence: string | null;
  unrelatedTo: number[];
  categories: string[];
}

export interface Reading {
  isVisitNote: boolean;
  readable: boolean;
  patientCount: number;
  patient: Patient;
  visitDate: string | null;
  codesOnNote: string[];
  diagnoses: Diagnosis[];
  otherIdentifiers: string[];
  directions: string[];
}

export const PATIENT_KEYS = ['name', 'birthDate', 'sex', 'recordNumber', 'provider'] as const;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter((one): one is string => one !== null) : [];

function diagnosisOf(value: unknown): Diagnosis | undefined {
  if (!isObject(value)) return undefined;
  const statement = text(value.statement);
  if (statement === null) return undefined;
  return {
    statement,
    certainty: value.certainty === 'uncertain' ? 'uncertain' : 'confirmed',
    byProvider: value.byProvider === true,
    thisVisit: value.thisVisit === true,
    evidence: text(value.evidence),
    unrelatedTo: Array.isArray(value.unrelatedTo)
      ? value.unrelatedTo.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0)
      : [],
    categories: texts(value.categories)
      .map((category) => category.toUpperCase())
      .filter((category) => /^[A-Z][0-9A-Z]{2}$/u.test(category))
      .slice(0, 3),
  };
}

/** The reading, from the model's answer or the state; anything out of shape read as not printed. */
export function readingOf(value: unknown): Reading {
  const source: JsonObject = isObject(value) ? value : {};
  const patient = isObject(source.patient) ? source.patient : {};
  return {
    isVisitNote: source.isVisitNote === true,
    readable: source.readable === true,
    patientCount: Number.isInteger(source.patientCount) ? (source.patientCount as number) : 0,
    patient: Object.fromEntries(
      PATIENT_KEYS.map((key) => [key, text(patient[key])]),
    ) as unknown as Patient,
    visitDate: text(source.visitDate),
    codesOnNote: texts(source.codesOnNote),
    diagnoses: Array.isArray(source.diagnoses)
      ? source.diagnoses.map(diagnosisOf).filter((d): d is Diagnosis => d !== undefined)
      : [],
    otherIdentifiers: texts(source.otherIdentifiers),
    directions: texts(source.directions),
  };
}

/**
 * The privacy rule (the spec, section 4, "Left out"): every `patient` value and every
 * `otherIdentifiers` value replaced by "[patient]" in a statement or a piece of evidence before it
 * is sent to `match-codes` — whole words, in any case, the longest first — and each word of the
 * name too, so "Ms. Doe" goes as well as "Jane Doe".
 */
export function withoutPatient(
  words: string,
  reading: Pick<Reading, 'patient' | 'otherIdentifiers'>,
): string {
  const name = reading.patient.name ?? '';
  const values = [
    ...PATIENT_KEYS.map((key) => reading.patient[key]),
    ...reading.otherIdentifiers,
    ...name.split(/\s+/u).filter((part) => part.replace(/\W/gu, '').length >= 3),
  ]
    .filter((value): value is string => value !== null && value.trim() !== '')
    .map((value) => value.trim())
    .sort((a, b) => b.length - a.length);
  let out = words;
  for (const value of values) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'),
      '[patient]',
    );
  }
  return out;
}
