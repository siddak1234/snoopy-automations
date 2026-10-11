import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Decision } from '../src/decide/decide.js';
import { joinWithin } from '../src/decide/words.js';
import { paidBy, statement } from './check-world.js';
import { VENDOR, billRow, decide, found, type DecideSetUp } from './decide-world.js';

/**
 * A supplier's statement (the plan's §2.5, §2.6, §2.9 "Statements"; D26): compared with QuickBooks,
 * nothing written, no approval — its own sum, the listed invoices QuickBooks lacks, the open bills
 * it does not list, and its balance against the vendor's.
 */

const OPEN = 68_654;
const compared = (setUp: Partial<DecideSetUp> = {}) => {
  const decision: Decision = decide({
    answer: statement(),
    vendor: { ...VENDOR, balanceCents: OPEN },
    ...setUp,
  });
  assert.equal(decision.outcome, 'compared', JSON.stringify(decision).slice(0, 200));
  return decision as Extract<Decision, { outcome: 'compared' }>;
};

/** The vendor's bills, as find-duplicate-number finds the listed ones. */
const listedFound = found(
  billRow({ id: '1', docNumber: 'HOS-1031', balanceCents: 0 }),
  billRow({ id: '2', docNumber: 'hos-1042' }),
);

test('every listed invoice in QuickBooks, and the balances the same: the line says so, nothing created', () => {
  const all = found(
    ...['HOS-1031', 'HOS-1042', 'HOS-1050'].map((docNumber, index) =>
      billRow({ id: String(index), docNumber }),
    ),
  );
  const { summary, result } = compared({ lookups: { numberLookup: all } });
  assert.equal(
    summary,
    'Statement balance $686.54; QuickBooks shows $686.54 open (the same). Nothing was created.',
  );
  assert.deepEqual(result, {
    v: 1,
    documentType: 'supplier_statement',
    route: 'statement',
    vendor: { id: '7', displayName: 'Harrowgate Office Supply' },
    closingCents: OPEN,
    ownSum: 'adds_up',
    ownSumDifferenceCents: null,
    listedNotInQuickBooks: [],
    listedCheckable: true,
    openBillsNotListed: { count: 0, totalCents: 0 },
    quickBooksOpenCents: OPEN,
    differenceCents: 0,
    secondCheck: 'made',
    switchIgnored: false,
  });
});

test('missing invoices, open bills it does not list, and a balance that differs', () => {
  const { summary, result } = compared({
    vendor: { ...VENDOR, balanceCents: 98_000 },
    lookups: {
      numberLookup: listedFound,
      amountLookup: found(
        billRow({ id: '9', docNumber: 'HOS-0999', balanceCents: 29_346 }),
        billRow({ id: '2', docNumber: 'HOS-1042' }),
      ),
    },
  });
  assert.deepEqual(result.listedNotInQuickBooks, ['HOS-1050']);
  assert.deepEqual(result.openBillsNotListed, { count: 1, totalCents: 29_346 });
  assert.equal(result.differenceCents, 68_654 - 98_000);
  assert.equal(
    summary,
    'Statement balance $686.54; QuickBooks shows $980.00 open (differs by $293.46); 1 listed invoice not in QuickBooks; 1 open bill not on it ($293.46). Nothing was created.',
  );
});

test('an incomplete list: its own sum and the unlisted open bills are not judged', () => {
  const { summary, result } = compared({
    answer: statement({ listedItemsComplete: false }),
    lookups: { numberLookup: listedFound },
  });
  assert.deepEqual([result.ownSum, result.openBillsNotListed], ['incomplete', null]);
  assert.match(summary, /its list is not complete\. Nothing was created\.$/u);
  // Its own rows not adding up, the list complete.
  const differs = compared({
    answer: statement({ total: 700 }),
    lookups: { numberLookup: listedFound },
  });
  assert.deepEqual(
    [differs.result.ownSum, differs.result.ownSumDifferenceCents],
    ['differs', 68_654 - 70_000],
  );
  assert.match(differs.summary, /its own rows differ by \$13\.46/u);
});

test('a lookup at its maximum: the missing count may be too many', () => {
  const { summary, result } = compared({
    lookups: { numberLookup: { reachedMax: true, records: [] } },
  });
  assert.equal(result.listedCheckable, false);
  assert.match(summary, /3 listed invoices not in QuickBooks \(too many to check\)/u);
});

test('read 2 not made, the switch on, QuickBooks showing nothing open: the line says each; still no approval', () => {
  const { summary, result } = compared({
    verification: { status: 'not_made', reason: 'no_answer' },
    check: paidBy('employee'),
    vendor: { ...VENDOR, balanceCents: null },
    lookups: { numberLookup: listedFound },
  });
  assert.deepEqual(
    [result.secondCheck, result.switchIgnored, result.quickBooksOpenCents],
    ['not_made', true, null],
  );
  assert.equal(
    summary,
    "Statement balance $686.54; 1 listed invoice not in QuickBooks; second check not made; the switch doesn't apply to a statement. Nothing was created.",
  );
  for (const line of [summary]) assert.ok(line.length <= 200);
});

test('the line keeps "Nothing was created." whatever it leaves out to fit 200 characters', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    reference: `INV-${'0'.repeat(20)}${index}`,
    amount: 10,
    kind: 'invoice',
  }));
  const { summary, result } = compared({
    answer: statement({ listedItems: many, total: 400 }),
    vendor: { ...VENDOR, balanceCents: 1 },
    verification: { status: 'not_made', reason: 'no_answer' },
    check: paidBy('owner'),
  });
  assert.equal(result.listedNotInQuickBooks.length, 40, 'the full list in the output');
  assert.ok(summary.length <= 200 && summary.endsWith('. Nothing was created.'), summary);
});

test('a line fitted to 200: the parts that do not fit are left out from the end, the tail always kept', () => {
  const tail = '. Nothing was created.';
  const line = joinWithin(['a'.repeat(150), 'b'.repeat(40), 'c'], tail);
  assert.equal(line, `${'a'.repeat(150)}${tail}`);
  assert.equal(
    joinWithin(['a'.repeat(300)], tail).length,
    200,
    'the first part, alone too long, cut',
  );
  assert.equal(joinWithin(['one', 'two'], tail), `one; two${tail}`);
});
