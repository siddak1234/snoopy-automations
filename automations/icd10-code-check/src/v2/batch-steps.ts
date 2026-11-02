import {
  DEFAULT_CALLBACK_TIMEOUT_MS,
  DEFAULT_MODEL_TIMEOUT_MS,
  artifactIdsOf,
  boundedUnits,
  failed,
  isObject,
  settle,
  type BatchUnit,
  type PageRange,
  type Step,
} from '@autom8x/automation-sdk';

import { prompt } from '../prompts.js';
import { FAILURES } from '../words.js';
import { askModel, atOnce, type AuditRecord } from './audit.js';
import {
  PAGE_KINDS,
  organize as organizePages,
  unitsOf,
  type FileRead,
  type OrganizedVisit,
  type PageKind,
  type PageRead,
  type Segment,
} from './organize.js';
import { countPdfPages, windowsOf, type PagesFrom } from './pages.js';
import { WORDS_V2 } from './words.js';

/**
 * The batch run's four steps (the spec's v2 section, "The batch"; the platform's batch intake):
 * chunk, categorize, organize, queue. Its result is one line and the units the platform queues,
 * one child run per visit (`automation.ts`).
 */

/** The run input every file of the upload arrives under. */
export const FILES_KEY = 'visitNotes';

/** One file, as the chunk step found it. */
export interface FileInfo {
  artifactId: string;
  contentType: string;
  sha256: string | null;
  /** Its pages: 1 for a photo; 0 for a PDF whose pages could not be counted (read whole). */
  pages: number;
  pagesFrom: PagesFrom;
}

const filesOf = (value: unknown): FileInfo[] => (Array.isArray(value) ? (value as FileInfo[]) : []);

/**
 * Pages counted: each file of the upload and its pages — the platform's measured page count when
 * the file's reference gives it (`pageCount`, measured because the manifest bounds a PDF's pages),
 * else counted from the file's bytes (`countPdfPages`); a photo is one page. Which, per file, is kept.
 */
export const chunk: Step = async (context) => {
  const { request, platform } = context;
  const ids = artifactIdsOf(request.input, FILES_KEY);
  if (ids.length === 0) return failed(FAILURES.noFile, 'no_file');
  const files: FileInfo[] = [];
  for (const id of ids) {
    const found = await settle(context, () => platform.readArtifact(id));
    if (!found.ok) return failed(found.sentence, found.kind);
    const file = found.value;
    const pdf = file.contentType === 'application/pdf';
    let pages = pdf ? (file.pageCount ?? undefined) : 1;
    let pagesFrom: PagesFrom = 'measured';
    if (pages === undefined) {
      const bytes = await settle(context, () => platform.readArtifactBytes(file));
      if (!bytes.ok) return failed(bytes.sentence, bytes.kind);
      pages = countPdfPages(bytes.value);
      pagesFrom = 'counted';
    }
    files.push({
      artifactId: file.artifactId,
      contentType: file.contentType,
      sha256: file.sha256 ?? null,
      pages,
      pagesFrom,
    });
  }
  return { outcome: 'ok', summary: 'Pages counted', state: { files } };
};

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;

/** A segment from the model's answer: a kind off the list is "other", a place below 1 none. */
const segmentOf = (one: unknown): Segment => {
  const part = isObject(one) ? one : {};
  const place = part.position;
  return {
    kind: PAGE_KINDS.includes(part.kind as PageKind) ? (part.kind as PageKind) : 'other',
    patient: text(part.patient, 200),
    visitDate: text(part.visitDate, 10),
    position: Number.isInteger(place) && (place as number) >= 1 ? (place as number) : null,
  };
};

const OTHER: Segment = { kind: 'other', patient: null, visitDate: null, position: null };

/** The last page an answer numbers, for a PDF read whole; at least 1. */
const lastNumbered = (answer: unknown): number =>
  Math.max(
    1,
    ...(isObject(answer) && Array.isArray(answer.pages) ? answer.pages : []).map((one) =>
      isObject(one) && Number.isInteger(one.page) ? (one.page as number) : 1,
    ),
  );

/**
 * One window's pages from the model's answer: each page of `window` once, as answered, its
 * segments in order; a page the answer leaves out, or answers with no segment, is "other" (set
 * aside, counted). The platform sends a later window as its own PDF from page 1, so an answer that
 * numbers none of the window's pages and every page within 1 to the window's size is read as the
 * window's pages in order (1 is `from`).
 */
export function pagesOfAnswer(answer: unknown, window: PageRange): PageRead[] {
  const listed = isObject(answer) && Array.isArray(answer.pages) ? answer.pages : [];
  const byPage = new Map<number, Segment[]>();
  for (const one of listed) {
    if (!isObject(one) || !Number.isInteger(one.page) || (one.page as number) < 1) continue;
    const segments = Array.isArray(one.segments) ? one.segments.map(segmentOf) : [];
    if (!byPage.has(one.page as number)) byPage.set(one.page as number, segments);
  }
  const answered = [...byPage.keys()];
  const shift =
    window.from > 1 &&
    answered.length > 0 &&
    answered.every((page) => page <= window.to - window.from + 1) &&
    !answered.some((page) => page >= window.from && page <= window.to)
      ? window.from - 1
      : 0;
  const out: PageRead[] = [];
  for (let page = window.from; page <= window.to; page += 1) {
    const segments = byPage.get(page - shift) ?? [];
    out.push({ page, segments: segments.length === 0 ? [OTHER] : segments });
  }
  return out;
}

/** How many windows `categorize` asks the model about at once. */
export const WINDOWS_AT_ONCE = 3;

/**
 * The time a window needs before the run's deadline: one model call's wait and four callbacks'
 * (the SDK's callback wait each), the step reports and the result that follow it.
 */
export const WINDOW_ROOM_MS = DEFAULT_MODEL_TIMEOUT_MS + 4 * DEFAULT_CALLBACK_TIMEOUT_MS;

/** The pages of an upload sent to no AI: each a note's, its patient and date left to `read-note`. */
const unsorted = (pages: number): PageRead[] =>
  Array.from({ length: pages }, (_, i) => ({
    page: i + 1,
    segments: [{ kind: 'note', patient: null, visitDate: null, position: null }],
  }));

/**
 * Whether an upload skips the AI sort (the owner's I3): photos chosen together, which start as one
 * visit, or one PDF of 1 to 5 pages, one visit — `read-note`'s patient count still guards each.
 */
const routed = (files: readonly FileInfo[]): boolean =>
  files.every((file) => file.contentType !== 'application/pdf') ||
  (files.length === 1 && files[0]!.pages >= 1 && files[0]!.pages <= 5);

/**
 * Pages sorted: AI reads each file in windows of at most 20 pages (`categorize-pages`, a page
 * range of the file the platform cuts) — a photo whole — and answers each page's segments: its
 * kind (note, lab, cover, separator, other), patient, visit date and position.
 * `WINDOWS_AT_ONCE` windows are asked at a time; none starts once the run's deadline is nearer
 * than `WINDOW_ROOM_MS`, and the run stops in `WORDS_V2.tooLong`. An upload `routed` skips it.
 */
export const categorize: Step = async (context) => {
  const { state, request } = context;
  const files = filesOf(state.files);
  const read = (pages: (at: number) => PageRead[]): FileRead[] =>
    files.map((file, at) => ({
      artifactId: file.artifactId,
      contentType: file.contentType,
      sha256: file.sha256,
      pages: pages(at),
    }));
  if (routed(files)) {
    return {
      outcome: 'ok',
      summary: 'Pages sorted',
      state: { ...state, reads: read((at) => unsorted(Math.max(1, files[at]!.pages))) },
    };
  }
  // A PDF whose pages were not counted is read whole (`window` null); a photo is its one page.
  const asks: { file: number; window: PageRange | null; pdf: boolean }[] = [];
  files.forEach((file, at) => {
    const pdf = file.contentType === 'application/pdf';
    if (!pdf) asks.push({ file: at, window: { from: 1, to: 1 }, pdf });
    else if (file.pages === 0) asks.push({ file: at, window: null, pdf });
    else for (const window of windowsOf(file.pages)) asks.push({ file: at, window, pdf });
  });
  const answers: PageRead[][] = [];
  const audit: AuditRecord[] = [];
  let stop: { sentence: string; kind: string } | undefined;
  await atOnce(asks.length, WINDOWS_AT_ONCE, async (at) => {
    if (Date.parse(request.deadline) - Date.now() < WINDOW_ROOM_MS) {
      stop ??= { sentence: WORDS_V2.tooLong, kind: 'too_long' };
      return false;
    }
    const { file, window, pdf } = asks[at]!;
    const asked = await askModel(
      context,
      prompt('categorize-pages', 2),
      { from: window?.from ?? 1, to: window?.to ?? 'the last' },
      { artifactId: files[file]!.artifactId, ...(pdf && window ? { pages: window } : {}) },
    );
    if (!asked.ok) {
      stop ??= { sentence: asked.sentence, kind: asked.kind };
      return false;
    }
    const pages = pagesOfAnswer(
      asked.answer,
      window ?? { from: 1, to: lastNumbered(asked.answer) },
    );
    const sorted = pages.filter((one) => one.segments[0] !== OTHER).length;
    answers[at] = pages;
    audit[at] = { ...asked.record, gate: `pages sorted: ${sorted} of ${pages.length}` };
    return true;
  });
  if (stop !== undefined) return failed(stop.sentence, stop.kind);
  const reads = read(() => []);
  asks.forEach((ask, at) => reads[ask.file]!.pages.push(...answers[at]!));
  return {
    outcome: 'ok',
    summary: 'Pages sorted',
    state: { ...state, reads, audit: audit.map((r) => ({ ...r })) },
  };
};

/** Visits found: code alone (`organize.ts`). */
export const organize: Step = ({ state }) => {
  const reads = Array.isArray(state.reads) ? (state.reads as FileRead[]) : [];
  const { visits, setAside } = organizePages(reads);
  const pages = reads.reduce((sum, file) => sum + file.pages.length, 0);
  const { reads: _reads, ...rest } = state;
  return Promise.resolve({
    outcome: 'ok',
    summary: 'Visits found',
    state: { ...rest, visits: visits.map((visit) => ({ ...visit })), setAside, pages },
  });
};

/**
 * Visits queued: one unit per visit — its label "{patient name} · {visit date}", its files and
 * pages, its patient data — which the platform queues, each its own run. An upload past one
 * batch's limits stops in `WORDS_V2.tooBig`, queuing none.
 */
export const queue: Step = ({ state }) => {
  const visits = Array.isArray(state.visits) ? (state.visits as OrganizedVisit[]) : [];
  let units: BatchUnit[];
  try {
    // Each label one line, cut whole at its bound; what cannot be cut passes one batch.
    units = visits.length === 0 ? [] : (boundedUnits(unitsOf(visits)) ?? []);
  } catch {
    return Promise.resolve(failed(WORDS_V2.tooBig, 'too_big'));
  }
  const { visits: _visits, ...rest } = state;
  return Promise.resolve({
    outcome: 'ok',
    summary: 'Visits queued',
    state: { ...rest, visits: visits.length, units },
  });
};
