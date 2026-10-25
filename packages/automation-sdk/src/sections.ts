import { truncateText } from './contract.js';

/**
 * A succeeded run's `title`, `score`, `verdict` and `sections` (platform ADR-0046, Round 19; the
 * run result's success branch in `automation-run-result.json`): what names a run on its item's
 * list — Resume Screening's candidate's name — the number its item's runs are ranked by, the
 * verdict its item counts (build 28; the manifest's `items.verdictWords` name it), and the rows a
 * person opens on the run page. On an item run, the `sections` are the item's reading as people
 * see it. The platform keeps all four with the run and never parses them.
 */

/** One row of a section: a title, and optionally a subtitle, a text and an http(s) link. */
export interface RunSectionEntry {
  readonly title: string;
  readonly subtitle?: string;
  readonly text?: string;
  readonly url?: string;
}

/** One collapsible section: its title and its rows. */
export interface RunSection {
  readonly title: string;
  readonly entries: readonly RunSectionEntry[];
}

/** The platform's bounds on `title` and `score` (`automation-run-result.json`; its `RUN_RESULT_LIMITS`). */
export const RUN_RESULT_LIMITS = { titleLength: 80, scoreMinimum: 0, scoreMaximum: 100 } as const;

/** A run's verdict: the schema's `enum`, the platform's `RUN_VERDICTS`. */
export type RunVerdict = 'positive' | 'negative';

/** The two verdicts, as the platform lists them (its `RUN_VERDICTS`). */
export const RUN_VERDICTS: readonly RunVerdict[] = ['positive', 'negative'];

/** The platform's bounds on `sections` (its `RUN_SECTION_LIMITS`): the schema's, and its route's. */
export const RUN_SECTION_LIMITS = {
  sections: 12,
  titleLength: 40,
  entries: 40,
  entryTitleLength: 120,
  subtitleLength: 120,
  textLength: 600,
  urlLength: 2048,
} as const;

/** How an entry's url starts, in either case: the schema's `pattern`, exactly. */
const URL_START = /^[Hh][Tt][Tt][Pp]([Ss])?:\/\//u;

/**
 * Whether the platform keeps this url (its `isRunSectionUrl`): at most 2,048 characters,
 * starting `http://` or `https://` in either case — so `http:` or `https:` to a URL parser —
 * and a url a URL parser reads, which a schema cannot say (`https://` alone is none).
 */
export function isRunSectionUrl(value: string): boolean {
  return (
    value.length <= RUN_SECTION_LIMITS.urlLength && URL_START.test(value) && URL.canParse(value)
  );
}

/** One line: every run of white space, line breaks included, one space; trimmed. */
const oneLineText = (value: string) => value.replace(/\s+/gu, ' ').trim();

/** Text cut at its bound, whole characters only, and trimmed again after the cut. */
const cut = (value: string, maximum: number) => truncateText(value, maximum).trimEnd();

/**
 * The title as the wire accepts it: one line, cut at 80 characters, whole characters only;
 * `undefined` when nothing is left — a run whose work is done must not become unreportable
 * because a name ran long, as `boundedDetails` holds its lines.
 */
export function boundedTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const line = cut(oneLineText(title), RUN_RESULT_LIMITS.titleLength);
  return line === '' ? undefined : line;
}

/**
 * The score as the wire accepts it: an integer from 0 to 100, else left out — never rounded
 * or moved into range, which would send a number the automation did not decide.
 */
export function boundedScore(score: number | undefined): number | undefined {
  return Number.isInteger(score) &&
    (score as number) >= RUN_RESULT_LIMITS.scoreMinimum &&
    (score as number) <= RUN_RESULT_LIMITS.scoreMaximum
    ? score
    : undefined;
}

/**
 * The verdict as the wire accepts it: `positive` or `negative`, else left out — never guessed
 * from another value. The platform also refuses one on an item run and on a version declaring no
 * `items.verdictWords`; an automation gives none there.
 */
export function boundedVerdict(verdict: string | undefined): RunVerdict | undefined {
  return (RUN_VERDICTS as readonly (string | undefined)[]).includes(verdict)
    ? (verdict as RunVerdict)
    : undefined;
}

/** One entry as the wire accepts it, or `undefined` when its title is empty. */
function boundedEntry(entry: RunSectionEntry): RunSectionEntry | undefined {
  const L = RUN_SECTION_LIMITS;
  const title = cut(oneLineText(entry.title), L.entryTitleLength);
  if (title === '') return undefined;
  const subtitle =
    entry.subtitle === undefined ? '' : cut(oneLineText(entry.subtitle), L.subtitleLength);
  // A text may hold its line breaks: the platform holds it to its length alone.
  const text = entry.text === undefined ? '' : cut(entry.text.trim(), L.textLength);
  const url = entry.url?.trim() ?? '';
  return {
    title,
    ...(subtitle === '' ? {} : { subtitle }),
    ...(text === '' ? {} : { text }),
    ...(url !== '' && isRunSectionUrl(url) ? { url } : {}),
  };
}

/**
 * The sections as the wire accepts them: each title one line and cut at its bound, whole
 * characters only; an entry whose title is then empty left out, an empty subtitle or text
 * left off, and a url the platform would not keep — not `http:` or `https:`, or longer than
 * 2,048 characters — left off the entry, which stays; at most 40 entries a section, the first
 * kept; a section left with no entry, or with an empty title, left out; at most 12 sections,
 * the first kept. `undefined` when none is left, so a result never carries an empty list.
 */
export function boundedSections(
  sections: readonly RunSection[] | undefined,
): RunSection[] | undefined {
  const L = RUN_SECTION_LIMITS;
  const kept: RunSection[] = [];
  for (const section of sections ?? []) {
    const title = cut(oneLineText(section.title), L.titleLength);
    const entries: RunSectionEntry[] = [];
    for (const entry of section.entries) {
      const bounded = boundedEntry(entry);
      if (bounded !== undefined) entries.push(bounded);
      if (entries.length === L.entries) break;
    }
    if (title !== '' && entries.length > 0) kept.push({ title, entries });
    if (kept.length === L.sections) break;
  }
  return kept.length === 0 ? undefined : kept;
}
