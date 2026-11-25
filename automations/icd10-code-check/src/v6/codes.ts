import type { DecisionAnswer } from '@autom8x/automation-sdk';

import type { Row } from '../checks.js';
import { DECIDED, finalCodes } from '../decisions.js';
import { whyDetail } from '../v2/review.js';
import { WORDS_V6 } from './words.js';

/**
 * The codes v6 gives a visit, each with its name and one line on why (README, "v6", rows 3 and 4):
 * a hook run's `output.diagnosisCodes`, the one shape the platform's card reads (its ADR-0051
 * Amendment 2, point 3: 1 to 12 entries of exactly `{code, system, display, reason}`, an ICD-10-CM
 * code each once, `display` one line of at most 300 characters, `reason` one line of at most 200;
 * anything else is no card), and an upload's chart note's lines. Both are the visit's final codes
 * (`finalCodes`), in the chart's order, leaving out every code the checks leave to the doctor
 * (an Ask): the card's with every change accepted (`everyChange`, the session's choice: the
 * clinician's tick is the approval), the note's with the person's answers.
 */

/** ICD-10-CM's FHIR system, as the card's codings name it. */
export const ICD10_CM = 'http://hl7.org/fhir/sid/icd-10-cm';

/** The most codes one card offers: a CMS-1500 claim's diagnosis codes. */
export const CARD_CODES = 12;

/** An ICD-10-CM code as the card takes it: a letter, a digit, a letter or digit, then up to four. */
export const ICD10_CM_CODE = /^[A-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/u;

export interface DiagnosisCode {
  code: string;
  system: typeof ICD10_CM;
  display: string;
  reason: string;
}

/** `text` on one line — no control character — of at most `max` characters, cut at a word with "…". */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > max / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/** Every change of the visit accepted: what the card offers, the clinician choosing among them. */
export const everyChange = (rows: readonly Row[]): Map<string, DecisionAnswer> =>
  new Map(rows.filter((r) => DECIDED.has(r.verdict)).map((r) => [r.id, 'accepted' as const]));

/** The code a row puts on the chart, as `finalCodes` reads it: none for a Remove taken or an Add not. */
function codeOf(
  r: Row,
  answers: ReadonlyMap<string, DecisionAnswer>,
  others: ReadonlyMap<string, string>,
): string | undefined {
  const yes = DECIDED.has(r.verdict) && answers.get(r.id) === 'accepted';
  if (r.verdict === 'add') return yes ? r.code : undefined;
  if (r.verdict === 'remove' && yes) return undefined;
  if (r.verdict === 'change' && yes) return r.suggested ?? undefined;
  if (r.verdict === 'change' && answers.get(r.id) === 'other') return others.get(r.id);
  return r.code;
}

/**
 * Why a row's code is on the chart: the review's own "why" (`whyDetail`: the titles' difference,
 * the note's words, the rule) for a code kept or a change taken; for a note's code a denied change
 * left, or a code picked in a change's place, the review's part in it.
 */
function reasonOf(
  r: Row,
  answers: ReadonlyMap<string, DecisionAnswer>,
  titles: Readonly<Record<string, string>>,
  table: string,
): string {
  const answer = answers.get(r.id);
  if (answer === 'other') return WORDS_V6.pickedInReview;
  if (DECIDED.has(r.verdict) && answer !== 'accepted') return WORDS_V6.keptInReview;
  return whyDetail(r, titles, table) ?? WORDS_V6.supported;
}

/** The visit's codes, each `{code, system, display, reason}`, at most `max`. */
export function visitCodes(
  rows: readonly Row[],
  answers: ReadonlyMap<string, DecisionAnswer>,
  titles: Readonly<Record<string, string>>,
  table: string,
  others: ReadonlyMap<string, string> = new Map(),
  max = CARD_CODES,
): DiagnosisCode[] {
  const kept = rows.filter((r) => r.verdict !== 'ask');
  const why = new Map<string, Row>();
  for (const r of kept) {
    const code = codeOf(r, answers, others);
    if (code !== undefined && !why.has(code)) why.set(code, r);
  }
  return finalCodes(kept, answers, others)
    .filter((code) => ICD10_CM_CODE.test(code) && why.has(code))
    .slice(0, max)
    .map((code) => ({
      code,
      system: ICD10_CM,
      display: oneLine(titles[code] ?? code, 300),
      reason: oneLine(reasonOf(why.get(code)!, answers, titles, table), 200),
    }));
}
