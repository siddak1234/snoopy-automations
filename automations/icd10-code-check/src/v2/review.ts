import {
  BLOCK_LIMITS,
  DECISION_LIMITS,
  boundedBlocks,
  type DecisionAnswer,
  type EmittedBlock,
  type EmittedLeaf,
  type HeldDecision,
} from '@autom8x/automation-sdk';

import { patientSection, titleOf, type View } from '../blocks.js';
import type { Row } from '../checks.js';
import { DECIDED, cleanQuote, suggestionOf, withTitle } from '../decisions.js';
import { VERDICTS, WORDS } from '../words.js';
import { WORDS_V2 } from './words.js';

/**
 * v2's review (the spec, "v2 (draft, 2026-11-01)", rows 6 to 8): per visit, one section — the
 * patient and one compact codes table — and each change offered as a decision whose label is
 * "{code} → {suggested}", whose detail is its "why" in the owner's screens' words, and whose group
 * is the visit's title. One run's limits are row 6's; a file past them stops (`fileReview`).
 *
 * Seam: a decision's `group` and the 400 decisions of a held run are the platform's v2 contract;
 * `decide` still offers v1's flat list until it is pinned.
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

/** The first words of `words` whose line, built by `build`, fits `room`: "…" marks a cut; none fits, undefined. */
function wordsWithin(
  words: readonly string[],
  room: number,
  build: (kept: string) => string,
): string | undefined {
  for (let n = words.length; n > 0; n -= 1) {
    const kept = words.slice(0, n).join(' ') + (n < words.length ? ' …' : '');
    const built = build(kept);
    if (built.length <= room) return built;
  }
  return undefined;
}

/**
 * A change's "why", the decision's detail (1 to 200 characters, the platform's bound): 'Difference:
 * "{words only in the first}" vs "{words only in the second}"' (a Change whose titles differ), then
 * 'From the note: "{quote}"', then 'Rule: {the check's reason}', joined by " · ". Past 200 the rule
 * is dropped first, then the quote shortened by whole words, then the difference; never cut mid-word.
 */
export function whyDetail(r: Row, titles: Readonly<Record<string, string>>): string | undefined {
  const W = WORDS_V2.why;
  const room = DECISION_LIMITS.detail;
  const join = (parts: (string | undefined)[]) =>
    parts.filter((p): p is string => p !== undefined && p !== '').join(W.join);
  let first: string[] = [];
  let second: string[] = [];
  if (r.verdict === 'change' && r.suggested !== null) {
    const d = titleDifference(titles[r.code] ?? '', titles[r.suggested] ?? '');
    first = d.onlyNote;
    second = d.onlySuggested;
  }
  const difference =
    first.length + second.length === 0
      ? undefined
      : W.difference(first.join(' '), second.join(' '));
  const quote = r.quote === null ? '' : cleanQuote(r.quote);
  const fromNote = quote === '' ? undefined : W.fromNote(quote);
  const rule = r.reason === null ? undefined : W.rule(r.reason);
  const full = join([difference, fromNote, rule]);
  if (full.length <= room) return full === '' ? undefined : full;
  const noRule = join([difference, fromNote]);
  if (noRule.length <= room) return noRule;
  const before = difference === undefined ? 0 : difference.length + W.join.length;
  const shortQuote =
    fromNote === undefined ? undefined : wordsWithin(quote.split(' '), room - before, W.fromNote);
  if (shortQuote !== undefined) return join([difference, shortQuote]);
  if (difference === undefined) return undefined;
  if (difference.length <= room) return difference;
  // The difference alone passes 200: each side by whole words, half the room each.
  const half = Math.floor((room - W.difference('', '').length) / 2);
  const side = (words: string[]) => wordsWithin(words, half, (kept) => kept) ?? '…';
  return W.difference(side(first), side(second));
}

/** A change's label: v1's "{code} → {suggested}" with the codes alone ("Add {code}" for an Add). */
export const decisionLabel = (r: Row): string =>
  r.verdict === 'add' ? WORDS.label.add(r.code) : WORDS.label.change(r.code, suggestionOf(r));

/** One visit of a file, as v2's review reads it. */
export type VisitView = View;

/** Each visit's title (v1's, "{patient name} · {visit date}"), made unique when two read the same: "… (2)". */
export function visitTitles(views: readonly VisitView[]): string[] {
  const seen = new Map<string, number>();
  return views.map((view) => {
    const title = titleOf(view);
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    return n === 1 ? title : `${title} (${n})`;
  });
}

/** The most decisions one held run may offer: the spec's v2 section, row 6. */
export const MAX_DECISIONS_V2 = 400;

/** A visit's decision id: `v{visit}-{row id}` ("v2-n1"), a step id's shape, unique in the run. */
export const decisionId = (visit: number, rowId: string): string => `v${visit + 1}-${rowId}`;

/** One offered change with its visit's title, the platform v2's `group`. */
export type GroupedDecision = HeldDecision & { group: string };

/** Every change of the file, visit by visit: its id, label, why and group. */
export function fileDecisions(views: readonly VisitView[]): GroupedDecision[] {
  const titles = visitTitles(views);
  return views.flatMap((view, i) =>
    view.rows
      .filter((r) => DECIDED.has(r.verdict))
      .map((r): GroupedDecision => {
        const detail = whyDetail(r, view.titles);
        return {
          id: decisionId(i, r.id),
          label: decisionLabel(r),
          ...(detail === undefined ? {} : { detail }),
          group: titles[i]!,
        };
      }),
  );
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
 * One visit's compact codes table — the note's codes, then each to add: the code with its full
 * official title, the verdict, the suggestion with its title — and, when a code with its title
 * passes a cell's 200 characters, that cell the code alone and the full title in a list item's text
 * (600) after the table: never cut.
 */
export function codesBlocks(view: VisitView): EmittedLeaf[] {
  const long = new Map<string, string>();
  const cell = (code: string): string => {
    const full = withTitle(code, view.titles);
    if (full.length <= BLOCK_LIMITS.lineLength) return full;
    long.set(code, view.titles[code]!);
    return code;
  };
  const rows = view.rows.map((r) => ({
    cells: [
      cell(r.code),
      VERDICTS[r.verdict],
      r.verdict === 'change' || r.verdict === 'add' ? cell(suggestionOf(r)) : suggestionOf(r),
    ],
  }));
  return [
    { type: 'table', columns: WORDS.codeColumns.map((title) => ({ title })), rows },
    ...(long.size === 0
      ? []
      : [
          {
            type: 'list' as const,
            items: [...long].map(([code, title]) => ({ title: code, text: title })),
          },
        ]),
  ];
}

/**
 * A held run's blocks, visit by visit: a section titled the visit's title (the patient's rows, then
 * the codes), the visit's asks; then the file's directions and v1's footer once.
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
    const asks = view.asks.map((ask) => ({
      title: ask.title,
      ...(ask.reason === null ? {} : { subtitle: ask.reason }),
    }));
    return [
      {
        type: 'section',
        title: heading,
        blocks: [...patientSection(view).blocks, ...codesBlocks(view)],
      },
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

type Inner = { type: string; blocks?: readonly Inner[]; rows?: unknown[]; items?: unknown[] };

/** A block and the blocks a section holds, counted as the platform counts them. */
const counted = (b: Inner): number => 1 + (b.blocks ?? []).length;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Whether the platform keeps every block whole, within row 6's block bounds (the SDK's
 * `BLOCK_LIMITS`): each block's own, then the result's — measured on each block as `boundedBlocks`
 * sends it alone, so a long line it cuts is never counted as a lost block.
 */
export function fitsBlocks(blocks: readonly EmittedBlock[]): boolean {
  const L = BLOCK_LIMITS;
  const own = (b: Inner): boolean =>
    (b.blocks ?? []).length <= L.sectionBlocks &&
    (b.type !== 'table' || (b.rows ?? []).length <= L.tableRows) &&
    (b.type !== 'list' || (b.items ?? []).length <= L.listItems) &&
    (b.blocks ?? []).every(own);
  if (!(blocks as readonly Inner[]).every(own)) return false;
  if (blocks.some((b) => bytes([b]) > L.bytes)) return false;
  const alone = blocks.flatMap((b) => boundedBlocks([b]) ?? []);
  return (
    alone.length <= L.topLevel &&
    (alone as readonly Inner[]).reduce((sum, b) => sum + counted(b), 0) <= L.total &&
    bytes(alone) <= L.bytes
  );
}

/**
 * A file's review in one run: its blocks and decisions, or the stop when its visits pass one run's
 * limits (row 6: 400 decisions, the block bounds). Separate files are separate runs.
 */
export function fileReview(
  views: readonly VisitView[],
  directions: readonly string[],
  tableNames: readonly string[],
): { blocks: EmittedBlock[]; decisions: GroupedDecision[] } | { stop: string } {
  const decisions = fileDecisions(views);
  const blocks = visitBlocks(views, directions, tableNames);
  if (decisions.length > MAX_DECISIONS_V2 || !fitsBlocks(blocks)) {
    return { stop: WORDS_V2.tooManyVisits };
  }
  return { blocks, decisions };
}
