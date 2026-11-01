import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { GUIDES, GUIDE_MAPPING, NEPHROLOGY, NUCC } from '../scripts/v2-lists.js';
import { loadTable } from '../src/tables.js';

/**
 * The committed v2 assets, as `automations/icd10-code-check/scripts/build-v2-assets.ts` wrote them from NUCC v26.1 and CMS's
 * five guides against the 2027 table: the counts the spec asserts, and every preference a valid
 * code, a category the table holds, or a kidney family.
 */

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../assets/v2/${name}`, import.meta.url), 'utf8')) as never;
const { options, source } = read('specialties.json') as {
  options: { value: string; label: string; group: string }[];
  source: { version: string; effective: string };
};
const { preferences, table } = read('preferences.json') as {
  preferences: Record<string, string[]>;
  table: string;
};

test('specialties.json: NUCC v26.1, 695 rows in 16 groupings, none of "Group" or "Student, Health Care"', () => {
  assert.deepEqual(source, { url: NUCC.url, version: '26.1', effective: '2026-07-01' });
  assert.equal(options.length, 695);
  assert.equal(new Set(options.map((o) => o.group)).size, 16);
  assert.equal(new Set(options.map((o) => o.value)).size, 695);
  assert.ok(!options.some((o) => NUCC.leftOut.includes(o.group as never)));
  assert.deepEqual(
    options.find((o) => o.value === '207RN0300X'),
    {
      value: '207RN0300X',
      label: 'Nephrology Physician',
      group: 'Allopathic & Osteopathic Physicians',
    },
  );
  for (const o of options) assert.ok(o.label.length <= 120 && o.group.length <= 80, o.value);
});

test("preferences.json: the five guides' NUCC codes and Nephrology's two, each a dropdown value", () => {
  const mapped = [...GUIDES.flatMap((g) => GUIDE_MAPPING[g]), ...NEPHROLOGY.specialties].map(
    (m) => m.code,
  );
  assert.deepEqual(Object.keys(preferences).sort(), [...mapped].sort());
  const values = new Set(options.map((o) => o.value));
  for (const code of mapped) assert.ok(values.has(code), code);
  assert.deepEqual(preferences['207RN0300X'], [...NEPHROLOGY.families]);
  assert.deepEqual(preferences['2080P0210X'], [...NEPHROLOGY.families]);
});

test('preferences.json: every listed code valid (flag 1) in the 2027 table, else a category it holds', () => {
  assert.equal(table, 'codes-2027-oct.json');
  const { codes } = loadTable('2027-oct');
  const categories = new Set(Object.keys(codes).map((code) => code.slice(0, 3)));
  for (const [nucc, families] of Object.entries(preferences)) {
    if (NEPHROLOGY.specialties.some((s) => s.code === nucc)) continue;
    assert.ok(families.length > 0, nucc);
    for (const family of families)
      assert.ok(
        family in codes || (family.length === 3 && categories.has(family)),
        `${nucc} ${family}`,
      );
  }
  const cardiology = preferences['207RC0000X']!;
  assert.deepEqual(cardiology.slice(0, 5), ['R00.0', 'R00.1', 'R00.2', 'R00.8', 'R00.9']);
  assert.ok(cardiology.includes('I48') && !cardiology.includes('I48.1'), 'I48.1 kept as I48');
  assert.ok(preferences['207X00000X']!.includes('M51'), 'M51.36 kept as M51');
});
