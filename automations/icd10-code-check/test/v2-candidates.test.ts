import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidatesFor } from '../src/candidates.js';
import type { CodeTable } from '../src/tables.js';
import { loadTable } from '../src/tables.js';
import {
  loadPreferences,
  preferredFamilies,
  rankCandidates,
  specialtiesForRun,
  taxonomiesOf,
} from '../src/v2/candidates.js';

/**
 * v2's candidates: the clinic's preference families first, then v1's words-shared rank, never
 * limited; the specialties a run uses, the setup's picks else the NPI's taxonomies.
 */

const codes: CodeTable = {
  'N18.1': 'Chronic kidney disease, stage 1',
  'N18.4': 'Chronic kidney disease, stage 4 (severe)',
  'N18.9': 'Chronic kidney disease, unspecified',
  'I12.9':
    'Hypertensive chronic kidney disease with stage 1 through stage 4 chronic kidney disease',
  I10: 'Essential (primary) hypertension',
};

test('preference families first, then the words shared, then shorter codes, then the table order', () => {
  const d = { statement: 'Hypertensive CKD stage 4', categories: ['N18', 'I12', 'I10'] };
  assert.deepEqual(rankCandidates(d, codes, []), ['I12.9', 'N18.1', 'N18.4', 'I10', 'N18.9']);
  assert.deepEqual(rankCandidates(d, codes, ['I10']), ['I10', 'I12.9', 'N18.1', 'N18.4', 'N18.9']);
  assert.deepEqual(rankCandidates(d, codes, ['N17-N19']), [
    'N18.1',
    'N18.4',
    'N18.9',
    'I12.9',
    'I10',
  ]);
});

test('never limited: every code of the categories, where v1 stops at 60', () => {
  const { codes: table } = loadTable('2027-oct');
  const all = Object.keys(table).filter((code) => code.startsWith('E11'));
  assert.ok(all.length > 60);
  const d = { statement: 'Type 2 diabetes with hyperglycemia', categories: ['E11'] };
  const listed = rankCandidates(d, table, ['E11.22']);
  assert.equal(listed.length, all.length);
  assert.equal(listed[0], 'E11.22');
  assert.equal(listed[1], 'E11.65');
  const v1 = candidatesFor(
    {
      ...d,
      certainty: 'confirmed',
      byProvider: true,
      thisVisit: true,
      evidence: null,
      unrelatedTo: [],
    },
    table,
    [],
    [],
  );
  assert.equal(v1.length, 60);
});

test("a clinic's families: the chosen NUCC codes' preferences in order, each once", () => {
  const preferences = loadPreferences();
  const families = preferredFamilies(
    ['207RN0300X', '2080P0210X', '207RC0000X', '000000000X'],
    preferences,
  );
  assert.deepEqual(families.slice(0, 11), [...preferences['207RN0300X']!]);
  assert.equal(
    families.length,
    11 + preferences['207RC0000X']!.filter((f) => !preferences['207RN0300X']!.includes(f)).length,
  );
  assert.deepEqual(preferredFamilies([], preferences), []);
});

test("the NPI's taxonomies fill the specialties only when none are picked; only dropdown codes", () => {
  const registry = {
    results: [
      {
        taxonomies: [
          { code: '207R00000X', desc: 'Internal Medicine', primary: false },
          { code: '207RN0300X', desc: 'Internal Medicine, Nephrology', primary: true },
          { code: 'bad', primary: true },
        ],
      },
    ],
  };
  const fromNpi = taxonomiesOf(registry);
  assert.deepEqual(fromNpi, ['207RN0300X', '207R00000X']);
  assert.deepEqual(taxonomiesOf({}), []);
  assert.deepEqual(taxonomiesOf(null), []);
  const known = new Set(['207RN0300X', '207R00000X', '207RC0000X']);
  assert.deepEqual(specialtiesForRun([], fromNpi, known), ['207RN0300X', '207R00000X']);
  assert.deepEqual(specialtiesForRun(['207RC0000X'], fromNpi, known), ['207RC0000X']);
  assert.deepEqual(specialtiesForRun([], ['999999999X'], known), []);
});
