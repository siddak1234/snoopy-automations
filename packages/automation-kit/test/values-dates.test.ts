import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EARLIEST_YEAR, addDays, isWithin, parseDate, utcDay } from '../src/values/dates.js';

test('a printed date is a real YYYY-MM-DD day from 2000 on, trimmed', () => {
  for (const value of ['2028-02-29', '2026-10-11', '2000-01-01', ' 2026-01-05 ']) {
    assert.deepEqual(parseDate(value), { kind: 'date', date: value.trim() }, value);
  }
  for (const value of [
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-1-05',
    '0099-01-01',
    '1999-12-31',
    '10/11/2026',
    '2026-10-11T00:00:00Z',
    '20261011',
  ]) {
    assert.deepEqual(parseDate(value), { kind: 'invalid' }, value);
  }
  assert.equal(EARLIEST_YEAR, 2000);
});

test('null or blank is none printed; anything that is not text is not a date', () => {
  for (const value of [null, undefined, '', '   ']) {
    assert.deepEqual(parseDate(value), { kind: 'none' }, String(value));
  }
  for (const value of [20261011, true, {}]) {
    assert.deepEqual(parseDate(value), { kind: 'invalid' }, String(value));
  }
});

test('days are counted in UTC, across a month, a year and a leap day', () => {
  assert.equal(utcDay(Date.parse('2026-10-10T23:59:59.999Z')), '2026-10-10');
  assert.equal(addDays('2026-10-11', 1), '2026-10-12');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-09-27', 20), '2026-10-17');
  assert.equal(addDays('2026-09-27', 0), '2026-09-27');
});

test('a window includes both of its days', () => {
  assert.ok(isWithin('2026-09-26', '2026-09-26', '2026-10-17'));
  assert.ok(isWithin('2026-10-17', '2026-09-26', '2026-10-17'));
  assert.ok(!isWithin('2026-09-25', '2026-09-26', '2026-10-17'));
  assert.ok(!isWithin('2026-10-18', '2026-09-26', '2026-10-17'));
});
