import type { Ask, CheckInput, Row } from './checks.js';
import { chartCodes, supported, titled } from './checks.js';
import type { Diagnosis } from './reading.js';
import type { CodeTable } from './tables.js';
import { REASONS } from './words.js';

/**
 * The specialty checks (the spec, section 7), each for the specialties its row names, after the
 * general ones and over their rows: K1–K3 kidney (Nephrology), L1–L3 the linked conditions. A
 * specialty check's verdict takes the place of a general one on the same code.
 */
interface Context extends CheckInput {
  rows: Row[];
  asks: Ask[];
  onNote: ReadonlySet<string>;
}

/** What a row puts on the chart if accepted: its suggestion, the code to add, or the note's code. */
const effective = (r: Row): string | null =>
  r.verdict === 'remove'
    ? null
    : r.verdict === 'change' || r.verdict === 'add'
      ? r.suggested
      : r.code;

/** E08.22–E13.22 (`p3-rules-12`), I12 and I13: coded before the N18 code. */
export const BEFORE_STAGE = (code: string): boolean =>
  /^E(08|09|10|11|13)\.22$/u.test(code) || code.startsWith('I12') || code.startsWith('I13');

/**
 * K2's support for dialysis (review finding 2, 2026-10-28): the patient is on it now — "on
 * hemodialysis", "dialysis-dependent" — in a clause with no word of refusal, negation or plan, so
 * "declines dialysis", "not on dialysis" and "dialysis access planned" are asks, never an Add.
 */
const ON_DIALYSIS =
  /\bon (?:chronic |maintenance |home )?(?:hemo|peritoneal )?dialysis\b|\b(?:hemo)?dialysis[- ]dependent\b/iu;
const NOT_NOW =
  /\b(?:declin|refus|not\b|no\b|never|without|plan|will\b|future|consider|discuss|access|prepar|evaluat|candidate|stop|withdr|held\b|off\b)/iu;

/** The words that show the patient is on dialysis now, or null. */
export function onDialysis(text: string): string | null {
  for (const clause of text.split(/[.;,]/u)) {
    const found = ON_DIALYSIS.exec(clause);
    if (found !== null && !NOT_NOW.test(clause)) return found[0];
  }
  return null;
}

export function specialtyChecks(c: Context): void {
  const has = (...names: string[]) => names.some((name) => c.specialties.includes(name));
  const { rows, asks, codes } = c;
  const diagnoses = c.reading.diagnoses;
  const chart = () => chartCodes(rows);

  if (has('Nephrology')) {
    // K1: N18.6 beside another N18 code: the stage code is removed (`p1-practice-7`).
    const esrd = rows.find((r) => effective(r) === 'N18.6');
    if (esrd !== undefined) {
      for (const r of [...rows]) {
        const code = effective(r);
        if (r === esrd || code === null || !code.startsWith('N18')) continue;
        if (r.verdict === 'add') rows.splice(rows.indexOf(r), 1);
        else
          Object.assign(r, {
            verdict: 'remove',
            suggested: null,
            check: 'K1',
            reason: REASONS.K1,
            quote: esrd.quote,
          });
      }
    }
    // K2: N18.6 without Z99.2: added when match-codes picked it or the note says the patient is on
    // dialysis now (`onDialysis`), else asked (`p3-rules-11`).
    if (chart().includes('N18.6')) {
      const added = rows.find((r) => r.verdict === 'add' && r.suggested === 'Z99.2');
      if (added !== undefined) Object.assign(added, { check: 'K2', reason: REASONS.K2change });
      else if (!chart().includes('Z99.2')) {
        const on = diagnoses.findIndex(
          (d) => supported(d) && onDialysis(`${d.statement}; ${d.evidence ?? ''}`) !== null,
        );
        if (on >= 0 && 'Z99.2' in codes) {
          const d = diagnoses[on]!;
          const quote = onDialysis(`${d.statement}; ${d.evidence ?? ''}`)!;
          rows.push(addRow(rows, 'Z99.2', 'K2', REASONS.K2change, quote, on));
        } else asks.push({ title: titled('N18.6', codes), reason: REASONS.K2ask, check: 'K2' });
      }
    }
    // K3: N18.9 and no stage in the note: asked, an earlier visit may give it (`p2-practice-11`).
    const unspecified = rows.find((r) => r.code === 'N18.9' && effective(r) === 'N18.9');
    if (
      unspecified !== undefined &&
      !chart().some((code) => code.startsWith('N18') && code !== 'N18.9')
    ) {
      asks.push({ title: titled('N18.9', codes), reason: REASONS.K3, check: 'K3' });
    }
  }

  // L1: I10 with an N18 code, not stated unrelated: I12 (`p2-practice-1`, `p2-practice-2`, `p1-practice-9`).
  if (
    has('Nephrology', 'Cardiology', 'Internal medicine', 'Family practice', 'Geriatric medicine')
  ) {
    const hypertension = rows.find((r) => effective(r) === 'I10');
    const kidney = rows.find((r) => effective(r)?.startsWith('N18'));
    if (
      hypertension !== undefined &&
      kidney !== undefined &&
      !unrelated(diagnoses, hypertension, kidney)
    ) {
      const late = chart().some((code) => code === 'N18.5' || code === 'N18.6');
      const target = late ? 'I12.0' : 'I12.9';
      if (target in codes) recode(hypertension, target, 'L1', REASONS.L1);
    }
  }

  // L2: hypertension, heart disease and CKD: I13, not I11 or I12 (`p2-practice-3`).
  if (has('Nephrology', 'Cardiology')) {
    const hypertension = rows.find((r) => /^I1[0-2]\b|^I1[12]\./u.test(effective(r) ?? ''));
    const now = chart();
    const heart = now.some((code) => code.startsWith('I11') || code.startsWith('I50'));
    const kidney = now.some((code) => code.startsWith('N18'));
    if (hypertension !== undefined && heart && kidney) {
      const target = i13For(
        codes,
        now.some((code) => code.startsWith('I50')),
        now.some((code) => code === 'N18.5' || code === 'N18.6'),
      );
      if (target !== undefined) recode(hypertension, target, 'L2', REASONS.L2);
    }
  }

  // L3: E08.22–E13.22, I12 or I13 after the N18 code: moved up (`p3-rules-12`).
  if (has('Nephrology', 'Internal medicine', 'Endocrinology')) {
    const noteRows = rows.filter((r) => r.id.startsWith('n'));
    const stage = noteRows.findIndex((r) => effective(r)?.startsWith('N18'));
    noteRows.forEach((r, index) => {
      const code = effective(r);
      if (stage < 0 || index < stage || code === null || !BEFORE_STAGE(code)) return;
      if (r.verdict === 'keep')
        Object.assign(r, {
          verdict: 'moveUp',
          suggested: null,
          check: 'L3',
          reason: REASONS.L3(code),
        });
      else if (r.verdict === 'change' && !r.check.includes('L3')) r.check = `${r.check}, L3`;
      r.first = true;
    });
  }
  // The codes to add go in the chart's order: those coded first before the stage code.
  const adds = rows.filter((r) => r.verdict === 'add');
  const ordered = [...adds.filter((r) => r.first), ...adds.filter((r) => !r.first)];
  rows.splice(
    rows.length - adds.length,
    adds.length,
    ...ordered.map((r, i) => ({ ...r, id: `a${i + 1}` })),
  );
}

function recode(r: Row, target: string, check: string, reason: string): void {
  if (r.verdict === 'add')
    Object.assign(r, { code: target, suggested: target, check, reason, first: true });
  else Object.assign(r, { verdict: 'change', suggested: target, check, reason, first: true });
}

function addRow(
  rows: readonly Row[],
  code: string,
  check: string,
  reason: string,
  quote: string,
  from: number,
): Row {
  const id = `a${rows.filter((r) => r.verdict === 'add').length + 1}`;
  return { id, code, verdict: 'add', suggested: code, check, quote, reason, from };
}

/** The note states the two diagnoses unrelated, either way round (`p1-practice-9`, `p3-practice-8`). */
function unrelated(diagnoses: readonly Diagnosis[], a: Row, b: Row): boolean {
  if (a.from === undefined || b.from === undefined) return false;
  return (
    (diagnoses[a.from]?.unrelatedTo.includes(b.from) ?? false) ||
    (diagnoses[b.from]?.unrelatedTo.includes(a.from) ?? false)
  );
}

/** The I13 code for heart failure or none, and stage 5 or ESRD or not, by the table's own titles. */
function i13For(codes: CodeTable, failure: boolean, endStage: boolean): string | undefined {
  return Object.keys(codes).find((code) => {
    if (!code.startsWith('I13')) return false;
    const title = codes[code]!;
    const hf = /with heart failure/u.test(title) && !/without heart failure/u.test(title);
    const late = /stage 5|end stage/u.test(title);
    return hf === failure && late === endStage;
  });
}
