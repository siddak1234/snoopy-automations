import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SPECIALTIES } from '../src/families.js';
import { TABLES, loadTable, normalCode, pickTable, realDate } from '../src/tables.js';
import { flow } from './fixtures.js';

/**
 * The code tables: the visit date picks one (the spec, section 7), each holds flag-1 codes only,
 * keyed by the code with its dot, and one table's load stays well inside the slot's 88M — under
 * 40 MB of heap, measured in a Node of its own.
 */

test('the visit date picks one table, at each edge', () => {
  const table = (date: string, available = TABLES) => pickTable(date, available);
  assert.deepEqual(table('2025-09-30'), { kind: 'early' });
  assert.deepEqual(table('2025-10-01'), { kind: 'table', table: '2026-oct' });
  assert.deepEqual(table('2026-03-31'), { kind: 'table', table: '2026-oct' });
  assert.deepEqual(table('2026-04-01'), { kind: 'table', table: '2026-apr' });
  assert.deepEqual(table('2026-09-30', ['2026-oct', '2027-oct']), { kind: 'hold' });
  assert.deepEqual(table('2026-10-01'), { kind: 'table', table: '2027-oct' });
  assert.deepEqual(table('2027-09-30'), { kind: 'table', table: '2027-oct' });
  assert.deepEqual(table('2027-10-01'), { kind: 'late' });
  assert.equal(realDate('2026-02-29'), undefined);
  assert.equal(realDate('10/12/2026'), undefined);
  assert.equal(realDate('2026-10-12'), '2026-10-12');
  assert.equal(normalCode(' n1831 '), 'N18.31');
  assert.equal(normalCode('I10'), 'I10');
});

test('each table holds flag-1 codes only, keyed by the code with its dot, with its title', () => {
  for (const id of TABLES) {
    const { codes, notes } = loadTable(id);
    assert.equal(codes['N18.32'], 'Chronic kidney disease, stage 3b');
    assert.equal(codes['Z99.2'], 'Dependence on renal dialysis');
    assert.equal(codes['N18.3'], undefined, 'a header is not a code');
    assert.equal(codes.N18, undefined);
    assert.ok(
      Object.keys(codes).every((code) => /^[A-Z][0-9A-Z]{2}(\.[0-9A-Z]{1,4})?$/u.test(code)),
    );
    assert.deepEqual(notes['N18.6'], [
      { kind: 'Use additional', note: 'code to identify dialysis status (Z99.2)' },
    ]);
  }
  assert.ok('I42.00' in loadTable('2027-oct').codes);
  assert.ok(!('I42.00' in loadTable('2026-oct').codes), 'a 2027 code is not in the 2026 table');
});

test('specialties.json is the dropdown and its families, in the spec order', () => {
  const asset = JSON.parse(
    readFileSync(join(flow, 'assets', 'specialties.json'), 'utf8'),
  ) as unknown;
  assert.deepEqual(asset, {
    specialties: SPECIALTIES.map((s) => ({ name: s.name, families: [...s.families] })),
  });
});

test("one table's load keeps under 40 MB of heap", () => {
  for (const id of TABLES) {
    const out = execFileSync(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', join(flow, 'test', 'heap-probe.ts'), id],
      {
        cwd: flow,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const { heap, codes } = JSON.parse(out) as { heap: number; codes: number };
    assert.ok(codes > 70_000, `${id}: ${codes} codes`);
    assert.ok(heap < 40 * 1024 * 1024, `${id}: ${Math.round(heap / 1024 / 1024)} MB`);
  }
});
