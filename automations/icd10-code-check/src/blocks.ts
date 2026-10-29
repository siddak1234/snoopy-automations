import type {
  DecisionAnswer,
  EmittedBlock,
  EmittedLeaf,
  SectionBlock,
} from '@autom8x/automation-sdk';

import type { Ask, Row } from './checks.js';
import { DECIDED, cleanQuote, labelOf, suggestedOf, withTitle } from './decisions.js';
import { PATIENT_KEYS, type Patient } from './reading.js';
import { VERDICTS, WORDS } from './words.js';

/**
 * What a person reads of a run (the spec, section 7, "Blocks"): built here, sent through the
 * SDK's `boundedBlocks` by `decide` and the result (`automation.ts`), never as `sections` or
 * `details`. Three views: held for the review, not held (nothing to decide), and after the review.
 */
export interface View {
  patient: Patient;
  /** The visit's date as `YYYY-MM-DD`, or null when the note prints none. */
  visitDate: string | null;
  tableName: string;
  rows: readonly Row[];
  asks: readonly Ask[];
  /** The title of every code the run names, from the visit's table. */
  titles: Readonly<Record<string, string>>;
  directions: readonly string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-12` → "Oct 12, 2026". */
export function dateWords(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${day}, ${year}`;
}

/** "Jane Doe · Oct 12, 2026"; "Visit · Oct 12, 2026" with no name printed; "Visit note" with neither. */
export function titleOf(view: Pick<View, 'patient' | 'visitDate'>): string {
  const date = view.visitDate === null ? null : dateWords(view.visitDate);
  if (date === null) return WORDS.titlePlain;
  return view.patient.name === null
    ? WORDS.titleDated(date)
    : WORDS.titleNamed(view.patient.name, date);
}

const titled = (view: View, code: string): string => withTitle(code, view.titles);

/** (1) The patient, as read from the note: a row left out when not printed. */
function patientSection(view: View): SectionBlock {
  const values: Record<string, string | null> = {
    ...view.patient,
    visitDate: view.visitDate && dateWords(view.visitDate),
  };
  const order = [...PATIENT_KEYS.slice(0, 4), 'visitDate', 'provider'] as const;
  const rows = order
    .filter((key) => values[key] !== null && values[key] !== undefined)
    .map((key) => ({ cells: [WORDS.patientRows[key], values[key]!] }));
  return {
    type: 'section',
    title: WORDS.patient,
    blocks: [{ type: 'table', columns: WORDS.patientColumns.map((title) => ({ title })), rows }],
  };
}

/** (3) One row per code: the note's in order, then each to add; after the review, Accepted or Denied. */
function codeTable(view: View, answers?: ReadonlyMap<string, DecisionAnswer>): EmittedLeaf {
  return {
    type: 'table',
    columns: WORDS.codeColumns.map((title) => ({ title })),
    rows: view.rows.map((r) => {
      const answer = answers?.get(r.id);
      const verdict =
        answers !== undefined && DECIDED.has(r.verdict) && answer !== undefined
          ? VERDICTS[answer]
          : VERDICTS[r.verdict];
      return { cells: [titled(view, r.code), verdict, suggestedOf(r, view.titles)] };
    }),
  };
}

/** (4) One section per change, its reason and the note's words. */
function changeSections(view: View): SectionBlock[] {
  return view.rows
    .filter((r) => DECIDED.has(r.verdict))
    .map((r) => {
      const quote = r.quote === null ? '' : cleanQuote(r.quote);
      return {
        type: 'section',
        title: labelOf(r, view.titles),
        ...(r.reason === null ? {} : { subtitle: r.reason }),
        blocks:
          quote === ''
            ? [{ type: 'text', text: r.reason ?? labelOf(r, view.titles) }]
            : [{ type: 'list', items: [{ title: WORDS.fromNote, subtitle: quote }] }],
      };
    });
}

/** (5) The asks for the doctor. */
function askSection(view: View): SectionBlock[] {
  if (view.asks.length === 0) return [];
  const items = view.asks.map((ask) => ({
    title: ask.title,
    ...(ask.reason === null ? {} : { subtitle: ask.reason }),
  }));
  return [{ type: 'section', title: WORDS.asks, blocks: [{ type: 'list', items }] }];
}

/** (6) Text in the note that tries to direct its reader, and (7) the footer, the date's notice first. */
function tail(view: View): EmittedBlock[] {
  return [
    ...view.directions.map((direction): EmittedBlock => ({
      type: 'text',
      text: WORDS.directions(cleanQuote(direction)),
      tone: 'warning',
    })),
    ...(view.visitDate === null
      ? [{ type: 'text', text: WORDS.noVisitDate, style: 'muted' } as const]
      : []),
    { type: 'text', text: WORDS.footer(view.tableName), style: 'muted' },
  ];
}

const counts = (view: View) => ({
  kept: view.rows.filter((r) => r.verdict === 'keep').length,
  changes: view.rows.filter((r) => DECIDED.has(r.verdict)).length,
  asks: view.asks.length,
});

/** Held for the review: (1) to (7). */
export function heldBlocks(view: View): EmittedBlock[] {
  const n = counts(view);
  return [
    patientSection(view),
    {
      type: 'metric',
      items: [
        { label: WORDS.metrics.kept, value: String(n.kept), tone: 'success' },
        { label: WORDS.metrics.changes, value: String(n.changes), tone: 'warning' },
        { label: WORDS.metrics.asks, value: String(n.asks), tone: 'warning' },
      ],
    },
    codeTable(view),
    ...changeSections(view),
    ...askSection(view),
    ...tail(view),
  ];
}

/** Nothing to decide: a badge when every code is supported, then (1), (3), the asks, (6), (7). */
export function keptBlocks(view: View): EmittedBlock[] {
  return [
    ...(view.asks.length === 0
      ? [{ type: 'badge', text: WORDS.allSupported, tone: 'success' } as const]
      : []),
    patientSection(view),
    codeTable(view),
    ...askSection(view),
    ...tail(view),
  ];
}

/** After the review: the answers, the codes to enter, then (1) to (7) with each answer. */
export function doneBlocks(
  view: View,
  answers: ReadonlyMap<string, DecisionAnswer>,
  codes: readonly string[],
): EmittedBlock[] {
  const a = [...answers.values()].filter((answer) => answer === 'accepted').length;
  const d = [...answers.values()].filter((answer) => answer === 'denied').length;
  const n = counts(view);
  return [
    { type: 'badge', text: WORDS.answered(a, d), tone: d === 0 ? 'success' : 'neutral' },
    {
      type: 'section',
      title: WORDS.toEnter,
      blocks: [
        {
          type: 'table',
          columns: WORDS.toEnterColumns.map((title) => ({ title })),
          rows: codes.map((code) => ({ cells: [code, view.titles[code] ?? ''] })),
        },
      ],
    },
    patientSection(view),
    {
      type: 'metric',
      items: [
        { label: WORDS.metrics.kept, value: String(n.kept), tone: 'success' },
        { label: WORDS.metrics.changes, value: String(n.changes), tone: 'warning' },
        { label: WORDS.metrics.asks, value: String(n.asks), tone: 'warning' },
      ],
    },
    codeTable(view, answers),
    ...changeSections(view),
    ...askSection(view),
    ...tail(view),
  ];
}
