import { createHash } from 'node:crypto';

import { MEMORY_LIMITS, isObject, type JsonObject } from '@autom8x/automation-sdk';

/**
 * The clinic's memory (the spec's v2 section, row 2: "learned later from what each clinic
 * accepts"): the codes its people accepted, each with how many times, kept in the workspace under
 * one key through the platform's flow memory. Read by `rank-codes`, written by `save-visit`.
 */
export const ACCEPTED_KEY = 'accepted-codes';

/** At most this many codes are kept, the most accepted first: well inside the memory's value bound. */
export const ACCEPTED_KEPT = 1_500;

const CODE = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/u;

/** The kept counts, by code; anything out of shape read as none. */
export function acceptedOf(value: unknown): Record<string, number> {
  if (!isObject(value) || !isObject(value.codes)) return {};
  return Object.fromEntries(
    Object.entries(value.codes).filter(
      ([code, count]) => CODE.test(code) && Number.isInteger(count) && (count as number) > 0,
    ) as [string, number][],
  );
}

/** The counts with each newly accepted code once more, the most accepted `ACCEPTED_KEPT` kept. */
export function remember(
  before: Readonly<Record<string, number>>,
  accepted: readonly string[],
): { codes: Record<string, number> } {
  const counts = { ...before };
  for (const code of new Set(accepted)) counts[code] = (counts[code] ?? 0) + 1;
  const kept = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, ACCEPTED_KEPT);
  const value = { codes: Object.fromEntries(kept) };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MEMORY_LIMITS.valueBytes) {
    throw new Error('the accepted codes pass the memory bound');
  }
  return value;
}

/**
 * The clinic's examples (the owner's L1–L5, 2026-11-01): each saved review decision, de-identified
 * — its statement with names, numbers and dates taken out, the code chosen and the verdict — kept
 * under one key by code family (the code's three-character category), newest first. `rank-codes`
 * reads them, `match-codes` sends at most `EXAMPLES_SENT` a diagnosis after the prompt's fixed
 * examples, never past gate B; `save-visit` writes them, or clears them when the setup's "Learn
 * from this clinic's reviews" is off.
 */
export const EXAMPLES_KEY = 'clinic-examples';

/** At most this many examples a family are kept. */
export const EXAMPLES_KEPT = 20;
/**
 * At most this many examples are sent with one diagnosis in a match call (the owner, 2026-11-03),
 * so no more of a family are read.
 */
export const EXAMPLES_SENT = 3;

export interface Example {
  id: string;
  statement: string;
  code: string;
  verdict: 'accepted' | 'denied';
}

/** Per family, its examples, newest first. */
export type Examples = Record<string, Example[]>;

/** Whether the clinic learns: the setup's toggle, on unless turned off. */
export const learning = (config: JsonObject): boolean => config.learn !== false;

/** The kept examples; anything out of shape read as none. */
export function examplesOf(value: unknown): Examples {
  if (!isObject(value) || !isObject(value.families)) return {};
  const out: Examples = {};
  for (const [family, list] of Object.entries(value.families)) {
    if (!/^[A-Z][0-9][0-9A-Z]$/u.test(family) || !Array.isArray(list)) continue;
    out[family] = list.filter(
      (one): one is Example =>
        isObject(one) &&
        typeof one.id === 'string' &&
        typeof one.statement === 'string' &&
        typeof one.code === 'string' &&
        (one.verdict === 'accepted' || one.verdict === 'denied'),
    );
  }
  return out;
}

/** A month's name beside a number ("Oct 12", "12 October"): its date's words. */
const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DATED = new RegExp(`\\b${MONTH}\\s*#|#\\s*${MONTH}(?![\\p{L}])`, 'giu');

/**
 * A statement with names, numbers and dates taken out: the patient's values and other
 * identifiers already "[patient]" (`withoutPatient`), then a titled name ("Dr. Lee"), every run of
 * digits ("#") and a month's name beside one.
 */
export const deidentified = (statement: string): string =>
  statement
    .replace(/\b(?:Dr|DR|dr|Mr|Mrs|Ms)\.?\s+\p{Lu}[\p{L}'-]*/gu, '[name]')
    .replace(/\p{N}+/gu, '#')
    .replace(DATED, '#')
    .replace(/\s+/gu, ' ')
    .trim();

/** An example, its id the first 12 hex of its fields' digest. */
export function exampleOf(statement: string, code: string, verdict: Example['verdict']): Example {
  const id = createHash('sha256').update(`${statement}\n${code}\n${verdict}`).digest('hex');
  return { id: id.slice(0, 12), statement, code, verdict };
}

/** The examples with each new one first in its family, each id once, `EXAMPLES_KEPT` a family, within the memory's bound. */
export function learn(before: Examples, added: readonly Example[]): { families: Examples } {
  const families: Examples = { ...before };
  for (const one of added) {
    const family = one.code.slice(0, 3);
    families[family] = [one, ...(families[family] ?? []).filter((e) => e.id !== one.id)].slice(
      0,
      EXAMPLES_KEPT,
    );
  }
  const value = { families };
  while (Buffer.byteLength(JSON.stringify(value), 'utf8') > MEMORY_LIMITS.valueBytes) {
    const [family, list] = Object.entries(families).sort((a, b) => b[1].length - a[1].length)[0]!;
    families[family] = list.slice(0, -1);
  }
  return value;
}

/** The newest `EXAMPLES_SENT` examples of each family named, in the families' order. */
export const examplesFor = (examples: Examples, families: Iterable<string>): Example[] =>
  [...new Set(families)].flatMap((family) => (examples[family] ?? []).slice(0, EXAMPLES_SENT));
