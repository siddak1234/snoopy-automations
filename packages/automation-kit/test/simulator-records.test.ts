import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, ProviderRequest } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import {
  dateRange,
  lookupInQuery,
  lookupQuery,
  transactionQuery,
} from '../src/quickbooks/query.js';
import { sampleAccount, sampleEmployee, sampleVendor } from '../src/testing/quickbooks-company.js';
import { QuickBooksSimulator } from '../src/testing/quickbooks-simulator.js';

/**
 * The simulator's records: employees and accounts found by the kit's lookups; expenses,
 * vendor credits and journal entries created by Intuit's documented rules and found by the
 * kit's searches — filterable fields only, the answer bound — and nothing else answered.
 */

let keys = 0;
function call(operation: string, input: JsonObject): ProviderRequest {
  keys += 1;
  return {
    providerId: 'quickbooks',
    operation,
    input,
    idempotencyKey: `records-${String(keys).padStart(4, '0')}-${'a'.repeat(40)}`,
  };
}

function simulator() {
  return new QuickBooksSimulator({ refusal: refusalFixture });
}

async function rows(sim: QuickBooksSimulator, query: string, entity: string) {
  const answer = await sim.provider(call('query.run', { query }));
  assert.equal(answer.status, 200, query);
  const body = answer.body as { QueryResponse: Record<string, JsonObject[] | undefined> };
  return body.QueryResponse[entity] ?? [];
}

async function faultOf(sim: QuickBooksSimulator, operation: string, input: JsonObject) {
  const answer = await sim.provider(call(operation, input));
  const body = answer.body as { Fault?: { Error: { code: string }[] } };
  return [answer.status, body.Fault?.Error[0]?.code];
}

const expenseLine = (amount: number, account = '64') => ({
  DetailType: 'AccountBasedExpenseLineDetail',
  Amount: amount,
  AccountBasedExpenseLineDetail: { AccountRef: { value: account } },
});
const journalLine = (amount: number, posting: string, account: string) => ({
  DetailType: 'JournalEntryLineDetail',
  Amount: amount,
  JournalEntryLineDetail: { PostingType: posting, AccountRef: { value: account } },
});

test('an employee is found by display name without case, active or not; an account by several names in one IN query', async () => {
  const sim = simulator();
  sim.company.employees.push(sampleEmployee('57', 'Casey Sample', { Active: false }));
  const found = await rows(
    sim,
    lookupQuery('Employee', 'DisplayName', 'robin EXAMPLE', 2),
    'Employee',
  );
  assert.deepEqual(
    found.map((row) => row.Id),
    ['55'],
  );
  const inactive = await rows(
    sim,
    lookupQuery('Employee', 'DisplayName', 'Casey Sample', 2),
    'Employee',
  );
  assert.equal(inactive[0]?.Active, false);
  const accounts = await rows(
    sim,
    lookupInQuery(
      'Account',
      'FullyQualifiedName',
      ['utilities:electric', 'Company Visa', 'Nope'],
      6,
    ),
    'Account',
  );
  assert.deepEqual(
    accounts.map((row) => row.Id),
    ['57', '41'],
  );
  // MAXRESULTS is the most rows returned.
  sim.company.accounts.push(sampleAccount('58', 'UTILITIES:ELECTRIC', 'Expense'));
  const bounded = await rows(
    sim,
    lookupInQuery('Account', 'FullyQualifiedName', ['Utilities:Electric', 'Checking'], 2),
    'Account',
  );
  assert.equal(bounded.length, 2);
});

test('a search finds created expenses, vendor credits and journal entries by their filterable fields, ordered and bounded', async () => {
  const sim = simulator();
  for (const [date, number, amount] of [
    ['2026-09-10', 'R-1', 12.5],
    ['2026-09-20', 'R-2', 45.2],
    ['2026-10-02', 'R-3', 45.2],
  ] as const) {
    const created = await sim.provider(
      call('purchase.create', {
        PaymentType: 'CreditCard',
        AccountRef: { value: '41' },
        TxnDate: date,
        DocNumber: number,
        Line: [expenseLine(amount)],
      }),
    );
    assert.equal(created.status, 200);
  }
  const window = await rows(
    sim,
    transactionQuery({
      entity: 'Purchase',
      where: dateRange('TxnDate', '2026-09-19', '2026-10-09'),
      orderBy: { field: 'TxnDate', descending: true },
      maxResults: 50,
    }),
    'Purchase',
  );
  assert.deepEqual(
    window.map((row) => [row.DocNumber, row.TotalAmt]),
    [
      ['R-3', 45.2],
      ['R-2', 45.2],
    ],
  );
  const byNumber = await rows(
    sim,
    transactionQuery({
      entity: 'Purchase',
      where: [{ field: 'DocNumber', operator: 'IN', values: ['r-1', 'R-3'] }],
      maxResults: 1,
    }),
    'Purchase',
  );
  assert.deepEqual(
    byNumber.map((row) => row.DocNumber),
    ['R-1'],
  );
  sim.company.vendors.push(sampleVendor('9', 'Tidewell Hardware'));
  await sim.provider(
    call('vendorCredit.create', {
      VendorRef: { value: '9' },
      DocNumber: 'CM-77',
      TxnDate: '2026-09-30',
      Line: [expenseLine(80), expenseLine(40)],
    }),
  );
  const credits = await rows(
    sim,
    transactionQuery({
      entity: 'VendorCredit',
      where: [{ field: 'TotalAmt', operator: '=', value: '120.00' }],
      maxResults: 3,
    }),
    'VendorCredit',
  );
  assert.deepEqual(
    credits.map((row) => [row.DocNumber, row.TotalAmt, row.Balance]),
    [['CM-77', 120, 120]],
  );
  await sim.provider(
    call('journalEntry.create', {
      TxnDate: '2026-09-30',
      Line: [journalLine(45.2, 'Debit', '64'), journalLine(45.2, 'Credit', '120')],
    }),
  );
  const entries = await rows(
    sim,
    transactionQuery({
      entity: 'JournalEntry',
      where: [{ field: 'TxnDate', operator: '=', value: '2026-09-30' }],
      maxResults: 3,
    }),
    'JournalEntry',
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.TotalAmt, 0, "a journal entry's TotalAmt is always 0");
});

test('a field Intuit does not mark filterable, an order on one it does not mark sortable, or Active on a transaction is a parser Fault', async () => {
  const sim = simulator();
  const refused = async (query: string) => {
    const answer = await sim.provider(call('query.run', { query }));
    assert.equal(answer.status, 400, query);
    assert.match(JSON.stringify(answer.body), /"code":"4000"/u);
  };
  // Sandbox S4: an expense's amount, refused until the switch says otherwise.
  const byAmount = transactionQuery({
    entity: 'Purchase',
    where: [{ field: 'TotalAmt', operator: '=', value: '45.20' }],
    maxResults: 50,
  });
  await refused(byAmount);
  await refused(
    transactionQuery({
      entity: 'JournalEntry',
      where: [{ field: 'TotalAmt', operator: '=', value: '45.20' }],
      maxResults: 3,
    }),
  );
  await refused(
    transactionQuery({
      entity: 'VendorCredit',
      where: [{ field: 'VendorRef', operator: '=', value: '9' }],
      maxResults: 3,
    }),
  );
  await refused(
    transactionQuery({
      entity: 'Purchase',
      where: [{ field: 'DocNumber', operator: '=', value: 'R-1' }],
      orderBy: { field: 'TotalAmt' },
      maxResults: 3,
    }),
  );
  await refused(
    "SELECT * FROM Purchase WHERE DocNumber = 'R-1' AND Active IN (true, false) MAXRESULTS 3",
  );
  await refused("SELECT * FROM Account WHERE FullyQualifiedName = 'Checking' MAXRESULTS 2");
  // An entity the simulator does not hold is a Fault too: a test that sends one should fail.
  await refused(lookupQuery('Item', 'Name', 'Widget', 2));
  await refused("SELECT * FROM Purchase WHERE TxnDate >= '2026-09-01' MAXRESULTS 3 ");
  await refused("select * from Purchase where DocNumber = 'R-1' MAXRESULTS 3");
  sim.expenseAmountSearchable = true;
  const answer = await sim.provider(call('query.run', { query: byAmount }));
  assert.equal(answer.status, 200, 'S4 switched on: the amount is searched');
});

test('a create follows the rules Intuit documents, and a refused one keeps nothing', async () => {
  const sim = simulator();
  const purchase = {
    PaymentType: 'Cash',
    AccountRef: { value: '35' },
    Line: [expenseLine(10)],
  };
  const { PaymentType: _type, ...noType } = purchase;
  for (const [name, operation, input, code] of [
    ['no payment type', 'purchase.create', noType, '2020'],
    ['no lines', 'purchase.create', { ...purchase, Line: [] }, '2020'],
    [
      'an unknown paying account',
      'purchase.create',
      { ...purchase, AccountRef: { value: '999' } },
      '2500',
    ],
    [
      'an unknown category',
      'purchase.create',
      { ...purchase, Line: [expenseLine(10, '999')] },
      '2500',
    ],
    ['a negative line', 'purchase.create', { ...purchase, Line: [expenseLine(-10)] }, '2290'],
    ['a credit without a vendor', 'vendorCredit.create', { Line: [expenseLine(10)] }, '2020'],
    ['a journal entry with no lines', 'journalEntry.create', { Line: [] }, '2250'],
    [
      'a line with no posting type',
      'journalEntry.create',
      { Line: [journalLine(5, 'Sideways', '64'), journalLine(5, 'Credit', '120')] },
      '2260',
    ],
    [
      'debits not equal to credits',
      'journalEntry.create',
      { Line: [journalLine(5, 'Debit', '64'), journalLine(4.99, 'Credit', '120')] },
      '2300',
    ],
  ] as const) {
    assert.deepEqual(await faultOf(sim, operation, input as JsonObject), [400, code], name);
  }
  assert.deepEqual(
    [sim.company.purchases, sim.company.vendorCredits, sim.company.journalEntries],
    [[], [], []],
  );
  const made = await sim.provider(call('purchase.create', purchase));
  const record = (made.body as { Purchase: JsonObject }).Purchase;
  assert.deepEqual(
    [record.Id, record.TxnDate, record.TotalAmt, record.CurrencyRef],
    ['1001', '2026-10-10', 10, { value: 'USD' }],
  );
  assert.equal(sim.company.purchases.length, 1);
});

test('a create replayed under its key makes no second record; another body under it is refused 409', async () => {
  const sim = simulator();
  const request = call('purchase.create', {
    PaymentType: 'Cash',
    AccountRef: { value: '35' },
    Line: [expenseLine(10)],
  });
  const first = await sim.provider(request);
  assert.deepEqual(await sim.provider(request), first);
  assert.equal(sim.company.purchases.length, 1);
  await assert.rejects(
    sim.provider({ ...request, input: { ...request.input, PrivateNote: 'other' } }),
    { status: 409, reason: 'idempotency_key_reused' },
  );
  assert.equal(sim.company.purchases.length, 1);
});

test('a search whose answer is over 192 KiB reaches the automation as a 502 naming no reason', async () => {
  const sim = simulator();
  for (let index = 0; index < 400; index += 1) {
    sim.company.purchases.push({
      Id: String(index + 1),
      TxnDate: '2026-09-30',
      DocNumber: `R-${index}`,
      TotalAmt: 1,
      PrivateNote: 'x'.repeat(600),
    });
  }
  const query = transactionQuery({
    entity: 'Purchase',
    where: [{ field: 'TxnDate', operator: '=', value: '2026-09-30' }],
    maxResults: 1_000,
  });
  await assert.rejects(sim.provider(call('query.run', { query })), {
    status: 502,
    reason: undefined,
  });
  const fewer = transactionQuery({
    entity: 'Purchase',
    where: [{ field: 'TxnDate', operator: '=', value: '2026-09-30' }],
    maxResults: 100,
  });
  assert.equal((await rows(sim, fewer, 'Purchase')).length, 100);
});
