import type { DecisionAnswer, HeldDecision } from '@autom8x/automation-sdk';

import type { Row } from './checks.js';
import { WORDS } from './words.js';

/**
 * The review (the spec, section 7, "The review"): `decide` offers each Change, Add, Remove and
 * Move up as one decision — its id, a label and its reason with the quote — and `save` applies the
 * accepted ones only. An ask is shown, never decided: the note's code stays, for the doctor.
 */
export const DECIDED = new Set<Row['verdict']>(['change', 'add', 'remove', 'moveUp']);

/** A row's suggestion as the table and the labels show it: a code, "Remove" or "Move up". */
export const suggestionOf = (r: Row): string =>
  r.verdict === 'remove' ? 'Remove' : r.verdict === 'moveUp' ? 'Move up' : (r.suggested ?? '');

/** "N18.4 → Remove", "I10 → I12.9", "Add N17.9": the label of a row's change. */
export const labelOf = (r: Row): string =>
  r.verdict === 'add' ? WORDS.label.add(r.code) : WORDS.label.change(r.code, suggestionOf(r));

/** A quote as a person reads it: anything shaped like a tag cleaned out first (`p1-streamlining-9`). */
export const cleanQuote = (quote: string): string =>
  quote
    .replace(/<[^>]*>?/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

/** Each change of the run, as the held result offers it. */
export function decisionsOf(rows: readonly Row[]): HeldDecision[] {
  return rows
    .filter((r) => DECIDED.has(r.verdict))
    .map((r) => {
      const quote = r.quote === null ? '' : cleanQuote(r.quote);
      const detail =
        quote === '' ? (r.reason ?? '') : `${r.reason ?? ''} ${WORDS.fromNote}: “${quote}”`;
      return {
        id: r.id,
        label: labelOf(r),
        ...(detail.trim() === '' ? {} : { detail: detail.trim() }),
      };
    });
}

/**
 * The codes to enter: the note's codes in its order, each accepted change applied — a Change's
 * code in its place, a Remove left out — then each accepted Add; and every accepted code the
 * checks place first (L1, L2, L3) moved before the first kidney disease stage code (N18).
 */
export function finalCodes(
  rows: readonly Row[],
  answers: ReadonlyMap<string, DecisionAnswer>,
): string[] {
  const accepted = (r: Row) => DECIDED.has(r.verdict) && answers.get(r.id) === 'accepted';
  const chart: { code: string; first: boolean }[] = [];
  for (const r of rows) {
    const yes = accepted(r);
    if (r.verdict === 'add') {
      if (yes) chart.push({ code: r.code, first: r.first === true });
    } else if (r.verdict === 'remove' && yes) continue;
    else if (r.verdict === 'change' && yes)
      chart.push({ code: r.suggested!, first: r.first === true });
    else chart.push({ code: r.code, first: yes && r.first === true });
  }
  const stage = chart.findIndex((entry) => entry.code.startsWith('N18'));
  if (stage < 0) return [...new Set(chart.map((entry) => entry.code))];
  const ahead = chart.slice(stage).filter((entry) => entry.first);
  const ordered = [
    ...chart.slice(0, stage),
    ...ahead,
    ...chart.slice(stage).filter((entry) => !entry.first),
  ];
  return [...new Set(ordered.map((entry) => entry.code))];
}
