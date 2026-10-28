import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runChecks, type CheckInput } from '../src/checks.js';
import { readingOf } from '../src/reading.js';
import { loadTable } from '../src/tables.js';
import { reading, type Dx } from './fixtures.js';

/**
 * Gate C's checks one by one on the 2027 table (`check-codes`), the ones section 9's rows leave
 * untested: G3, K3, L1's "stated unrelated", L2, T1, and each specialty check off when its
 * specialties are not chosen.
 */

const { codes, notes } = loadTable('2027-oct');

function check(
  noteCodes: string[],
  dx: Dx[],
  picks: (string | null)[],
  specialties = ['Nephrology'],
) {
  const input: CheckInput = {
    reading: readingOf(reading(noteCodes, dx)),
    matches: Object.fromEntries(
      picks.flatMap((code, i) =>
        code === null ? [] : [[String(i), { code, quote: dx[i]!.statement }]],
      ),
    ),
    codes,
    notes,
    tableName: '2027',
    specialties,
  };
  const { rows, asks } = runChecks(input);
  return { rows: rows.map((r) => [r.code, r.verdict, r.suggested, r.check]), asks };
}

test('G3: a different code in the same category is the one the note supports', () => {
  const { rows } = check(
    ['N18.9'],
    [{ statement: 'CKD stage 4', categories: ['N18'] }],
    ['N18.4'],
    ['Cardiology'],
  );
  assert.deepEqual(rows, [['N18.9', 'change', 'N18.4', 'G3']]);
});

test('K3: N18.9 and no stage in the note is asked, for Nephrology only', () => {
  const dx = [{ statement: 'CKD', categories: ['N18'] }];
  const k3 = (s: string[]) =>
    check(['N18.9'], dx, ['N18.9'], s).asks.filter((a) => a.check === 'K3');
  assert.deepEqual(
    k3(['Nephrology']).map((a) => a.reason),
    ["The kidney disease stage isn't in this note. An earlier visit may have it."],
  );
  assert.deepEqual(k3(['Cardiology']), []);
});

test('L1: off when the note states the hypertension unrelated to the kidney disease, or no L1 specialty is chosen', () => {
  const dx: Dx[] = [
    {
      statement: 'Hypertension, not related to the kidney disease',
      categories: ['I10'],
      unrelatedTo: [1],
    },
    { statement: 'CKD stage 3a', categories: ['N18'] },
  ];
  assert.deepEqual(check(['I10', 'N18.31'], dx, ['I10', 'N18.31']).rows[0], [
    'I10',
    'keep',
    null,
    'G2',
  ]);
  const linked = dx.map((d) => ({ ...d, unrelatedTo: [] }));
  assert.deepEqual(check(['I10', 'N18.31'], linked, ['I10', 'N18.31'], ['Endocrinology']).rows[0], [
    'I10',
    'keep',
    null,
    'G2',
  ]);
  assert.deepEqual(check(['I10', 'N18.6'], linked, ['I10', 'N18.6']).rows[0], [
    'I10',
    'change',
    'I12.0',
    'L1',
  ]);
});

test('L2: hypertension, heart failure and CKD: I13 by the table titles, for Nephrology or Cardiology', () => {
  const dx: Dx[] = [
    { statement: 'Hypertension', categories: ['I10'] },
    { statement: 'Heart failure', categories: ['I50'] },
    { statement: 'CKD stage 4', categories: ['N18'] },
  ];
  const picks = ['I10', 'I50.9', 'N18.4'];
  assert.deepEqual(check(['I10', 'I50.9', 'N18.4'], dx, picks, ['Cardiology']).rows[0], [
    'I10',
    'change',
    'I13.0',
    'L2',
  ]);
  assert.deepEqual(
    check(['I10', 'I50.9', 'N18.6'], dx, ['I10', 'I50.9', 'N18.6'], ['Cardiology']).rows[0],
    ['I10', 'change', 'I13.2', 'L2'],
  );
  assert.deepEqual(check(['I10', 'I50.9', 'N18.4'], dx, picks, ['Endocrinology']).rows[0], [
    'I10',
    'keep',
    null,
    'G2',
  ]);
});

test('L3: E11.22 after the N18 code moves up; the specialty checks are off without their specialties', () => {
  const dx: Dx[] = [
    { statement: 'CKD stage 4', categories: ['N18'] },
    { statement: 'Type 2 diabetes with diabetic CKD', categories: ['E11'] },
  ];
  const picks = ['N18.4', 'E11.22'];
  assert.deepEqual(check(['N18.4', 'E11.22'], dx, picks, ['Endocrinology']).rows[1], [
    'E11.22',
    'moveUp',
    null,
    'L3',
  ]);
  assert.deepEqual(check(['N18.4', 'E11.22'], dx, picks, ['Cardiology']).rows[1], [
    'E11.22',
    'keep',
    null,
    'G2',
  ]);
  assert.deepEqual(
    check(
      ['N18.4', 'N18.6'],
      [{ statement: 'ESRD', categories: ['N18'] }],
      ['N18.6'],
      ['Cardiology'],
    ).rows[0],
    ['N18.4', 'ask', null, 'G6'],
  );
});

test("T1: a code-table note's codes missing is asked in the table's own words; one whose code is on the chart is not", () => {
  const dx: Dx[] = [{ statement: 'Type 2 diabetes with diabetic CKD', categories: ['E11'] }];
  const missing = check(['E11.22'], dx, ['E11.22'], ['Endocrinology']).asks.filter(
    (a) => a.check === 'T1',
  );
  assert.ok(
    missing.some(
      (a) =>
        a.reason ===
        'The code table says: Use additional code to identify stage of chronic kidney disease (N18.1-N18.6)',
    ),
    JSON.stringify(missing),
  );
  const dx2: Dx[] = [...dx, { statement: 'CKD stage 4', categories: ['N18'] }];
  const present = check(['E11.22', 'N18.4'], dx2, ['E11.22', 'N18.4'], ['Endocrinology']).asks;
  assert.ok(
    !present.some((a) => /N18\.1-N18\.6/u.test(a.reason ?? '')),
    'N18.4 is inside N18.1-N18.6',
  );
  assert.deepEqual(
    check(['E11.22'], dx, ['E11.22'], ['Cardiology']).asks.filter((a) => a.check === 'T1'),
    [],
  );
});

test('G7: a supported diagnosis with no code that fits is an ask for the doctor, in its own words', () => {
  const { rows, asks } = check(
    [],
    [{ statement: 'Itchy rash on both arms', categories: ['L30'] }],
    [null],
  );
  assert.deepEqual(rows, []);
  assert.deepEqual(asks, [
    {
      title: '“Itchy rash on both arms”',
      reason: "The note supports this, and it isn't on the chart.",
      check: 'G7',
    },
  ]);
});
