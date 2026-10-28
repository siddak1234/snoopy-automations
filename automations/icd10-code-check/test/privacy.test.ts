import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readingOf, withoutPatient } from '../src/reading.js';
import { reading, run } from './fixtures.js';

/**
 * The privacy rows (the spec, section 4): `match-codes` is sent no `patient` value, no
 * `otherIdentifiers` value and not the specialties — each with a test — and "[patient]" stands in
 * each one's place; `read-note` is sent the file whole.
 */

const patient = {
  name: 'Jane Q. Doe',
  birthDate: '1958-03-14',
  sex: 'Female',
  recordNumber: 'MRN-000123',
  provider: 'Dr. Alan Smith',
};
const note = (statement: string, evidence: string | null = null, otherIdentifiers: string[] = []) =>
  readingOf(
    reading([], [{ statement, categories: ['N18'], evidence }], { patient, otherIdentifiers }),
  );

const cases: [string, string, string][] = [
  ['the name', 'Jane Q. Doe has CKD stage 4', '[patient] has CKD stage 4'],
  ['a word of the name, in any case', 'Ms. DOE has CKD stage 4', 'Ms. [patient] has CKD stage 4'],
  ['the birth date', 'Born 1958-03-14, CKD stage 4', 'Born [patient], CKD stage 4'],
  ['the sex', 'Female with CKD stage 4', '[patient] with CKD stage 4'],
  ['the record number', 'CKD stage 4 (MRN-000123)', 'CKD stage 4 ([patient])'],
  ['the provider', 'CKD stage 4 per Dr. Alan Smith', 'CKD stage 4 per [patient]'],
];

for (const [what, statement, sent] of cases) {
  test(`${what} is replaced by "[patient]" in a statement`, () => {
    assert.equal(withoutPatient(statement, note(statement)), sent);
  });
}

test('every other identifier printed is replaced, in a statement and in its evidence', () => {
  const r = note('CKD stage 4, call 555-0100', 'seen at 12 Elm Street', [
    '555-0100',
    '12 Elm Street',
  ]);
  assert.equal(withoutPatient(r.diagnoses[0]!.statement, r), 'CKD stage 4, call [patient]');
  assert.equal(withoutPatient(r.diagnoses[0]!.evidence!, r), 'seen at [patient]');
});

test('a value is replaced only as a whole word: "Doe" leaves "Doering" alone', () => {
  assert.equal(
    withoutPatient('Doering reflex absent, CKD stage 4', note('x')),
    'Doering reflex absent, CKD stage 4',
  );
});

test('match-codes is sent none of them, and not the specialties; read-note the file', async () => {
  const statement =
    'Jane Q. Doe (MRN-000123, born 1958-03-14), Female, CKD stage 4, phone 555-0100';
  const r = reading(
    [],
    [{ statement, categories: ['N18'], evidence: 'Dr. Alan Smith reviewed eGFR' }],
    {
      patient,
      otherIdentifiers: ['555-0100'],
    },
  );
  const { platform } = await run(
    r,
    { 'CKD stage 4': { code: 'N18.4', quote: 'CKD stage 4' } },
    { specialties: ['Nephrology', 'Cardiology'] },
  );
  const call = platform.modelCalls[1]!;
  const sent = JSON.stringify({ prompt: call.prompt, input: call.input });
  for (const value of [
    'Jane',
    'Doe',
    'MRN-000123',
    '1958-03-14',
    'Female',
    '555-0100',
    'Alan Smith',
    'Nephrology',
    'Cardiology',
  ]) {
    assert.ok(!sent.includes(value), `${value} was sent`);
  }
  assert.deepEqual(Object.keys(call.input), ['diagnoses']);
  assert.ok(platform.modelCalls[0]?.artifactId !== undefined, 'read-note reads the file whole');
});
