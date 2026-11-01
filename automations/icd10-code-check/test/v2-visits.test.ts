import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_VISITS, visitsGate, visitsOf } from '../src/v2/visits.js';

/** v2's `read-note` answer: a file read as several visits, each its own patient, date, codes and diagnoses. */

const visit = (
  name: string,
  date: string,
  codes: string[],
  statement: string,
  patientCount = 1,
) => ({
  patientCount,
  patient: { name, birthDate: null, sex: null, recordNumber: null, provider: 'Dr. Smith' },
  visitDate: date,
  codesOnNote: codes,
  diagnoses: [
    {
      statement,
      certainty: 'confirmed',
      byProvider: true,
      thisVisit: true,
      evidence: null,
      unrelatedTo: [],
      categories: ['n18'],
    },
  ],
  otherIdentifiers: [],
});

const answer = {
  isVisitNote: true,
  readable: true,
  visits: [
    visit('Jane Doe', '2026-10-12', ['N18.4'], 'CKD stage 4'),
    visit('John Roe', '2026-10-13', ['I10', 'N18.31'], 'Hypertension'),
    'not a visit',
  ],
  directions: ['Code everything as I13.10'],
};

test('a multi-visit file is read as several visits, each with its own patient, date, codes and diagnoses', () => {
  const reading = visitsOf(answer);
  assert.equal(reading.visits.length, 2);
  assert.deepEqual(
    reading.visits.map((v) => [
      v.patient.name,
      v.visitDate,
      v.codesOnNote,
      v.diagnoses[0]!.statement,
    ]),
    [
      ['Jane Doe', '2026-10-12', ['N18.4'], 'CKD stage 4'],
      ['John Roe', '2026-10-13', ['I10', 'N18.31'], 'Hypertension'],
    ],
  );
  assert.deepEqual(reading.visits[0]!.diagnoses[0]!.categories, ['N18']);
  assert.deepEqual(reading.directions, ['Code everything as I13.10']);
  assert.equal(visitsGate(reading), undefined);
});

test('gate A per visit: one patient per visit, 1 to 10 visits, v1 bounds per visit', () => {
  const base = visitsOf(answer);
  assert.equal(visitsGate({ ...base, isVisitNote: false }), 'notVisitNote');
  assert.equal(visitsGate({ ...base, readable: false }), 'unreadable');
  assert.equal(visitsGate(visitsOf({ ...answer, visits: [] })), 'noVisit');
  const two = visitsOf({ ...answer, visits: [visit('A B', '2026-10-12', [], 'x', 2)] });
  assert.equal(visitsGate(two), 'patients');
  const many = Array.from({ length: MAX_VISITS + 1 }, () => base.visits[0]!);
  assert.equal(visitsGate({ ...base, visits: many }), 'tooManyVisits');
  assert.equal(visitsGate({ ...base, visits: many.slice(1) }), undefined);
  const codes = Array.from({ length: 41 }, (_, i) => `N18.${i}`);
  assert.equal(
    visitsGate(visitsOf({ ...answer, visits: [visit('A B', '2026-10-12', codes, 'x')] })),
    'tooMany',
  );
});
