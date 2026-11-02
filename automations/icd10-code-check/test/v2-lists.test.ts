import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GUIDES,
  GUIDE_MAPPING,
  NEPHROLOGY,
  checkMapping,
  commonCodesIn,
  keptCodes,
  nuccRows,
  parseCsv,
  preferencesFrom,
  specialtiesFrom,
} from '../scripts/v2-lists.js';

/**
 * v2's lists as `automations/icd10-code-check/scripts/build-v2-assets.ts` reads them from the official files, on made-up
 * files: the NUCC CSV's rows and counts, a guide's Common Codes section, the table's validity and
 * the NUCC mapping.
 */

const HEADER = 'Code,Grouping,Classification,Specialization,Definition,Notes,Display Name,Section';
const csv = (rows: string[]) => `﻿${[HEADER, ...rows].join('\r\n')}\r\n`;
const NUCC_FILE = csv([
  '193200000X,Group,Multi-Specialty,,"A group, of several",,Multi-Specialty Group,Individual',
  '207RN0300X,Allopathic & Osteopathic Physicians,Internal Medicine,Nephrology,"Says ""kidney""\nover two lines",,Nephrology Physician,Individual',
  '390200000X,"Student, Health Care",Student in an Organized Health Care Education/Training Program,,,,Student,Individual',
  '2080P0210X,Allopathic & Osteopathic Physicians,Pediatrics,Pediatric Nephrology,,,Pediatric Nephrology Physician,Individual',
  '261QD0000X,Ambulatory Health Care Facilities,Clinic/Center,Dental,,,Dental Clinic/Center,Non-Individual',
  '111N00000X,Chiropractic Providers,Chiropractor,,,,Chiropractor,Individual',
]);

test('parseCsv: quoted commas, doubled quotes, a line break inside quotes, CRLF and a BOM', () => {
  assert.deepEqual(parseCsv('﻿a,"b, c","say ""hi""","x\ny"\r\n1,,3,4'), [
    ['a', 'b, c', 'say "hi"', 'x\ny'],
    ['1', '', '3', '4'],
  ]);
  assert.throws(() => parseCsv('a,"open'), /inside a quoted field/u);
});

test('specialties: Individual rows minus "Group" and "Student, Health Care", in the file order, {value, label, group}', () => {
  assert.deepEqual(specialtiesFrom(NUCC_FILE, { rows: 3, groupings: 2 }), [
    {
      value: '207RN0300X',
      label: 'Nephrology Physician',
      group: 'Allopathic & Osteopathic Physicians',
    },
    {
      value: '2080P0210X',
      label: 'Pediatric Nephrology Physician',
      group: 'Allopathic & Osteopathic Physicians',
    },
    { value: '111N00000X', label: 'Chiropractor', group: 'Chiropractic Providers' },
  ]);
});

test('specialties: refused unless both counts are the expected ones (695 in 16 for v26.1)', () => {
  assert.throws(
    () => specialtiesFrom(NUCC_FILE),
    /expected 695 rows in 16 groupings, read 3 in 2/u,
  );
  assert.throws(
    () => specialtiesFrom(NUCC_FILE, { rows: 3, groupings: 3 }),
    /expected 3 rows in 3 groupings/u,
  );
  assert.throws(
    () => specialtiesFrom(NUCC_FILE, { rows: 4, groupings: 2 }),
    /expected 4 rows in 2 groupings, read 3 in 2/u,
  );
  assert.throws(() => nuccRows('Code,Section\n1,Individual'), /no Grouping, Classification/u);
});

/** A guide as `pdftotext -layout` prints it: pages start with a form feed. */
const GUIDE = [
  '                   Common Codes',
  '\f Table Of Contents',
  '  Common Codes',
  '\fCommon Codes',
  'Supervision of Normal Pregnancy (ICD-9-CM V22.0, V22.1, V22.2)',
  'V72.31, V72.32) (Excluding Contraceptive and Procreative Codes)',
  ' I48.0\t\t          Paroxysmal atrial fibrillation',
  ' I48.91*          Unspecified atrial fibrillation',
  '\f I25.1Ø\t\t Atherosclerotic heart disease of',
  ' I10',
  '   401.9\t\t  Unspecified essential',
  ' I48.0\t\t          Paroxysmal atrial fibrillation, again',
  '\f   Clinical Documentation Tips',
  ' I50.9   Heart failure, unspecified',
].join('\n');

test('a guide\'s Common Codes: line-start codes in order, once, "*" and Ø read, ICD-9 and headings never', () => {
  assert.deepEqual(commonCodesIn(GUIDE), ['I48.0', 'I48.91', 'I25.10', 'I10']);
  assert.deepEqual(
    commonCodesIn(
      GUIDE.replace('\f   Clinical Documentation Tips', '\f   Primer for Pediatrics Clinical'),
    ),
    ['I48.0', 'I48.91', 'I25.10', 'I10'],
  );
  assert.deepEqual(
    commonCodesIn(
      GUIDE.replace('\f   Clinical Documentation Tips', '\fPediatrics Clinical Scenarios'),
    ),
    ['I48.0', 'I48.91', 'I25.10', 'I10'],
  );
  assert.throws(
    () => commonCodesIn(GUIDE.replace('\fCommon Codes', 'Common Codes')),
    /no page starts/u,
  );
  assert.throws(
    () =>
      commonCodesIn(
        GUIDE.replace('\f   Clinical Documentation Tips', 'Clinical Documentation Tips'),
      ),
    /no page after/u,
  );
});

test('a listed code not valid in the current table is kept as its three-character category, once', () => {
  const table = { 'I48.0': 'x', 'I48.91': 'x', I10: 'x' };
  assert.deepEqual(keptCodes(['I48.0', 'I48.1', 'I48.2', 'I10', 'R51'], table), {
    kept: ['I48.0', 'I48', 'I10', 'R51'],
    categories: ['I48.1', 'I48.2', 'R51'],
  });
});

test('the mapping is checked by NUCC Classification/Specialization name, and Nephrology gets the kidney families', () => {
  const rows = nuccRows(NUCC_FILE);
  checkMapping(rows, NEPHROLOGY.specialties);
  assert.throws(
    () => checkMapping(rows, [{ ...NEPHROLOGY.specialties[0]!, specialization: 'Cardiology' }]),
    /"Internal Medicine" \/ "Nephrology" in the NUCC file, not "Internal Medicine" \/ "Cardiology"/u,
  );
  assert.throws(
    () => checkMapping(rows, GUIDE_MAPPING.Cardiology),
    /207RC0000X is not in the NUCC file/u,
  );
  const all = GUIDES.flatMap((g) => GUIDE_MAPPING[g]);
  const full = nuccRows(
    csv(
      [...all, ...NEPHROLOGY.specialties].map(
        (m) =>
          `${m.code},Allopathic & Osteopathic Physicians,${m.classification},${m.specialization},,,x,Individual`,
      ),
    ),
  );
  const guides = Object.fromEntries(GUIDES.map((g) => [g, [`${g[0]}00`]])) as never;
  const preferences = preferencesFrom(full, guides);
  assert.deepEqual(preferences['207RN0300X'], [...NEPHROLOGY.families]);
  assert.deepEqual(preferences['2080P0210X'], [...NEPHROLOGY.families]);
  assert.deepEqual(preferences['207XX0005X'], ['O00']);
  assert.equal(Object.keys(preferences).length, all.length + 2);
});
