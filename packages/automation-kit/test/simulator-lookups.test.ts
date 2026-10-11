import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, ProviderRequest } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import {
  dateRange,
  lookupLikeQuery,
  lookupQuery,
  transactionQuery,
} from '../src/quickbooks/query.js';
import {
  sampleBill,
  sampleCustomer,
  sampleJournalEntry,
  samplePurchase,
  sampleVendor,
} from '../src/testing/quickbooks-company.js';
import { QuickBooksSimulator } from '../src/testing/quickbooks-simulator.js';

/**
 * The records a vendor and duplicate lookup searches: vendors and customers by name, active or
 * not, and by a word in the name (LIKE); bills by number, several numbers, vendor, total, date
 * and balance, newest first — every filter Intuit's model file marks, OR refused — and the rows
 * returned capped by MAXRESULTS.
 */

let keys = 0;
function call(query: string): ProviderRequest {
  keys += 1;
  return {
    providerId: 'quickbooks',
    operation: 'query.run',
    input: { query },
    idempotencyKey: `lookups-${String(keys).padStart(4, '0')}-${'c'.repeat(40)}`,
  };
}

function simulator() {
  const sim = new QuickBooksSimulator({ refusal: refusalFixture });
  const acme = { value: '56', name: 'Acme Supplies' };
  const other = { value: '77', name: 'Pacific Gas' };
  sim.company.vendors.push(
    sampleVendor('56', 'Acme Supplies', { CompanyName: 'Acme Supplies, Inc.', Balance: 980 }),
    sampleVendor('57', "O'Brien & Sons"),
    sampleVendor('58', 'Acme Tools', { Active: false }),
    sampleVendor('77', 'Pacific Gas', { Vendor1099: true }),
  );
  sim.company.customers.push(sampleCustomer('3', 'Acme Supplies'));
  sim.company.bills.push(
    sampleBill('145', acme, { DocNumber: 'inv-1001', TxnDate: '2026-09-14', TotalAmt: 1250 }),
    sampleBill('146', acme, { DocNumber: 'INV-1002', TxnDate: '2026-09-20', TotalAmt: 80 }),
    sampleBill('147', acme, { DocNumber: 'INV-1003', TxnDate: '2026-09-02', Balance: 0 }),
    sampleBill('12', other, { DocNumber: 'INV-1001', TxnDate: '2026-08-30', TotalAmt: 1250 }),
  );
  return sim;
}

async function ids(sim: QuickBooksSimulator, query: string, entity: string): Promise<string[]> {
  const answer = await sim.provider(call(query));
  assert.equal(answer.status, 200, query);
  const body = answer.body as { QueryResponse: Record<string, JsonObject[] | undefined> };
  return (body.QueryResponse[entity] ?? []).map((row) => String(row.Id));
}

const bills = (where: Parameters<typeof transactionQuery>[0]['where'], maxResults = 3) =>
  transactionQuery({ entity: 'Bill', where, maxResults });

test('a vendor and a customer are found by display or company name without case, active or not', async () => {
  const sim = simulator();
  assert.deepEqual(
    await ids(sim, lookupQuery('Vendor', 'DisplayName', 'ACME SUPPLIES', 2), 'Vendor'),
    ['56'],
  );
  assert.deepEqual(
    await ids(sim, lookupQuery('Vendor', 'CompanyName', 'acme supplies, inc.', 2), 'Vendor'),
    ['56'],
  );
  // The apostrophe arrives escaped and is matched unescaped.
  assert.deepEqual(
    await ids(sim, lookupQuery('Vendor', 'DisplayName', "O'Brien & Sons", 2), 'Vendor'),
    ['57'],
  );
  assert.deepEqual(
    await ids(sim, lookupQuery('Vendor', 'DisplayName', 'Acme Tools', 2), 'Vendor'),
    ['58'],
    'an inactive vendor is found: the lookup asks for Active IN (true, false)',
  );
  assert.deepEqual(
    await ids(sim, lookupQuery('Customer', 'DisplayName', 'acme supplies', 1), 'Customer'),
    ['3'],
  );
  assert.deepEqual(
    await ids(sim, lookupQuery('Vendor', 'DisplayName', 'Acme', 2), 'Vendor'),
    [],
    'equality: no near name',
  );
});

test("LIKE '%word%' finds the word anywhere in the name, without case, inactive names included, capped", async () => {
  const sim = simulator();
  assert.deepEqual(await ids(sim, lookupLikeQuery('Vendor', 'DisplayName', 'acme', 3), 'Vendor'), [
    '56',
    '58',
  ]);
  assert.deepEqual(await ids(sim, lookupLikeQuery('Vendor', 'DisplayName', 'BRIEN', 3), 'Vendor'), [
    '57',
  ]);
  assert.deepEqual(await ids(sim, lookupLikeQuery('Vendor', 'DisplayName', 'acme', 1), 'Vendor'), [
    '56',
  ]);
  assert.deepEqual(await ids(sim, lookupLikeQuery('Vendor', 'DisplayName', 'zz', 3), 'Vendor'), []);
});

test('bills by number, several numbers, vendor, total, date and an open balance, newest first', async () => {
  const sim = simulator();
  const byNumber = [{ field: 'DocNumber', operator: '=', value: 'INV-1001' }] as const;
  assert.deepEqual(await ids(sim, bills([...byNumber]), 'Bill'), ['145', '12']);
  assert.deepEqual(
    await ids(
      sim,
      bills([...byNumber, { field: 'VendorRef', operator: '=', value: '56' }]),
      'Bill',
    ),
    ['145'],
  );
  assert.deepEqual(
    await ids(
      sim,
      bills(
        [
          { field: 'DocNumber', operator: 'IN', values: ['INV-1001', 'inv-1003', 'INV-9'] },
          { field: 'VendorRef', operator: '=', value: '56' },
        ],
        4,
      ),
      'Bill',
    ),
    ['145', '147'],
  );
  assert.deepEqual(
    await ids(
      sim,
      bills([
        { field: 'TotalAmt', operator: '=', value: '1250.00' },
        { field: 'TxnDate', operator: '=', value: '2026-09-14' },
        { field: 'VendorRef', operator: '=', value: '56' },
      ]),
      'Bill',
    ),
    ['145'],
    "'1250.00' matches a stored 1250",
  );
  assert.deepEqual(
    await ids(
      sim,
      bills(
        [
          { field: 'Balance', operator: '>', value: '0.00' },
          { field: 'VendorRef', operator: '=', value: '56' },
        ],
        40,
      ),
      'Bill',
    ),
    ['145', '146'],
    'a paid bill (Balance 0) is not open',
  );
  const newest = transactionQuery({
    entity: 'Bill',
    where: [{ field: 'TotalAmt', operator: '=', value: '1250.00' }],
    orderBy: { field: 'TxnDate', descending: true },
    maxResults: 1,
  });
  assert.deepEqual(await ids(sim, newest, 'Bill'), ['145'], 'newest first, then capped');
});

test('expenses and journal entries by a date window, newest first; an expense by amount only with S4 on', async () => {
  const sim = simulator();
  const visa = { value: '41', name: 'Company Visa' };
  sim.company.purchases.push(
    samplePurchase('201', visa, { TxnDate: '2026-09-26', TotalAmt: 60.63 }),
    samplePurchase('202', visa, { TxnDate: '2026-10-17', TotalAmt: 60.63, Credit: true }),
    samplePurchase('203', visa, { TxnDate: '2026-10-18', TotalAmt: 60.63 }),
  );
  sim.company.journalEntries.push(
    sampleJournalEntry('401', 60.63, {
      debit: { value: '57', name: 'Utilities:Electric' },
      credit: { value: '120', name: 'Owed to Team Members' },
    }),
  );
  const window = transactionQuery({
    entity: 'Purchase',
    where: dateRange('TxnDate', '2026-09-26', '2026-10-17'),
    orderBy: { field: 'TxnDate', descending: true },
    maxResults: 50,
  });
  assert.deepEqual(await ids(sim, window, 'Purchase'), ['202', '201']);
  const byAmount = transactionQuery({
    entity: 'Purchase',
    where: [
      { field: 'TotalAmt', operator: '=', value: '60.63' },
      ...dateRange('TxnDate', '2026-09-26', '2026-10-17'),
    ],
    maxResults: 3,
  });
  const refused = await sim.provider(call(byAmount));
  assert.equal(refused.status, 400, 'S4 off: TotalAmt is not marked filterable on Purchase');
  sim.expenseAmountSearchable = true;
  assert.deepEqual(await ids(sim, byAmount, 'Purchase'), ['201', '202']);
  const entries = transactionQuery({
    entity: 'JournalEntry',
    where: [{ field: 'TxnDate', operator: '=', value: '2026-10-10' }],
    maxResults: 10,
  });
  assert.deepEqual(await ids(sim, entries, 'JournalEntry'), ['401']);
});

test('what QuickBooks refuses is a parser Fault: OR, LIKE on a transaction, an unmarked field or order', async () => {
  const sim = simulator();
  const refused = async (query: string) => {
    const answer = await sim.provider(call(query));
    assert.equal(answer.status, 400, query);
    assert.match(JSON.stringify(answer.body), /"code":"4000"/u);
  };
  await refused(
    "SELECT * FROM Bill WHERE DocNumber = 'INV-1001' OR DocNumber = 'INV-1002' MAXRESULTS 3",
  );
  await refused(
    "SELECT * FROM Vendor WHERE DisplayName = 'Acme' OR CompanyName = 'Acme' AND Active IN (true, false) MAXRESULTS 2",
  );
  await refused("SELECT * FROM Bill WHERE DocNumber LIKE '%1001%' MAXRESULTS 3");
  // A word with anything but letters and digits is no builder's: refused.
  await refused(
    "SELECT * FROM Vendor WHERE DisplayName LIKE '%ac me%' AND Active IN (true, false) MAXRESULTS 3",
  );
  await refused(
    "SELECT * FROM Vendor WHERE DisplayName LIKE 'acme%' AND Active IN (true, false) MAXRESULTS 3",
  );
  await refused(lookupQuery('Vendor', 'Notes', 'x', 2));
  await refused(bills([{ field: 'PrivateNote', operator: '=', value: 'x' }]));
  await refused(
    transactionQuery({
      entity: 'Bill',
      where: [{ field: 'DocNumber', operator: '=', value: 'A' }],
      orderBy: { field: 'Balance' },
      maxResults: 3,
    }),
  );
  // A vendor lookup without Active IN (true, false) is no builder's either.
  await refused("SELECT * FROM Vendor WHERE DisplayName = 'Acme Supplies' MAXRESULTS 2");
});

test('a bill search whose answer is over 192 KiB reaches the automation as a 502 naming no reason', async () => {
  const sim = simulator();
  const acme = { value: '56', name: 'Acme Supplies' };
  for (let index = 0; index < 60; index += 1) {
    sim.company.bills.push(
      sampleBill(String(1_000 + index), acme, {
        TxnDate: '2026-09-30',
        PrivateNote: 'x'.repeat(4_000),
      }),
    );
  }
  const query = bills(
    [
      { field: 'Balance', operator: '>', value: '0.00' },
      { field: 'VendorRef', operator: '=', value: '56' },
    ],
    60,
  );
  await assert.rejects(sim.provider(call(query)), { status: 502, reason: undefined });
});
