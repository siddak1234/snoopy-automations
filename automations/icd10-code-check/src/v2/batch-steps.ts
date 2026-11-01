import {
  artifactIdsOf,
  boundedUnits,
  failed,
  isObject,
  readJsonCompletion,
  settle,
  type BatchUnit,
  type PageRange,
  type Step,
} from '@autom8x/automation-sdk';

import { MODELS } from '../models.js';
import { prompt } from '../prompts.js';
import { FAILURES } from '../words.js';
import {
  PAGE_KINDS,
  organize as organizePages,
  unitsOf,
  type FileRead,
  type OrganizedVisit,
  type PageKind,
  type PageRead,
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

/**
 * One window's pages from the model's answer: each page of `window` once, as answered, a page the
 * answer leaves out or does not shape read as "other" (set aside, counted). Without a window (a
 * PDF read whole), every page the answer numbers, once each.
 */
export function pagesOfAnswer(answer: unknown, window: PageRange | undefined): PageRead[] {
  const listed = isObject(answer) && Array.isArray(answer.pages) ? answer.pages : [];
  const byPage = new Map<number, PageRead>();
  for (const one of listed) {
    if (!isObject(one) || !Number.isInteger(one.page) || (one.page as number) < 1) continue;
    const page = one.page as number;
    if (byPage.has(page)) continue;
    const place = one.pageOfVisit;
    byPage.set(page, {
      page,
      kind: PAGE_KINDS.includes(one.kind as PageKind) ? (one.kind as PageKind) : 'other',
      patient: text(one.patient, 200),
      visitDate: text(one.visitDate, 10),
      pageOfVisit: Number.isInteger(place) && (place as number) >= 1 ? (place as number) : null,
    });
  }
  if (window === undefined) return [...byPage.values()].sort((a, b) => a.page - b.page);
  const other = (page: number): PageRead => ({
    page,
    kind: 'other',
    patient: null,
    visitDate: null,
    pageOfVisit: null,
  });
  const out: PageRead[] = [];
  for (let page = window.from; page <= window.to; page += 1) {
    out.push(byPage.get(page) ?? other(page));
  }
  return out;
}

/**
 * Pages sorted: AI reads each file in windows of at most 20 pages (`categorize-pages`, a page
 * range of the file the platform cuts) — a photo whole — and answers, per page, its kind (note,
 * lab, cover, other), its patient, its visit date and its page of the visit.
 */
export const categorize: Step = async (context) => {
  const { state, platform } = context;
  const reads: FileRead[] = [];
  for (const file of filesOf(state.files)) {
    const pdf = file.contentType === 'application/pdf';
    const windows: (PageRange | undefined)[] =
      !pdf || file.pages === 0 ? [undefined] : windowsOf(file.pages);
    const pages: PageRead[] = [];
    for (const window of windows) {
      const span = window ?? { from: 1, to: pdf ? 'the last' : 1 };
      const asked = await settle(context, () =>
        platform.callModel(
          prompt('categorize-pages'),
          { from: span.from, to: span.to },
          {
            models: MODELS,
            artifactId: file.artifactId,
            ...(window === undefined || !pdf ? {} : { pages: window }),
          },
        ),
      );
      if (!asked.ok) return failed(asked.sentence, asked.kind);
      const read = readJsonCompletion(asked.value);
      pages.push(...pagesOfAnswer(read, window ?? (pdf ? undefined : { from: 1, to: 1 })));
    }
    reads.push({
      artifactId: file.artifactId,
      contentType: file.contentType,
      sha256: file.sha256,
      pages,
    });
  }
  return { outcome: 'ok', summary: 'Pages sorted', state: { ...state, reads } };
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
