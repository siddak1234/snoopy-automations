import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Role } from '../src/reading.js';
import { monthOf, periodLine, yearsLine, yearsOfExperience } from '../src/years.js';
import { NOW } from './fixtures.js';

/**
 * Years of experience, worked out by the code from the dates the resume printed, never by the
 * model (the spec's §4): a role's line, and the candidate's years, overlaps counted once.
 */

const role = (start: string, end: string, current = false): Role => ({
  title: 'Accountant',
  company: 'Acme Corp',
  start,
  end,
  current,
  highlights: [],
});

test('a printed date is a month: YYYY-MM, or YYYY from its January; anything else is none', () => {
  assert.equal(monthOf('2021-03', NOW), 2021 * 12 + 2);
  assert.equal(monthOf('2021', NOW), 2021 * 12);
  assert.equal(monthOf('2021-03-15', NOW), 2021 * 12 + 2);
  for (const none of ['', 'March 2021', '2021-13', '1949', '2027-01', 'now']) {
    assert.equal(monthOf(none, NOW), undefined, none);
  }
});

test("a role's line: its years, to now when current, or years not shown", () => {
  assert.equal(periodLine(role('2021-03', '', true), NOW), '2021 – now · 5 years');
  assert.equal(periodLine(role('2018', '2021'), NOW), '2018 – 2021 · 3 years');
  assert.equal(periodLine(role('2024-06', '2025-01'), NOW), '2024 – 2025 · under a year');
  assert.equal(periodLine(role('2019-01', '2020-02'), NOW), '2019 – 2020 · 1 year');
  assert.equal(periodLine(role('', ''), NOW), 'years not shown');
  assert.equal(periodLine(role('2021', ''), NOW), 'years not shown', 'no end, not current');
  assert.equal(periodLine(role('2022', '2020'), NOW), 'years not shown', 'ends before it starts');
  assert.equal(yearsLine(11), 'under a year');
});

test("the candidate's years: every dated role, overlaps once; 0 with no role, null with none dated", () => {
  // 2018-01 to 2021-01 and 2021-03 to now (2026-10): 36 + 67 months.
  assert.equal(yearsOfExperience([role('2021-03', '', true), role('2018', '2021')], NOW), 8.5);
  // Two roles held at once count once: 2019-01 to 2023-01.
  assert.equal(yearsOfExperience([role('2019-01', '2022-01'), role('2020-06', '2023-01')], NOW), 4);
  // An undated role adds nothing; the dated one still counts.
  assert.equal(yearsOfExperience([role('', ''), role('2024-01', '2025-07')], NOW), 1.5);
  assert.equal(yearsOfExperience([role('', ''), role('', '', true)], NOW), null);
  assert.equal(yearsOfExperience([], NOW), 0);
});
