import { familiesOf, inFamily } from './families.js';
import type { Diagnosis, Reading } from './reading.js';
import { specialtyChecks } from './specialty-checks.js';
import { normalCode, notesOf, type CodeTable, type TableNote } from './tables.js';
import { REASONS, type Verdict } from './words.js';

/**
 * `check-codes` (the spec, section 7, "The checks"): code alone, in the spec's order — the general
 * checks G1–G7 on every code here, then the specialty checks (`specialty-checks.ts`) for the
 * specialties chosen. A row is one note code (in the note's order) or one code to add; its
 * verdict is Keep, Change, Add, Remove, Move up or Ask. An ask is shown, never decided.
 */
export interface Row {
  /** `n1`… for the note's codes, `a1`… for the codes to add: the decision's id once offered. */
  id: string;
  /** The note's code, or the code to add. */
  code: string;
  verdict: Verdict;
  /** The code a Change or an Add puts on the chart; null otherwise. */
  suggested: string | null;
  /** The checks that decided it ("G2", "L1, L3"). */
  check: string;
  /** The note's words it rests on: the statement's, as `match-codes` quoted it. */
  quote: string | null;
  /** Why, in `words.md`'s words; null for a Keep. */
  reason: string | null;
  /** Placed before the kidney disease stage code when the chart is written (L1, L2, L3). */
  first?: boolean;
  /** The diagnosis it rests on, by index. */
  from?: number;
}

/** One ask for the doctor: about a code (its row's) or a diagnosis with no code. */
export interface Ask {
  title: string;
  reason: string | null;
  check: string;
}

export interface Checked {
  rows: Row[];
  asks: Ask[];
}

export interface CheckInput {
  reading: Pick<Reading, 'codesOnNote' | 'diagnoses'>;
  /** Per diagnosis index: the code `match-codes` picked through gate B, and its quote. */
  matches: Readonly<Record<string, { code: string; quote: string }>>;
  codes: CodeTable;
  notes: Readonly<Record<string, TableNote[]>>;
  tableName: string;
  specialties: readonly string[];
}

/** Stated as certain, by the provider, assessed or treated at this visit. */
export const supported = (d: Diagnosis): boolean =>
  d.certainty === 'confirmed' && d.byProvider && d.thisVisit;

/** The code table's chapter of symptoms and signs: G4 codes those in place of an uncertain diagnosis. */
const isSymptom = (code: string): boolean => code >= 'R00' && code < 'S00';

export function runChecks(input: CheckInput): Checked {
  const { reading, matches, codes } = input;
  const noteCodes = [...new Set(reading.codesOnNote.map(normalCode))];
  const onNote = new Set(noteCodes);
  const used = new Set<number>();
  const rows: Row[] = [];
  const asks: Ask[] = [];
  const matched = (index: number) => matches[String(index)];
  const indexes = reading.diagnoses.map((_, index) => index);
  const quoteOf = (index: number) => matched(index)?.quote ?? null;
  const row = (code: string, verdict: Verdict, fields: Partial<Row>): Row => ({
    id: `n${rows.length + 1}`,
    code,
    verdict,
    suggested: null,
    check: '',
    quote: null,
    reason: null,
    ...fields,
  });
  const symptomFor = (): number | undefined =>
    indexes.find((j) => {
      const code = matched(j)?.code;
      return (
        !used.has(j) &&
        supported(reading.diagnoses[j]!) &&
        code !== undefined &&
        isSymptom(code) &&
        !onNote.has(code)
      );
    });

  for (const code of noteCodes) {
    const exact = indexes.filter((i) => matched(i)?.code === code);
    const sameCategory = indexes.filter((i) => {
      const other = matched(i)?.code;
      return (
        other !== undefined &&
        other !== code &&
        other.slice(0, 3) === code.slice(0, 3) &&
        !onNote.has(other)
      );
    });
    const better = sameCategory.find((i) => !used.has(i) && supported(reading.diagnoses[i]!));
    if (!(code in codes)) {
      // G1: not a flag-1 code of the visit's table.
      const reason = REASONS.G1(code, input.tableName);
      if (better === undefined) rows.push(row(code, 'ask', { check: 'G1', reason }));
      else {
        used.add(better);
        rows.push(
          row(code, 'change', {
            suggested: matched(better)!.code,
            check: 'G1',
            reason,
            quote: quoteOf(better),
            from: better,
          }),
        );
      }
      continue;
    }
    if (exact.length > 0) {
      const index = exact.find((i) => supported(reading.diagnoses[i]!)) ?? exact[0]!;
      const d = reading.diagnoses[index]!;
      used.add(index);
      if (supported(d)) {
        rows.push(row(code, 'keep', { check: 'G2', quote: quoteOf(index), from: index }));
      } else if (d.certainty === 'uncertain') {
        // G4: the confirmed sign or symptom in its place, else ask.
        const symptom = symptomFor();
        if (symptom === undefined)
          rows.push(
            row(code, 'ask', { check: 'G4', reason: REASONS.G4ask, quote: quoteOf(index) }),
          );
        else {
          used.add(symptom);
          const fields = {
            suggested: matched(symptom)!.code,
            check: 'G4',
            reason: REASONS.G4change,
            quote: quoteOf(symptom),
            from: symptom,
          };
          rows.push(row(code, 'change', fields));
        }
      } else {
        // G5: only staff mention it, or it was not assessed at this visit.
        const reason = d.byProvider ? REASONS.G5visit : REASONS.G5staff;
        rows.push(row(code, 'ask', { check: 'G5', reason, quote: quoteOf(index) }));
      }
      continue;
    }
    if (better !== undefined) {
      // G3: a different code in the same category is the one the note supports.
      used.add(better);
      rows.push(
        row(code, 'change', {
          suggested: matched(better)!.code,
          check: 'G3',
          reason: REASONS.G3,
          quote: quoteOf(better),
          from: better,
        }),
      );
      continue;
    }
    // G6: no diagnosis supports it; no code offered in its place.
    rows.push(row(code, 'ask', { check: 'G6', reason: REASONS.G6 }));
  }

  // G7: a supported diagnosis with no code on the note is added — every one when the note prints none.
  const suggested = new Set(
    rows.map((r) => r.suggested).filter((code): code is string => code !== null),
  );
  let adds = 0;
  for (const index of indexes) {
    const d = reading.diagnoses[index]!;
    if (used.has(index) || !supported(d)) continue;
    const code = matched(index)?.code;
    if (code === undefined) {
      asks.push({ title: `“${d.statement}”`, reason: REASONS.G7, check: 'G7' });
      continue;
    }
    if (onNote.has(code) || suggested.has(code)) continue;
    suggested.add(code);
    adds += 1;
    rows.push({
      id: `a${adds}`,
      code,
      verdict: 'add',
      suggested: code,
      check: 'G7',
      quote: quoteOf(index),
      reason: REASONS.G7,
      from: index,
    });
  }

  specialtyChecks({ ...input, rows, asks, onNote });
  const rowAsks = rows.filter((r) => r.verdict === 'ask');
  asks.unshift(
    ...rowAsks.map((r) => ({ title: titled(r.code, codes), reason: r.reason, check: r.check })),
  );
  tableNotes(input, rows, asks, familiesOf(input.specialties));
  return { rows, asks };
}

/** "N18.4 · Chronic kidney disease, stage 4 (severe)", or the code alone when the table has none. */
export const titled = (code: string, codes: CodeTable): string =>
  code in codes ? `${code} · ${codes[code]}` : code;

/** The codes the chart would carry if every change were accepted. */
export function chartCodes(rows: readonly Row[]): string[] {
  return rows
    .filter((r) => r.verdict !== 'remove')
    .map((r) => (r.verdict === 'change' || r.verdict === 'add' ? r.suggested! : r.code));
}

/** A code, a range ("N18.1-N18.4") or a category with its dash ("I12.-") in a table note. */
const CODE_IN_NOTE =
  /\b([A-Z]\d{2}(?:\.[0-9A-Z]{1,4})?)(?:-([A-Z]\d{2}(?:\.[0-9A-Z]{1,4})?)|\.?-)?/gu;

/** Whether a chart code is the one a table note names, under it, or inside its range. */
const covers = (on: string, from: string, to: string | undefined): boolean =>
  to === undefined
    ? on.startsWith(from)
    : (on >= from || on.startsWith(from)) && (on <= to || on.startsWith(to));

/**
 * T1: a code-table note ("code first", "use additional code") on a note's code in a chosen
 * specialty's families, none of whose codes is on the chart: ask, in the table's own words (the
 * owner, ~16:22Z, "Follow code-table notes"). A note K2 has answered (Z99.2) is not asked twice.
 */
function tableNotes(
  input: CheckInput,
  rows: readonly Row[],
  asks: Ask[],
  families: readonly string[],
): void {
  const chart = chartCodes(rows);
  const asked = new Set(asks.map((ask) => ask.reason));
  const k2 = asks.some((ask) => ask.check === 'K2') || rows.some((r) => r.check.includes('K2'));
  for (const r of rows) {
    if (r.id.startsWith('a') || r.verdict === 'remove' || !inFamily(r.code, families)) continue;
    for (const note of notesOf(input.notes, r.code)) {
      const named = [...note.note.matchAll(CODE_IN_NOTE)].map((m) => [m[1]!, m[2]] as const);
      if (named.length === 0) continue;
      if (k2 && named.every(([code, to]) => code === 'Z99.2' && to === undefined)) continue;
      if (named.some(([from, to]) => chart.some((on) => covers(on, from, to)))) continue;
      const reason = REASONS.T1(`${note.kind} ${note.note}`);
      if (asked.has(reason)) continue;
      asked.add(reason);
      asks.push({ title: titled(r.code, input.codes), reason, check: 'T1' });
    }
  }
}
