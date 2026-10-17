import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chartQuery } from '@autom8x/automation-kit/quickbooks';
import { sampleAccount } from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';

import { UNCATEGORIZED_EXPENSE, chartOf, chartStateOf, type ChartState } from '../src/chart.js';
import { NONE, callsOf, lines, setUp } from './fixtures.js';

/**
 * `find-accounts` (v2): ONE query reads the company's accounts — no setting names one, so no setting
 * can fail a run (U6, U7; the owner's build-19 run failed on "Parent:Child" before any AI step) —
 * and keeps them, split by what each can be, for decide to pick from. Line (§3.E): `{n} accounts
 * read`.
 */

async function found(edit: (world: ReturnType<typeof setUp>) => void = () => undefined) {
  const world = setUp({ through: 'find-accounts' });
  edit(world);
  const result = await world.run();
  const line = lines(world.platform).find(([stepId]) => stepId === 'find-accounts');
  const chart = result.outcome === 'success' ? chartStateOf(result.output?.chart) : undefined;
  return { ...world, result, line, chart };
}

const ids = (accounts: readonly { id: string }[]) => accounts.map((account) => account.id);

test("one query, the spec's own text, under the step's one key; the line counts what QuickBooks answered", async () => {
  const { platform, request, line, chart } = await found();
  assert.deepEqual(callsOf(platform, request, 'find-accounts'), [
    { providerId: 'quickbooks', operation: 'query.run', input: { query: chartQuery() } },
  ]);
  assert.equal(
    chartQuery(),
    "SELECT * FROM Account WHERE AccountType IN ('Bank', 'Credit Card', 'Expense', 'Other Expense', 'Cost of Goods Sold') AND Active = true MAXRESULTS 1000",
  );
  assert.ok(chart);
  assert.deepEqual(line, ['find-accounts', 'ok', `${chart.read} accounts read`]);
});

test('the chart, split by role: categories, banks, cards, and Uncategorized Expense found by its name', async () => {
  const { chart } = await found();
  assert.ok(chart);
  assert.deepEqual(ids(chart.banks), ['35', '36']);
  assert.deepEqual(ids(chart.cards), ['41', '42']);
  assert.ok(ids(chart.categories).includes('300') && ids(chart.categories).includes('80'));
  assert.deepEqual(chart.uncategorized, {
    id: '300',
    name: 'Uncategorized Expense',
    fullName: 'Uncategorized Expense',
    type: 'Expense',
    detailType: 'OtherMiscellaneousServiceCost',
  });
  // A sub-account keeps its own name and its full name.
  assert.deepEqual(
    chart.categories.find((account) => account.id === '57'),
    {
      id: '57',
      name: 'Electric',
      fullName: 'Utilities:Electric',
      type: 'Expense',
      detailType: 'Utilities',
    },
  );
});

test("no setting is read: whatever the flow's settings say — v1's account names, garbage, nothing — the chart is the same", async () => {
  const charts: (ChartState | undefined)[] = [];
  for (const config of [
    { vendor: 'quickbooks' },
    { vendor: 'quickbooks', expenseAccount: 'Parent:Child', paidFromAccount: 'Nope' },
    { vendor: 'quickbooks', companyCardLast4: '44 17', ownerNames: '=;=' },
  ]) {
    const world = setUp({ config, through: 'find-accounts' });
    const result = await world.run();
    assert.equal(result.outcome, 'success', JSON.stringify(config));
    charts.push(result.outcome === 'success' ? chartStateOf(result.output?.chart) : undefined);
  }
  assert.deepEqual(charts[1], charts[0]);
  assert.deepEqual(charts[2], charts[0]);
});

test('with the vendor "None" it never runs: no query, no line', async () => {
  const world = setUp({ config: NONE, through: 'find-accounts' });
  const result = await world.run();
  assert.equal(result.outcome, 'success');
  assert.deepEqual(world.platform.providerCalls, []);
  assert.ok(!lines(world.platform).some(([stepId]) => stepId === 'find-accounts'));
});

test('a company with no account of those types is an answer with none: nothing to pick, decided later', async () => {
  const { chart, line } = await found((world) => {
    world.simulator.company.accounts = [];
  });
  assert.deepEqual(chart, { categories: [], banks: [], cards: [], uncategorized: null, read: 0 });
  assert.deepEqual(line, ['find-accounts', 'ok', '0 accounts read']);
});

test('chartOf: inactive accounts and other types left out; with multicurrency on, USD accounts alone; a row missing its Id or type left out', () => {
  const rows: JsonObject[] = [
    sampleAccount('1', 'Checking', 'Bank'),
    sampleAccount('2', 'Old Bank', 'Bank', { Active: false }),
    sampleAccount('3', 'Euro Card', 'Credit Card', { CurrencyRef: { value: 'EUR' } }),
    sampleAccount('4', 'Freight', 'Other Expense'),
    sampleAccount('5', 'A/P', 'Accounts Payable'),
    { Id: '6', FullyQualifiedName: 'No Type' },
    { AccountType: 'Expense', FullyQualifiedName: 'No Id' },
    sampleAccount('7', '  uncategorized expense ', 'Expense'),
  ];
  const single = chartOf(rows, false);
  assert.deepEqual(ids(single.banks), ['1']);
  assert.deepEqual(ids(single.cards), ['3']);
  assert.deepEqual(ids(single.categories), ['4', '7']);
  assert.equal(single.uncategorized?.id, '7', 'its full name trimmed, in any capitals');
  assert.equal(single.read, rows.length);
  const multi = chartOf(rows, true);
  assert.deepEqual(ids(multi.cards), [], 'not USD');
  // Uncategorized Expense must be an Expense account.
  const cogs = chartOf([sampleAccount('8', UNCATEGORIZED_EXPENSE, 'Cost of Goods Sold')], false);
  assert.equal(cogs.uncategorized, null);
});

test('an answer that is no query answer keeps the document out of QuickBooks; the run goes on', async () => {
  const { result, line } = await found((world) => {
    world.simulator.script('query.run', [{ status: 200, body: { Account: [] } }]);
  });
  assert.ok(result.outcome === 'success');
  assert.deepEqual(result.output?.quickBooks, { notRecorded: "QuickBooks didn't answer" });
  assert.deepEqual(line, [
    'find-accounts',
    'failed',
    "Not recorded in QuickBooks: QuickBooks didn't answer",
  ]);
});

test('chartStateOf reads back only a chart as find-accounts keeps it', () => {
  const chart = chartOf([sampleAccount('1', 'Checking', 'Bank')], false);
  assert.deepEqual(chartStateOf(JSON.parse(JSON.stringify(chart))), chart);
  for (const broken of [
    undefined,
    {},
    { ...chart, banks: 'none' },
    { ...chart, cards: [{ id: '1' }] },
    { ...chart, uncategorized: 'x' },
    { ...chart, read: '1' },
  ]) {
    assert.equal(chartStateOf(broken), undefined, JSON.stringify(broken));
  }
});
