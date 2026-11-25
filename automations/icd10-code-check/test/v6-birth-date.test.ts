import assert from 'node:assert/strict';
import { test } from 'node:test';

import { birthDateOf } from '../src/v6/chart-note.js';

/**
 * The note's birth date as a FHIR `date` (`birthDateOf`, README "v6", row 4): the one patient the
 * record number finds is written to only when its `birthDate` is this one. Every date is made up.
 */

test('a birth date printed year first, month first or with its month named reads as YYYY-MM-DD', () => {
  for (const printed of [
    '1958-03-14',
    '1958/3/14',
    '1958.03.14',
    '03/14/1958',
    '3/14/1958',
    '03-14-1958',
    'March 14, 1958',
    'Mar. 14 1958',
    '14 March 1958',
    '14-MAR-1958',
    ' 1958-03-14 ',
  ]) {
    assert.equal(birthDateOf(printed), '1958-03-14', printed);
  }
  assert.equal(birthDateOf('Sept 9, 2001'), '2001-09-09');
});

test('anything else is no date: never guessed', () => {
  for (const printed of [
    '',
    '1958',
    '03/1958',
    '03/14/58',
    '14/03/1958',
    '02/30/1958',
    '1958-02-29',
    'Ma 14 1958',
    'Smarch 14 1958',
    '14 March',
    'March 14 1958 9:00',
    'DOB 03/14/1958',
    '0003/14/1958',
  ]) {
    assert.equal(birthDateOf(printed), undefined, printed);
  }
});
