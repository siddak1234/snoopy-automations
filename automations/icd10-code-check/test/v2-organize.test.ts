import assert from 'node:assert/strict';
import { test } from 'node:test';

import { organize, unitsOf, type FileRead } from '../src/v2/organize.js';
import { countPdfPages, rangesOf, windowsOf } from '../src/v2/pages.js';
import { PDF_ID, PHOTO_ID, page } from './v2-fixtures.js';

/**
 * The batch's code-alone steps (the spec's v2 section, "The batch"): pages counted and windowed,
 * pages grouped into visits by patient, date and continuity, ordered, duplicates dropped, other
 * pages set aside, and one unit per visit.
 */

const file = (id: string, pages: FileRead['pages'], sha256: string | null = id): FileRead => ({
  artifactId: id,
  contentType: id === PHOTO_ID ? 'image/jpeg' : 'application/pdf',
  sha256,
  pages,
});

test('pages: counted from the bytes when not measured, windows of 20, ranges cut at 20', () => {
  const pdf = new TextEncoder().encode(
    '<< /Type /Pages /Kids [] >> << /Type /Page >> <</Type/Page/Parent 1 0 R>> << /Type /Page >>',
  );
  assert.equal(countPdfPages(pdf), 3);
  assert.deepEqual(windowsOf(45), [
    { from: 1, to: 20 },
    { from: 21, to: 40 },
    { from: 41, to: 45 },
  ]);
  assert.deepEqual(windowsOf(0), []);
  const pages = Array.from({ length: 25 }, (_, i) => i + 1);
  assert.deepEqual(rangesOf([...pages, 30, 31]), [
    { from: 1, to: 20 },
    { from: 21, to: 25 },
    { from: 30, to: 31 },
  ]);
});

test('continuity: a page with no patient or date goes on the visit before it; a new name starts one', () => {
  const { visits, setAside } = organize([
    file(PDF_ID, [
      page(1, 'cover'),
      page(2, 'note', 'Jane Doe', '2026-10-12', 1),
      page(3, 'note', null, null, 2),
      page(4, 'lab', 'Jane Doe'),
      page(5, 'note', 'Sam Roe', '2026-10-12'),
      page(6, 'note', 'Sam Roe', null),
      page(7, 'other'),
    ]),
  ]);
  assert.equal(setAside, 3);
  assert.deepEqual(
    visits.map((v) => [v.patient, v.visitDate, v.pieces.map((p) => p.page)]),
    [
      ['Jane Doe', '2026-10-12', [2, 3]],
      ['Sam Roe', '2026-10-12', [5, 6]],
    ],
  );
});

test("one patient and date across files is one visit, in its pages' order; a file sent twice is dropped", () => {
  const { visits, setAside } = organize([
    file(PDF_ID, [page(1, 'note', 'Jane Doe', '2026-10-12', 2)]),
    file(PHOTO_ID, [page(1, 'note', 'jane  doe', '2026-10-12', 1)]),
    file(
      '44444444-4444-4444-8444-444444444443',
      [page(1, 'note', 'Jane Doe', '2026-10-12')],
      PDF_ID,
    ),
  ]);
  assert.equal(visits.length, 1);
  assert.deepEqual(
    visits[0]!.pieces.map((p) => [p.artifactId, p.position]),
    [
      [PHOTO_ID, 1],
      [PDF_ID, 2],
    ],
  );
  assert.equal(setAside, 1, 'the duplicate file');
});

test('W2: one visit photographed as several photos is one visit, its dateless photos on it', () => {
  const photo = (id: string, pages: FileRead['pages']): FileRead => ({
    artifactId: id,
    contentType: 'image/jpeg',
    sha256: id,
    pages,
  });
  const { visits } = organize([
    photo('p1', [page(1, 'note', 'Jane Doe', '2026-10-12', 1)]),
    photo('p2', [page(1, 'note', null, null, 2)]),
    photo('p3', [page(1, 'note', 'Jane Doe', null, 3)]),
    photo('p4', [page(1, 'note', 'Sam Roe', '2026-10-13', 1)]),
  ]);
  assert.deepEqual(
    visits.map((v) => [v.patient, v.visitDate, v.pieces.map((p) => p.artifactId)]),
    [
      ['Jane Doe', '2026-10-12', ['p1', 'p2', 'p3']],
      ['Sam Roe', '2026-10-13', ['p4']],
    ],
  );
});

test("a dateless visit with a known name joins that name's one dated visit, in another file", () => {
  const { visits } = organize([
    file(PDF_ID, [page(1, 'note', 'Jane Doe', null, 2)]),
    file(PHOTO_ID, [page(1, 'note', 'Jane Doe', '2026-10-12', 1)]),
  ]);
  assert.deepEqual(
    visits.map((v) => [v.visitDate, v.pieces.map((p) => p.position)]),
    [['2026-10-12', [1, 2]]],
  );
});

test("a dateless visit whose page positions are the dated visit's own stays its own visit", () => {
  const { visits, setAside } = organize([
    file(PDF_ID, [
      page(1, 'note', 'Jane Doe', '2026-10-12', 1),
      page(2, 'note', 'Jane Doe', '2026-10-12', 2),
    ]),
    file('44444444-4444-4444-8444-444444444443', [
      page(1, 'note', 'Jane Doe', null, 1),
      page(2, 'note', null, null, 2),
    ]),
  ]);
  assert.deepEqual(
    visits.map((v) => [v.visitDate, v.pieces.map((p) => p.position)]),
    [
      ['2026-10-12', [1, 2]],
      [null, [1, 2]],
    ],
  );
  assert.equal(setAside, 0, 'no page of either visit is dropped');
});

test('a page of a visit read twice is dropped: the later copy, set aside', () => {
  const { visits, setAside } = organize([
    file(PDF_ID, [
      page(1, 'note', 'Jane Doe', '2026-10-12', 1),
      page(2, 'note', 'Jane Doe', '2026-10-12', 2),
      page(3, 'note', 'Jane Doe', '2026-10-12', 2),
    ]),
  ]);
  assert.deepEqual(
    visits[0]!.pieces.map((p) => p.page),
    [1, 2],
  );
  assert.equal(setAside, 1);
});

test('units: one per visit, labelled "{patient name} · {visit date}", a PDF as page ranges, a photo whole', () => {
  const { visits } = organize([
    file(PDF_ID, [
      ...Array.from({ length: 22 }, (_, i) =>
        page(i + 1, 'note', i === 0 ? 'Jane Doe' : null, i === 0 ? '2026-10-12' : null),
      ),
    ]),
    file(PHOTO_ID, [page(1, 'note', null, null)]),
  ]);
  const units = unitsOf(visits);
  assert.deepEqual(units[0], {
    label: 'Jane Doe · Oct 12, 2026',
    artifacts: [
      { artifactId: PDF_ID, pages: { from: 1, to: 20 } },
      { artifactId: PDF_ID, pages: { from: 21, to: 22 } },
    ],
    data: { patient: 'Jane Doe', visitDate: '2026-10-12', pages: 22 },
  });
  assert.deepEqual(units[1], {
    label: 'Visit note',
    artifacts: [{ artifactId: PHOTO_ID }],
    data: { patient: null, visitDate: null, pages: 1 },
  });
});
