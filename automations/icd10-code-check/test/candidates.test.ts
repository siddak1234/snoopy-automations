import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_CANDIDATES, candidatesFor } from '../src/candidates.js';
import type { Diagnosis } from '../src/reading.js';
import { loadTable, type CodeTable } from '../src/tables.js';

/**
 * Section 4's candidates (the owner, 2026-10-28 ~23:17Z, "Rank by matching words"): ranked by the
 * words each title shares with the statement — case and punctuation aside, words under 3 letters
 * left out — then the shorter codes, then the table's order; the chosen specialties' family codes
 * and the note's own codes always among them; at most 60.
 */

const diagnosis = (statement: string, categories: string[]): Diagnosis =>
  ({
    statement,
    categories,
    certainty: 'confirmed',
    byProvider: true,
    thisVisit: true,
    evidence: null,
    unrelatedTo: [],
  }) as Diagnosis;

test('§9 ranked by matching words: "Type 2 diabetes with hyperglycemia" lists E11.65 first, in any case and punctuation', () => {
  const { codes } = loadTable('2027-oct');
  for (const statement of [
    'Type 2 diabetes with hyperglycemia',
    'TYPE-2 DIABETES, with HYPERGLYCEMIA!',
  ]) {
    const listed = candidatesFor(diagnosis(statement, ['E11']), codes, [], []);
    assert.equal(listed[0], 'E11.65', statement);
    assert.equal(listed.length, MAX_CANDIDATES);
  }
});

test('§9 words of fewer than 3 letters do not count; then the shorter codes, then the table order', () => {
  const codes: CodeTable = {
    'A00.0': 'Cholera due to Vibrio',
    'A00.1': 'El Tor of the kind',
    'A00.10': 'Cholera of another kind',
    'A00.9': 'Cholera, unspecified',
  };
  assert.deepEqual(candidatesFor(diagnosis('Cholera of El', ['A00']), codes, [], []), [
    'A00.0',
    'A00.9',
    'A00.10',
    'A00.1',
  ]);
});

test("§9 at most 60: the chosen specialties' family codes and the note's own codes always among them", () => {
  const codes: Record<string, string> = {};
  for (let n = 10; n < 80; n += 1) codes[`B00.${n}`] = 'Matching words here';
  codes['B00.98'] = 'Nothing alike';
  codes['B00.99'] = 'Nothing alike';
  const listed = candidatesFor(diagnosis('Matching words', ['B00']), codes, ['B00.99'], ['B00.98']);
  assert.equal(listed.length, MAX_CANDIDATES);
  assert.ok(listed.includes('B00.99'), 'the family code');
  assert.ok(listed.includes('B00.98'), "the note's own code");
  assert.deepEqual(listed.slice(-2), ['B00.98', 'B00.99'], 'still in rank order');
});
