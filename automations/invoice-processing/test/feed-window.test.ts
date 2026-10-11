import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { EXPENSE_SEARCH, type ExpenseSearch } from '../src/lookups/expense-search.js';
import { LOOKUP_SENTENCES } from '../src/lookups/read.js';
import { bill, receipt, sampleAnswer } from './check-world.js';
import { lines } from './fixtures.js';
import { PAID, REF, lineOf, queriesOf, routeRun, samplePurchase } from './lookups-world.js';

/**
 * The bank-feed check (D21) at the edges of its window — 2 days before, 1 day before, 20 days
 * after, 21 days after — for a receipt and a card refund, under both of sandbox S4's answers: by
 * amount (D21, the default), and §5's fallback, the window alone, newest first, a full answer a
 * possible duplicate ("too many expenses to check"), a bill's D32 check dropped.
 */

const BOTH: readonly ExpenseSearch[] = ['amount', 'window'];

test('S4 is decided by the sandbox before v1 registers; until then, D21: expenses searched by amount', () => {
  assert.equal(EXPENSE_SEARCH, 'amount');
});

test("a receipt's bank-feed check: a charge on Paid from 1 day before to 20 days after holds; 2 before or 21 after does not", async () => {
  // The receipt is dated 2026-09-27.
  const edges: [string, boolean][] = [
    ['2026-09-25', false],
    ['2026-09-26', true],
    ['2026-10-17', true],
    ['2026-10-18', false],
  ];
  for (const how of BOTH) {
    for (const [date, holds] of edges) {
      const world = await routeRun({
        answer: receipt(),
        expenseSearch: how,
        company: (sim) =>
          sim.company.purchases.push(
            samplePurchase('201', REF.visa, { TxnDate: date, TotalAmt: 60.63 }),
          ),
      });
      const label = `${how}: a charge on ${date}`;
      if (!holds) {
        assert.equal(world.result.outcome, 'success', label);
        continue;
      }
      assert.ok(world.result.outcome === 'held', label);
      assert.equal(
        world.result.held.reason,
        'Possible duplicate: Tidewell Hardware, $60.63 from Company Visa',
        label,
      );
      assert.match(
        lineOf(world, 'decide') ?? '',
        /possible duplicate: a charge for this amount on the Paid from account/u,
        label,
      );
    }
  }
});

test("a card refund's check: a refund on the card in the window holds; outside it, or a charge rather than a refund, does not", async () => {
  // The refund is dated 2026-10-02.
  const edges: [string, boolean, boolean][] = [
    ['2026-09-30', true, false],
    ['2026-10-01', true, true],
    ['2026-10-22', true, true],
    ['2026-10-23', true, false],
    ['2026-10-05', false, false],
  ];
  for (const how of BOTH) {
    for (const [date, credit, holds] of edges) {
      const world = await routeRun({
        answer: sampleAnswer('card-refund'),
        expenseSearch: how,
        company: (sim) =>
          sim.company.purchases.push(
            samplePurchase('202', REF.visa, { TxnDate: date, TotalAmt: 23.72, Credit: credit }),
          ),
      });
      const label = `${how}: ${credit ? 'a refund' : 'a charge'} on ${date}`;
      assert.equal(world.result.outcome, holds ? 'held' : 'success', label);
      if (holds) {
        assert.match(lineOf(world, 'decide') ?? '', /a refund for this amount on the card/u, label);
      }
    }
  }
});

test('the fallback reads the window newest first, 50 at most; a full answer holds, its line "too many expenses to check" (D6)', async () => {
  const world = await routeRun({
    answer: receipt(),
    expenseSearch: 'window',
    company: (sim) => {
      for (let index = 0; index < 50; index += 1) {
        sim.company.purchases.push(
          samplePurchase(String(500 + index), REF.checking, {
            TxnDate: '2026-10-01',
            TotalAmt: 9.99,
          }),
        );
      }
    },
  });
  assert.equal(
    queriesOf(world)['find-duplicate-amount'],
    "SELECT * FROM Purchase WHERE TxnDate >= '2026-09-26' AND TxnDate <= '2026-10-17' ORDERBY TxnDate DESC MAXRESULTS 50",
  );
  assert.equal(
    lineOf(world, 'find-duplicate-amount'),
    'Expenses from 2026-09-26 to 2026-10-17: 50 read, 0 for $60.63; too many expenses to check',
  );
  assert.ok(world.result.outcome === 'held');
  assert.match(lineOf(world, 'decide') ?? '', /possible duplicate: too many to check/u);
  // 49 rows: read whole, compared in code, no hold.
  const fewer = await routeRun({
    answer: receipt(),
    expenseSearch: 'window',
    company: (sim) => {
      for (let index = 0; index < 49; index += 1) {
        sim.company.purchases.push(
          samplePurchase(String(500 + index), REF.checking, {
            TxnDate: '2026-10-01',
            TotalAmt: 9.99,
          }),
        );
      }
    },
  });
  assert.equal(fewer.result.outcome, 'success');
  assert.equal(
    lineOf(fewer, 'find-duplicate-amount'),
    'Expenses from 2026-09-26 to 2026-10-17: 49 read, 0 for $60.63',
  );
});

test("under the fallback a bill's D32 check is dropped, and decide needs it not; decision 6's number check remains", async () => {
  const fallback = await routeRun({ answer: bill(), expenseSearch: 'window' });
  assert.deepEqual(Object.keys(queriesOf(fallback)), [
    'find-vendor',
    'find-duplicate-number',
    'find-duplicate-amount',
    'find-related',
  ]);
  assert.equal(
    queriesOf(fallback)['find-related'],
    "SELECT * FROM Purchase WHERE DocNumber = 'HOS-1042' MAXRESULTS 3",
  );
  assert.equal(
    fallback.result.outcome,
    'success',
    'decided straight through, not "state incomplete"',
  );
  // An expense for the bill's total near its dates is then not seen; under D21 it holds.
  const company = (sim: Parameters<NonNullable<Parameters<typeof routeRun>[0]['company']>>[0]) =>
    sim.company.purchases.push(
      samplePurchase('203', REF.visa, { TxnDate: '2026-09-20', TotalAmt: 413.34 }),
    );
  assert.equal(
    (await routeRun({ answer: bill(), expenseSearch: 'window', company })).result.outcome,
    'success',
  );
  const primary = await routeRun({ answer: bill(), company });
  assert.ok(primary.result.outcome === 'held');
  assert.deepEqual((primary.result.held.state as JsonObject).holdReasons, ['possible_duplicate']);
});

test('a purchase someone paid personally: a company charge for the amount in the window holds 7, under either answer', async () => {
  for (const how of BOTH) {
    const world = await routeRun({
      answer: receipt(),
      ...PAID.employee,
      expenseSearch: how,
      company: (sim) =>
        sim.company.purchases.push(
          samplePurchase('204', REF.visa, { TxnDate: '2026-09-28', TotalAmt: 60.63 }),
        ),
    });
    assert.ok(world.result.outcome === 'held', how);
    assert.equal(
      world.result.held.reason,
      'Paid personally; a company card or bank charge matches: Robin Example paid Tidewell Hardware, $60.63',
      how,
    );
  }
});

test('if Intuit does not search an expense by amount, as its model file reads, D21 is refused — what sandbox S4 settles', async () => {
  const world = await routeRun({
    answer: receipt(),
    company: (sim) => {
      sim.expenseAmountSearchable = false;
    },
  });
  assert.deepEqual(world.result, {
    outcome: 'failed',
    failureReason: LOOKUP_SENTENCES.amount_refused,
  });
  assert.deepEqual(lines(world.platform).at(-1), [
    'find-duplicate-amount',
    'failed',
    'Amount not searched (qb_error 4000)',
  ]);
  // The fallback asks only what Intuit marks searchable.
  const fallback = await routeRun({
    answer: receipt(),
    expenseSearch: 'window',
    company: (sim) => {
      sim.expenseAmountSearchable = false;
    },
  });
  assert.equal(fallback.result.outcome, 'success');
});
