import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DELETED_MARK,
  rowsNaming,
  unmarkedName,
  withDeletedForm,
} from '../src/quickbooks/names.js';

/**
 * The names QuickBooks gives inactive records (sandbox G4–5 and S1, 2026-10-12): a vendor, an
 * employee or an account made inactive is renamed "<name> (deleted)", so a lookup asks for both
 * forms and reads an inactive row by the name it had.
 */

const exactly = (value: unknown, name: string) => value === name;

test('a lookup asks for a name and the name QuickBooks gives it once inactive', () => {
  assert.equal(DELETED_MARK, ' (deleted)');
  assert.deepEqual(withDeletedForm('Tidewell Hardware'), [
    'Tidewell Hardware',
    'Tidewell Hardware (deleted)',
  ]);
  assert.deepEqual(withDeletedForm('Utilities:Gas'), ['Utilities:Gas', 'Utilities:Gas (deleted)']);
});

test('an inactive row reads as the name it had; an active row keeps its name, mark and all', () => {
  const cases: [Record<string, unknown>, string, unknown][] = [
    [
      { DisplayName: 'Tidewell Hardware (deleted)', Active: false },
      'DisplayName',
      'Tidewell Hardware',
    ],
    [
      { FullyQualifiedName: 'Utilities:Gas (deleted)', Active: false },
      'FullyQualifiedName',
      'Utilities:Gas',
    ],
    // A person may name an active record so: only QuickBooks' own rename is undone.
    [
      { DisplayName: 'Tidewell Hardware (deleted)', Active: true },
      'DisplayName',
      'Tidewell Hardware (deleted)',
    ],
    // A missing Active is Intuit's default, true.
    [{ DisplayName: 'Tidewell Hardware (deleted)' }, 'DisplayName', 'Tidewell Hardware (deleted)'],
    [{ DisplayName: 'Tidewell Hardware', Active: false }, 'DisplayName', 'Tidewell Hardware'],
    [
      { DisplayName: 'Tidewell Hardware (Deleted)', Active: false },
      'DisplayName',
      'Tidewell Hardware (Deleted)',
    ],
    [{ DisplayName: 7, Active: false }, 'DisplayName', 7],
  ];
  for (const [row, field, name] of cases) {
    assert.equal(unmarkedName(row as never, field), name, JSON.stringify(row));
  }
});

test('the rows naming a name: those holding it as it is decide, and only when none does, the inactive rows renamed from it', () => {
  const live = { Id: '73', DisplayName: 'Larkspur Paper', Active: true };
  const renamed = { Id: '72', DisplayName: 'Larkspur Paper (deleted)', Active: false };
  // Both forms found: the live record, as a lookup by the name alone found it; the former one dropped.
  assert.deepEqual(rowsNaming([renamed, live], 'DisplayName', 'Larkspur Paper', exactly), {
    rows: [live],
    others: 0,
  });
  // Only the renamed one: it, inactive — the caller's "inactive", not its "none".
  assert.deepEqual(rowsNaming([renamed], 'DisplayName', 'Larkspur Paper', exactly), {
    rows: [renamed],
    others: 0,
  });
  // An active record a person named "… (deleted)" is not the name's: another match, ignored.
  const named = { Id: '5', DisplayName: 'Larkspur Paper (deleted)', Active: true };
  assert.deepEqual(rowsNaming([named], 'DisplayName', 'Larkspur Paper', exactly), {
    rows: [],
    others: 1,
  });
  // A row naming neither form is counted for the caller to ignore; the comparison is the caller's.
  const cased = { Id: '9', DisplayName: 'LARKSPUR PAPER', Active: true };
  assert.deepEqual(rowsNaming([cased, live], 'DisplayName', 'Larkspur Paper', exactly), {
    rows: [live],
    others: 1,
  });
  const folded = (value: unknown, name: string) =>
    typeof value === 'string' && value.toLowerCase() === name.toLowerCase();
  assert.deepEqual(rowsNaming([cased, live], 'DisplayName', 'Larkspur Paper', folded), {
    rows: [cased, live],
    others: 0,
  });
  // A name typed with the mark finds the renamed record as it is.
  assert.deepEqual(rowsNaming([renamed], 'DisplayName', 'Larkspur Paper (deleted)', exactly), {
    rows: [renamed],
    others: 0,
  });
  assert.deepEqual(rowsNaming([], 'DisplayName', 'Larkspur Paper', exactly), {
    rows: [],
    others: 0,
  });
});
