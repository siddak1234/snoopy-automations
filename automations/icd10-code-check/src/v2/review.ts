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
 * v2's review (the spec, "v2", rows 6 to 8): each batch unit is one visit, whose run reviews it
 * (`review-visit`): one section — the patient and one compact codes table — and each change offered
 * as a decision whose label is "{code} → {suggested}", whose detail is its "why" in the owner's
 * screens' words, and whose group is the visit's title. One run's limits are row 6's; a visit past
 * them stops (`visitReview`).
 */

/** The words of a title, as a person reads them, each once: letters and digits, in order. */
const titleWords = (title: string): string[] => [
  ...new Map((title.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => [w.toLowerCase(), w])).values(),
];

/**
 * The words only one of two titles holds (case aside), each side in its own title's order. A word
 * counts as shared when the other title holds it, or when it ends in a digit and the other title
 * holds it with letters after ("3" in "stage 3 unspecified" is shared with "3a"), so N18.30 →
 * N18.31 reads 'Difference: "unspecified" vs "3a"', as the owner's screen shows it. "with" never
 * extends to "without". Should that rule empty a side that whole words would fill ("stage 3" vs
 * "stage 3a"), the words are compared whole only.
 */
export function titleDifference(
  noteTitle: string,
  suggestedTitle: string,
): { onlyNote: string[]; onlySuggested: string[] } {
  const note = titleWords(noteTitle);
  const suggested = titleWords(suggestedTitle);
  const lower = (words: string[]) => words.map((w) => w.toLowerCase());
  const inNote = lower(note);
  const inSuggested = lower(suggested);
  const split = (extends_: boolean) => {
    const shared = (word: string, other: string[]) => {
      const key = word.toLowerCase();
      return other.some(
        (w) =>
          w === key ||
          (extends_ &&
            /\p{N}$/u.test(key) &&
            w.startsWith(key) &&
            /^\p{L}/u.test(w.slice(key.length))),
      );
    };
    return {
      onlyNote: note.filter((w) => !shared(w, inSuggested)),
      onlySuggested: suggested.filter((w) => !shared(w, inNote)),
    };
  };
  const extended = split(true);
  const whole = split(false);
  const emptied =
    (extended.onlyNote.length === 0 && whole.onlyNote.length > 0) ||
    (extended.onlySuggested.length === 0 && whole.onlySuggested.length > 0);
  return emptied ? whole : extended;
}

/**
 * The rule a decision's why names, per check (the spec's v2 section, row 8): G3 in the owner's
 * screen's words; every other check, until a person words its rule, v1's reason sentence (`REASONS`,
 * `words.md` section 4 and README "Open, for a person").
 */
export const RULES_V2: Readonly<Record<string, string>> = {
  G3: 'most specific code the note shows',
};

/** A row's rule: its first check's in `RULES_V2`, else its reason; none for a Keep. */
const ruleOf = (r: Row): string | null => RULES_V2[r.check.split(',')[0]!.trim()] ?? r.reason;

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
 * A change's "why", the decision's detail (within the platform's detail bound, `DECISION_LIMITS`):
 * 'Difference: "{words only in the first}" vs "{words only in the second}"' (a Change whose titles
 * differ), then 'From the note: "{quote}"', then 'Rule: {the check's rule}' (`ruleOf`), joined by
 * " · ". Past the bound the rule is dropped first, then the quote shortened by whole words, then
 * the difference; never cut mid-word.
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
  const rule = ruleOf(r);
  const ruled = rule === null ? undefined : W.rule(rule);
  const full = join([difference, fromNote, ruled]);
  if (full.length <= room) return full === '' ? undefined : full;
  const noRule = join([difference, fromNote]);
  if (noRule.length <= room) return noRule;
  const before = difference === undefined ? 0 : difference.length + W.join.length;
  const shortQuote =
    fromNote === undefined ? undefined : wordsWithin(quote.split(' '), room - before, W.fromNote);
  if (shortQuote !== undefined) return join([difference, shortQuote]);
  if (difference === undefined) return undefined;
  if (difference.length <= room) return difference;
  // The difference alone passes the bound: each side by whole words, half the room each.
  const half = Math.floor((room - W.difference('', '').length) / 2);
  const side = (words: string[]) => wordsWithin(words, half, (kept) => kept) ?? '…';
  return W.difference(side(first), side(second));
}

/** A change's label: v1's "{code} → {suggested}" with the codes alone ("Add {code}" for an Add). */
export const decisionLabel = (r: Row): string =>
  r.verdict === 'add' ? WORDS.label.add(r.code) : WORDS.label.change(r.code, suggestionOf(r));

/** A decision's id: `v1-{row id}` ("v1-n1"), a step id's shape. */
const decisionId = (rowId: string): string => `v1-${rowId}`;

/** One offered change with its visit's title, the platform v2's `group`. */
export type GroupedDecision = HeldDecision & { group: string };

/** Every change of the visit: its id, label, why and group (the visit's title). */
export function visitDecisions(view: View): GroupedDecision[] {
  const group = titleOf(view);
  return view.rows
    .filter((r) => DECIDED.has(r.verdict))
    .map((r): GroupedDecision => {
      const detail = whyDetail(r, view.titles);
      return {
        id: decisionId(r.id),
        label: decisionLabel(r),
        ...(detail === undefined ? {} : { detail }),
        group,
      };
    });
}

/** The run's answers by the visit's rows' own ids: what v1's `finalCodes` reads. */
export const rowAnswers = (
  answers: ReadonlyMap<string, DecisionAnswer>,
): Map<string, DecisionAnswer> =>
  new Map(
    [...answers]
      .filter(([id]) => id.startsWith(decisionId('')))
      .map(([id, answer]) => [id.slice(decisionId('').length), answer]),
  );

/**
 * One visit's compact codes table — the note's codes, then each to add: the code with its full
 * official title, the verdict, the suggestion with its title — and, when a code with its title
 * passes a cell's bound, that cell the code alone and the full title in a list item's text, whose
 * bound is wider, after the table: never cut (`BLOCK_LIMITS`).
 */
export function codesBlocks(view: View): EmittedLeaf[] {
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
 * A held run's blocks: a section titled the visit's title (the patient's rows, then the codes),
 * the visit's asks, its directions and v1's footer.
 */
export function visitBlocks(view: View): EmittedBlock[] {
  const asks = view.asks.map((ask) => ({
    title: ask.title,
    ...(ask.reason === null ? {} : { subtitle: ask.reason }),
  }));
  return [
    {
      type: 'section',
      title: titleOf(view),
      blocks: [...patientSection(view).blocks, ...codesBlocks(view)],
    },
    ...(asks.length === 0
      ? []
      : [
          {
            type: 'section' as const,
            title: WORDS.asks,
            blocks: [{ type: 'list' as const, items: asks }],
          },
        ]),
    ...view.directions.map((direction): EmittedBlock => ({
      type: 'text',
      text: WORDS.directions(cleanQuote(direction)),
      tone: 'warning',
    })),
    { type: 'text', text: WORDS.footer(view.tableName), style: 'muted' },
  ];
}

type Inner = { type: string; blocks?: readonly Inner[]; rows?: unknown[]; items?: unknown[] };

/** A block and the blocks a section holds, counted as the platform counts them. */
const counted = (b: Inner): number => 1 + (b.blocks ?? []).length;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Whether the platform keeps every block whole, within row 6's limits (the SDK's `BLOCK_LIMITS`): each block's own, then the result's — measured on each block as `boundedBlocks`
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
 * A visit's review: its blocks and decisions, or the stop when its blocks pass row 6's limits (the
 * platform's `BLOCK_LIMITS`, the SDK's copy; its decisions, each a row of the visit's one table of
 * at most 200, stay within `DECISION_LIMITS`). The run's deadline is not checked here: a run past
 * it is failed by the platform, as v1's is (row 6's seam).
 */
export function visitReview(
  view: View,
): { blocks: EmittedBlock[]; decisions: GroupedDecision[] } | { stop: string } {
  const decisions = visitDecisions(view);
  const blocks = visitBlocks(view);
  return fitsBlocks(blocks) ? { blocks, decisions } : { stop: WORDS_V2.tooManyCodes };
}
