import { inFamily } from './families.js';
import type { Diagnosis } from './reading.js';
import { normalCode, type CodeTable } from './tables.js';

/** The most candidates one diagnosis is offered (the spec, section 4, "The candidates"). */
export const MAX_CANDIDATES = 60;

/**
 * `find-codes`, code alone: for each diagnosis, every flag-1 code of the visit's table under its
 * categories — the note's own codes there are in the table or not offered at all, since no code
 * of another table is ever offered — at most 60, the chosen specialties' families first (the
 * owner, ~21:24Z, "Families first, then clinic"), then within each the shorter codes, then the
 * table's order (review finding 1, 2026-10-28: E11 holds 87 codes, so in the table's order alone
 * E11.65, E11.8 and E11.9 were always cut), the note's own codes kept inside the 60. A category the table does not hold adds nothing; a diagnosis with none is
 * an ask (`checks.ts`).
 */
export function candidatesFor(
  diagnosis: Diagnosis,
  codes: CodeTable,
  families: readonly string[],
  codesOnNote: readonly string[],
): string[] {
  const categories = new Set(diagnosis.categories);
  const under = Object.keys(codes).filter((code) => categories.has(code.slice(0, 3)));
  // Ranked by the first family that holds it, in the specialties' order and each one's own order
  // (Nephrology's N00-N29 before its I12-I13); the rest after. Within a rank the shorter, less
  // specific codes first, so a category's subcategories survive the cap; then the table's order.
  const rank = (code: string) => {
    const at = families.findIndex((family) => inFamily(code, [family]));
    return at < 0 ? families.length : at;
  };
  const ranked = under
    .map((code, order) => ({ code, order, rank: rank(code) }))
    .sort((a, b) => a.rank - b.rank || a.code.length - b.code.length || a.order - b.order)
    .map((entry) => entry.code);
  if (ranked.length <= MAX_CANDIDATES) return ranked;
  const own = new Set(codesOnNote.map(normalCode).filter((code) => ranked.includes(code)));
  const room = MAX_CANDIDATES - own.size;
  const kept = new Set([...ranked.filter((code) => !own.has(code)).slice(0, room), ...own]);
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
