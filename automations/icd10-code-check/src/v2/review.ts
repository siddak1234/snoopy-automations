import type {
  DecisionAnswer,
  EmittedBlock,
  HeldDecision,
  SectionBlock,
} from '@autom8x/automation-sdk';

import { codeTable, patientSection, titleOf, type View } from '../blocks.js';
import type { Row } from '../checks.js';
import { DECIDED, cleanQuote, decisionsOf, labelOf } from '../decisions.js';
import { WORDS } from '../words.js';
import { WORDS_V2 } from './words.js';

/**
 * v2's review (the spec, "v2 (draft, 2026-11-01)", F1 and F3): each visit's result and changes
 * grouped by visit, and each change's "why" — both codes' official titles side by side, the words
 * their titles differ by, the note's words and the check's rule — built from the blocks v1 already
 * sends (section, table, list, text).
 *
 * Seam: a decision's `group` and the 400 decisions of a held run are the platform's v2 contract;
 * `decide` still offers v1's flat list until it is pinned. `groupedDecisions` gives each visit's
 * decisions under its heading, ids unique across the run, ready to send as `group`.
 */

/** The words of a title, as a person reads them, each once: letters and digits, in order. */
const titleWords = (title: string): string[] => [
  ...new Map((title.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => [w.toLowerCase(), w])).values(),
];

/** The words only one of two titles holds (case aside), each side in its own title's order. */
export function titleDifference(
  noteTitle: string,
  suggestedTitle: string,
): { onlyNote: string[]; onlySuggested: string[] } {
  const note = titleWords(noteTitle);
  const suggested = titleWords(suggestedTitle);
  const has = (words: string[]) => new Set(words.map((w) => w.toLowerCase()));
  const inNote = has(note);
  const inSuggested = has(suggested);
  return {
    onlyNote: note.filter((w) => !inSuggested.has(w.toLowerCase())),
    onlySuggested: suggested.filter((w) => !inNote.has(w.toLowerCase())),
  };
}

/** The code each side of a change shows: the note's (none for an Add) and the suggestion's. */
function sides(r: Row): { note: string; suggested: string } {
  if (r.verdict === 'add') return { note: '', suggested: r.suggested ?? r.code };
  if (r.verdict === 'change') return { note: r.code, suggested: r.suggested ?? '' };
  return { note: r.code, suggested: r.verdict === 'remove' ? 'Remove' : 'Move up' };
}

/**
 * One change's "why": a section titled with its label (v1's "{code} → {suggested}"), its subtitle
 * the visit's title when the file holds several visits; a table — the note's code and title beside
 * the suggested's, from the visit's table — then a list: the words the titles differ by (a Change
 * only), the note's words, and the rule (the check's id and reason).
 */
export function whySection(
  r: Row,
  titles: Readonly<Record<string, string>>,
  visitTitle?: string,
): SectionBlock {
  const { note, suggested } = sides(r);
  const W = WORDS_V2.why;
  const title = (code: string) => titles[code] ?? '';
  const items: { title: string; subtitle?: string }[] = [];
  if (r.verdict === 'change') {
    const { onlyNote, onlySuggested } = titleDifference(title(note), title(suggested));
    const lines = [
      ...(onlyNote.length > 0 ? [W.onlyNote(onlyNote.join(', '))] : []),
      ...(onlySuggested.length > 0 ? [W.onlySuggested(onlySuggested.join(', '))] : []),
    ];
    items.push({ title: W.differ, subtitle: lines.length > 0 ? lines.join(' · ') : W.same });
  }
  const quote = r.quote === null ? '' : cleanQuote(r.quote);
  if (quote !== '') items.push({ title: W.fromNote, subtitle: quote });
  if (r.reason !== null) items.push({ title: W.rule, subtitle: W.ruleLine(r.check, r.reason) });
  return {
    type: 'section',
    title: labelOf(r, titles),
    ...(visitTitle === undefined ? {} : { subtitle: visitTitle }),
    blocks: [
      {
        type: 'table',
        columns: W.columns.map((t) => (t === '' ? {} : { title: t })),
        rows: [
          { cells: [W.code, note, suggested] },
          { cells: [W.title, title(note), title(suggested)] },
        ],
      },
      ...(items.length === 0 ? [] : [{ type: 'list' as const, items }]),
    ],
  };
}

/** One visit of a file, as v2's review reads it. */
export type VisitView = View;

/** Each visit's heading: its title (v1's), made unique when two visits read the same: "… (2)". */
export function visitTitles(views: readonly VisitView[]): string[] {
  const seen = new Map<string, number>();
  return views.map((view) => {
    const title = titleOf(view);
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    return n === 1 ? title : `${title} (${n})`;
  });
}

/** The most decisions one held run may offer, the platform round's B3 (v1's is 40). */
export const MAX_DECISIONS_V2 = 400;

/** A visit's decision id: `v{visit}-{row id}` ("v2-n1"), a step id's shape, unique in the run. */
export const decisionId = (visit: number, rowId: string): string => `v${visit + 1}-${rowId}`;

/**
 * Each visit's changes under its heading, in the visits' order: v1's decisions, each id made
 * unique by its visit. Undefined past 400 in all (the run stops, as v1 stops past 40).
 */
export function groupedDecisions(
  views: readonly VisitView[],
): { group: string; decisions: HeldDecision[] }[] | undefined {
  const titles = visitTitles(views);
  const groups = views
    .map((view, i) => ({
      group: titles[i]!,
      decisions: decisionsOf(view.rows, view.titles).map((d) => ({
        ...d,
        id: decisionId(i, d.id),
      })),
    }))
    .filter((g) => g.decisions.length > 0);
  const total = groups.reduce((sum, g) => sum + g.decisions.length, 0);
  return total > MAX_DECISIONS_V2 ? undefined : groups;
}

/** One visit's answers, by its rows' own ids, from the run's answers: what v1's `finalCodes` reads. */
export function answersOfVisit(
  answers: ReadonlyMap<string, DecisionAnswer>,
  visit: number,
): Map<string, DecisionAnswer> {
  const prefix = `v${visit + 1}-`;
  return new Map(
    [...answers]
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, answer]) => [id.slice(prefix.length), answer]),
  );
}

/**
 * A held run's blocks, visit by visit: a section titled the visit's heading (the patient's rows,
 * then the codes' table), each change's "why", the visit's asks; then the file's directions and
 * v1's footer once. Every string still goes through the SDK's `boundedBlocks`.
 */
export function visitBlocks(
  views: readonly VisitView[],
  directions: readonly string[],
  tableNames: readonly string[],
): EmittedBlock[] {
  const titles = visitTitles(views);
  const several = views.length > 1;
  const blocks: EmittedBlock[] = views.flatMap((view, i): EmittedBlock[] => {
    const heading = titles[i]!;
    const patient = patientSection(view).blocks;
    const asks = view.asks.map((ask) => ({
      title: ask.title,
      ...(ask.reason === null ? {} : { subtitle: ask.reason }),
    }));
    return [
      { type: 'section', title: heading, blocks: [...patient, codeTable(view)] },
      ...view.rows
        .filter((r) => DECIDED.has(r.verdict))
        .map((r) => whySection(r, view.titles, several ? heading : undefined)),
      ...(asks.length === 0
        ? []
        : [
            {
              type: 'section' as const,
              title: WORDS.asks,
              ...(several ? { subtitle: heading } : {}),
              blocks: [{ type: 'list' as const, items: asks }],
            },
          ]),
    ];
  });
  return [
    ...blocks,
    ...directions.map((direction): EmittedBlock => ({
      type: 'text',
      text: WORDS.directions(cleanQuote(direction)),
      tone: 'warning',
    })),
    ...[...new Set(tableNames)].map((name): EmittedBlock => ({
      type: 'text',
      text: WORDS.footer(name),
      style: 'muted',
    })),
  ];
}
