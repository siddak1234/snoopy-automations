import type { BatchUnit, UnitArtifact } from '@autom8x/automation-sdk';

import { titleOf } from '../blocks.js';
import { realDate } from '../tables.js';
import { rangesOf } from './pages.js';

/**
 * Organize (the spec's v2 section, "The batch"), code alone: every page part the categorize step
 * sorted, grouped into visits by patient, date, continuity and separators, ordered, duplicates
 * dropped, and every page with no visit note set aside; then one unit per visit for the platform.
 */

export const PAGE_KINDS = ['note', 'lab', 'cover', 'separator', 'other'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** One part of a page about one visit or one thing, as `categorize-pages` read it; usually one a page. */
export interface Segment {
  kind: PageKind;
  patient: string | null;
  visitDate: string | null;
  /** The page's place in its visit (1 for a visit's first page), when the page shows it. */
  position: number | null;
}

/** One page as `categorize-pages` read it. `page` is the file's own page number, from 1. */
export interface PageRead {
  page: number;
  segments: Segment[];
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
  position: number | null;
}

/**
 * One visit: its patient and date as its pages print them, and its pages in order; `shared` when
 * one of its pages holds another patient's note too, so its run reads only its patient's.
 */
export interface OrganizedVisit {
  patient: string | null;
  visitDate: string | null;
  pieces: Piece[];
  shared: boolean;
}

export interface Organized {
  visits: OrganizedVisit[];
  /** Pages with no visit note's part, and duplicates dropped. */
  setAside: number;
}

const nameKey = (name: string | null): string | null =>
  name === null ? null : name.replace(/\s+/gu, ' ').trim().toLowerCase() || null;

/**
 * Whether a note's part goes on the visit open before it: in the same file, or in the photo before
 * it when the page is a photo too (one visit photographed as several photos).
 */
function continues(open: OrganizedVisit, part: Segment): boolean {
  if (part.position === 1) return false;
  const name = nameKey(part.patient);
  const openName = nameKey(open.patient);
  const date = realDate(part.visitDate) ?? null;
  return (
    (name === null || openName === null || name === openName) &&
    (date === null || open.visitDate === null || date === open.visitDate)
  );
}

const positions = (visit: OrganizedVisit): number[] =>
  visit.pieces.flatMap((piece) => (piece.position === null ? [] : [piece.position]));

/**
 * Pages to visits: continuity in each file and across consecutive photos, a separator closing the
 * visit open; a page with two patients' notes on both visits; then one visit per patient and date
 * across files; then a dateless visit with a name joined to that name's one dated visit when none
 * of its page positions is the dated visit's (else it stays its own visit).
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
    const pdf = file.contentType === 'application/pdf';
    if (!(!pdf && lastPhoto)) open = undefined;
    lastPhoto = !pdf;
    for (const { page, segments } of file.pages) {
      const notes = segments.filter((part) => part.kind === 'note');
      if (notes.length === 0) setAside += 1;
      const shared = new Set(notes.map((part) => nameKey(part.patient))).size > 1;
      for (const part of segments) {
        if (part.kind === 'separator') open = undefined;
        if (part.kind !== 'note') continue;
        const date = realDate(part.visitDate) ?? null;
        if (open === undefined || !continues(open, part)) {
          open = { patient: part.patient, visitDate: date, pieces: [], shared: false };
          found.push(open);
        }
        open.patient ??= part.patient;
        open.visitDate ??= date;
        open.shared ||= shared;
        const last = open.pieces.at(-1);
        if (last?.artifactId === file.artifactId && last.page === page) continue;
        open.pieces.push({ artifactId: file.artifactId, pdf, page, position: part.position });
      }
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
      same.shared ||= visit.shared;
    }
  }
  for (const visit of [...visits]) {
    const name = nameKey(visit.patient);
    if (name === null || visit.visitDate !== null) continue;
    const dated = visits.filter((v) => v.visitDate !== null && nameKey(v.patient) === name);
    if (dated.length !== 1) continue;
    const taken = new Set(positions(dated[0]!));
    if (positions(visit).some((place) => taken.has(place))) continue;
    dated[0]!.pieces.push(...visit.pieces);
    dated[0]!.shared ||= visit.shared;
    visits.splice(visits.indexOf(visit), 1);
  }
  for (const visit of visits) {
    const places = new Set<number>();
    const kept = visit.pieces.filter((piece) => {
      if (piece.position === null) return true;
      if (places.has(piece.position)) return false;
      places.add(piece.position);
      return true;
    });
    setAside += visit.pieces.length - kept.length;
    visit.pieces = kept.every((piece) => piece.position !== null)
      ? [...kept].sort((a, b) => a.position! - b.position!)
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

/**
 * One unit per visit, in order: its label, its files and pages, and its patient data — with
 * `readOnly`, its patient, when a page of it holds another patient's note too.
 */
export const unitsOf = (visits: readonly OrganizedVisit[]): BatchUnit[] =>
  visits.map((visit) => ({
    label: visitLabel(visit),
    artifacts: unitArtifacts(visit),
    data: {
      patient: visit.patient,
      visitDate: visit.visitDate,
      pages: visit.pieces.length,
      ...(visit.shared && visit.patient !== null ? { readOnly: visit.patient } : {}),
    },
  }));
