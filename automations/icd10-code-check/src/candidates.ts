import { inFamily } from './families.js';
import type { Diagnosis } from './reading.js';
import { normalCode, type CodeTable } from './tables.js';

/** The most candidates one diagnosis is offered (the spec, section 4, "The candidates"). */
export const MAX_CANDIDATES = 60;

/**
 * The words of a text as the ranking compares them: lowercased, punctuation left out, and only
 * words of 3 or more letters or digits ("CKD stage 4" is `ckd`, `stage`).
 */
export function wordsIn(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 3),
  );
}

/**
 * `find-codes`, code alone: for each diagnosis, every flag-1 code of the visit's table under its
 * categories — the note's own codes there are in the table or not offered at all, since no code
 * of another table is ever offered — ranked by the number of words its title shares with the
 * diagnosis's statement (`wordsIn`), then the shorter codes, then the table's order (the owner,
 * 2026-10-28 ~23:17Z, "Rank by matching words"). At most 60; the chosen specialties' family codes
 * and the note's own codes in the categories are always among them — the note's first, then the
 * families' in rank order, then the rest — listed in rank order. A category the table does not
 * hold adds nothing; a diagnosis with none is an ask (`checks.ts`).
 */
export function candidatesFor(
  diagnosis: Diagnosis,
  codes: CodeTable,
  families: readonly string[],
  codesOnNote: readonly string[],
): string[] {
  const categories = new Set(diagnosis.categories);
  const said = wordsIn(diagnosis.statement);
  const shared = (code: string) =>
    [...wordsIn(codes[code] ?? '')].filter((word) => said.has(word)).length;
  const ranked = Object.keys(codes)
    .filter((code) => categories.has(code.slice(0, 3)))
    .map((code, order) => ({ code, order, shared: shared(code) }))
    .sort((a, b) => b.shared - a.shared || a.code.length - b.code.length || a.order - b.order)
    .map((entry) => entry.code);
  if (ranked.length <= MAX_CANDIDATES) return ranked;
  const own = new Set(codesOnNote.map(normalCode).filter((code) => ranked.includes(code)));
  const family = ranked.filter((code) => !own.has(code) && inFamily(code, families));
  const rest = ranked.filter((code) => !own.has(code) && !inFamily(code, families));
  const kept = new Set([...own, ...family, ...rest].slice(0, MAX_CANDIDATES));
  return ranked.filter((code) => kept.has(code));
}

/** One diagnosis as `match-codes` reads it: its index, its words without the patient, its list. */
export interface MatchInput {
  diagnosis: number;
  statement: string;
  certainty: string;
  evidence: string | null;
  candidates: { number: number; code: string; title: string }[];
}

/**
 * Gate B (the spec, section 7): a pick is kept only when its number is one of that diagnosis's
 * listed numbers, its code is flag 1 in the visit's table, and its quote is in the statement that
 * was sent, word for word (`p4-vendors-6`); else the diagnosis is an ask and nothing it named is
 * shown. 0 is "none fits": no code.
 */
export function gateB(
  sent: readonly MatchInput[],
  answer: unknown,
  codes: CodeTable,
): Map<number, { code: string; quote: string }> {
  const kept = new Map<number, { code: string; quote: string }>();
  const matches =
    typeof answer === 'object' &&
    answer !== null &&
    Array.isArray((answer as { matches?: unknown }).matches)
      ? ((answer as { matches: unknown[] }).matches as Record<string, unknown>[])
      : [];
  const answered = new Set<number>();
  for (const match of matches) {
    const index = match?.diagnosis;
    const input = sent.find((one) => one.diagnosis === index);
    if (input === undefined || answered.has(input.diagnosis)) continue;
    answered.add(input.diagnosis);
    const choice = match.choice;
    const quote = typeof match.quote === 'string' ? match.quote.trim() : '';
    const picked = input.candidates.find((candidate) => candidate.number === choice);
    if (picked === undefined || !(picked.code in codes) || quote === '') continue;
    if (!squeeze(input.statement).includes(squeeze(quote))) continue;
    kept.set(input.diagnosis, { code: picked.code, quote });
  }
  return kept;
}

const squeeze = (text: string): string => text.replace(/\s+/gu, ' ').trim();
