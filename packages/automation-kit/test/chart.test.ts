import assert from 'node:assert/strict';
import { test } from 'node:test';

import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { CHART_ACCOUNT_TYPES, chartQuery, queryRowsOf } from '../src/quickbooks/index.js';
import { QuickBooksSimulator, sampleAccount } from '../src/testing/index.js';
import { KEY } from './fixtures.js';

/**
 * The chart read (Invoice Processing v2, the platform's BUILD-PLAN 25.4.19): ONE query for every
 * active account a purchase is recorded to or paid from, its text exactly the spec's, and the
 * simulator answering it as Intuit would — sandbox read S13 confirms IN on `AccountType`.
 */

test("the chart read is one query, in exactly the spec's words", () => {
  assert.equal(
    chartQuery(),
    "SELECT * FROM Account WHERE AccountType IN ('Bank', 'Credit Card', 'Expense', 'Other Expense', 'Cost of Goods Sold') AND Active = true MAXRESULTS 1000",
  );
  assert.deepEqual(
    [...CHART_ACCOUNT_TYPES],
    ['Bank', 'Credit Card', 'Expense', 'Other Expense', 'Cost of Goods Sold'],
  );
});

test("the simulator answers it with the company's active accounts of those types, and no other", async () => {
  const simulator = new QuickBooksSimulator({ refusal: refusalFixture });
  simulator.company.accounts.push(
    sampleAccount('700', 'Old Card', 'Credit Card', { Active: false }),
    sampleAccount('701', 'Other Costs', 'Other Expense'),
  );
  const answer = await simulator.provider({
    providerId: 'quickbooks',
    operation: 'query.run',
    input: { query: chartQuery() },
    idempotencyKey: KEY,
  });
  assert.equal(answer.status, 200);
  const rows = queryRowsOf(answer.body, 'Account') ?? [];
  const names = rows.map((row) => row.FullyQualifiedName);
  assert.ok(names.includes('Uncategorized Expense'));
  assert.ok(names.includes('Other Costs'), 'Other Expense is read');
  assert.ok(names.includes('Visa 4417') && names.includes('Savings'));
  assert.ok(!names.includes('Old Card'), 'an inactive account is not');
  for (const left of ['Accounts Payable (A/P)', 'Owed to Team Members', 'Owner investments']) {
    assert.ok(!names.includes(left), `${left} is not a type the read asks for`);
  }
  assert.ok(rows.every((row) => row.Active !== false));
});
