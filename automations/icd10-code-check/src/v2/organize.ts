import type { BatchUnit, UnitArtifact } from '@autom8x/automation-sdk';

import { titleOf } from '../blocks.js';
import { realDate } from '../tables.js';
import { rangesOf } from './pages.js';

/**
 * Organize (the spec's v2 section, "The batch"), code alone: every page the categorize step sorted,
 * grouped into visits by patient, date and continuity, ordered, duplicates dropped, and every page
 * that is not a visit note set aside; then one unit per visit for the platform to queue.
 */

export const PAGE_KINDS = ['note', 'lab', 'cover', 'other'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** One page as `categorize-pages` read it. `page` is the file's own page number, from 1. */
export interface PageRead {
  page: number;
  kind: PageKind;
  patient: string | null;
  visitDate: string | null;
  /** The page's place in its visit (1 for a visit's first page), when the page shows it. */
  pageOfVisit: number | null;
}

/** One file of the upload, its every page read, in order. */
export interface FileRead {
  artifactId: string;
  contentType: string;
  /** The store's digest: a second file with the same one is the same file, dropped. */
  sha256: string | null;
  pages: PageRead[];
}

/** One page of a visit. */
export interface Piece {
  artifactId: string;
  pdf: boolean;
  page: number;
  pageOfVisit: number | null;
}

/** One visit: its patient and date as its pages print them, and its pages in order. */
export interface OrganizedVisit {
  patient: string | null;
  visitDate: string | null;
  pieces: Piece[];
}

export interface Organized {
  visits: OrganizedVisit[];
  /** Pages that are not a visit note's, and duplicates dropped. */
  setAside: number;
}

const nameKey = (name: string | null): string | null =>
  name === null ? null : name.replace(/\s+/gu, ' ').trim().toLowerCase() || null;

/**
 * Whether a note page goes on the visit open before it: in the same file, or in the photo before
 * it when the page is a photo too (one visit photographed as several photos).
 */
function continues(open: OrganizedVisit, page: PageRead): boolean {
  if (page.pageOfVisit === 1) return false;
  const name = nameKey(page.patient);
  const openName = nameKey(open.patient);
  const date = realDate(page.visitDate) ?? null;
  return (
    (name === null || openName === null || name === openName) &&
    (date === null || open.visitDate === null || date === open.visitDate)
  );
}

/**
 * Pages to visits: continuity in each file and across consecutive photos, then one visit per
 * patient and date across files, then a dateless visit with a name joined to that name's one dated
 * visit.
 */
export function organize(files: readonly FileRead[]): Organized {
  let setAside = 0;
  const seen = new Set<string>();
  const found: OrganizedVisit[] = [];
  let open: OrganizedVisit | undefined;
  let lastPhoto = false;
  for (const file of files) {
    if (file.sha256 !== null && seen.has(file.sha256)) {
      setAside += file.pages.length;
      continue;
    }
    if (file.sha256 !== null) seen.add(file.sha256);
    const photo = file.contentType !== 'application/pdf';
    if (!(photo && lastPhoto)) open = undefined;
    lastPhoto = photo;
    for (const page of file.pages) {
      if (page.kind !== 'note') {
        setAside += 1;
        continue;
      }
      const date = realDate(page.visitDate) ?? null;
      if (open === undefined || !continues(open, page)) {
        open = { patient: page.patient, visitDate: date, pieces: [] };
        found.push(open);
      }
      open.patient ??= page.patient;
      open.visitDate ??= date;
      open.pieces.push({
        artifactId: file.artifactId,
        pdf: file.contentType === 'application/pdf',
        page: page.page,
        pageOfVisit: page.pageOfVisit,
      });
    }
  }
  const visits: OrganizedVisit[] = [];
  const byKey = new Map<string, OrganizedVisit>();
  for (const visit of found) {
    const name = nameKey(visit.patient);
    const key = name === null || visit.visitDate === null ? null : `${name}|${visit.visitDate}`;
    const same = key === null ? undefined : byKey.get(key);
    if (same === undefined) {
      visits.push(visit);
      if (key !== null) byKey.set(key, visit);
    } else {
      same.pieces.push(...visit.pieces);
    }
  }
  for (const visit of [...visits]) {
    const name = nameKey(visit.patient);
    if (name === null || visit.visitDate !== null) continue;
    const dated = visits.filter((v) => v.visitDate !== null && nameKey(v.patient) === name);
    if (dated.length !== 1) continue;
    dated[0]!.pieces.push(...visit.pieces);
    visits.splice(visits.indexOf(visit), 1);
  }
  for (const visit of visits) {
    const places = new Set<number>();
    const kept = visit.pieces.filter((piece) => {
      if (piece.pageOfVisit === null) return true;
      if (places.has(piece.pageOfVisit)) return false;
      places.add(piece.pageOfVisit);
      return true;
    });
    setAside += visit.pieces.length - kept.length;
    visit.pieces = kept.every((piece) => piece.pageOfVisit !== null)
      ? [...kept].sort((a, b) => a.pageOfVisit! - b.pageOfVisit!)
      : kept;
  }
  return { visits, setAside };
}

/** A visit's label: v1's title, "{patient name} · {visit date}". */
export const visitLabel = (visit: OrganizedVisit): string =>
  titleOf({
    patient: {
      name: visit.patient,
      birthDate: null,
      sex: null,
      recordNumber: null,
      provider: null,
    },
    visitDate: visit.visitDate,
  });

/** A visit's files: each run of one file's pages a range (a PDF) or the file itself (a photo). */
export function unitArtifacts(visit: OrganizedVisit): UnitArtifact[] {
  const out: UnitArtifact[] = [];
  let at = 0;
  while (at < visit.pieces.length) {
    const first = visit.pieces[at]!;
    let end = at;
    while (visit.pieces[end + 1]?.artifactId === first.artifactId) end += 1;
    const run = visit.pieces.slice(at, end + 1);
    if (first.pdf) {
      for (const pages of rangesOf(run.map((piece) => piece.page))) {
        out.push({ artifactId: first.artifactId, pages });
      }
    } else {
      out.push({ artifactId: first.artifactId });
    }
    at = end + 1;
  }
  return out;
}

/** One unit per visit, in order: its label, its files and pages, and its patient data. */
export const unitsOf = (visits: readonly OrganizedVisit[]): BatchUnit[] =>
  visits.map((visit) => ({
    label: visitLabel(visit),
    artifacts: unitArtifacts(visit),
    data: { patient: visit.patient, visitDate: visit.visitDate, pages: visit.pieces.length },
  }));
