import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TRANSACTION_ENTITIES,
  dateRange,
  lookupInQuery,
  lookupLikeQuery,
  lookupQuery,
  quoteQueryValue,
  transactionQuery,
} from '../src/quickbooks/query.js';

test('a value is quoted with each backslash doubled first, then each apostrophe escaped', () => {
  assert.equal(quoteQueryValue('Utilities:Electric'), "'Utilities:Electric'");
  assert.equal(quoteQueryValue("O'Brien's Fees"), "'O\\'Brien\\'s Fees'");
  assert.equal(quoteQueryValue('C:\\Temp'), "'C:\\\\Temp'");
  // A trailing backslash would otherwise escape the closing apostrophe and run on.
  assert.equal(quoteQueryValue('Fees\\'), "'Fees\\\\'");
  // Backslash before an apostrophe: the backslash doubled, then the apostrophe escaped.
  assert.equal(quoteQueryValue("a\\'b"), "'a\\\\\\'b'");
  assert.equal(quoteQueryValue(''), "''");
});

test('nothing else in a value changes: double quotes, &, #, %, and a curly apostrophe', () => {
  for (const value of ['Say "hi"', 'Repairs & Maintenance', 'Line #2', '100% Juice', 'O’Brien']) {
    assert.equal(quoteQueryValue(value), `'${value}'`);
  }
});

test('a lookup is every record, active or not, by one field, at most MAXRESULTS', () => {
  assert.equal(
    lookupQuery('Account', 'FullyQualifiedName', 'Utilities:Electric', 2),
    "SELECT * FROM Account WHERE FullyQualifiedName = 'Utilities:Electric' AND Active IN (true, false) MAXRESULTS 2",
  );
});

test("the platform's URL encoding carries the escaped value whole", () => {
  // Connections puts `query` in the URL with URLSearchParams: spaces become `+`, and
  // every character a name can hold is percent-encoded, as Intuit's own example is.
  const query = lookupQuery(
    'Account',
    'FullyQualifiedName',
    "Repairs & Maintenance:O'Brien's Fees",
    2,
  );
  assert.equal(
    new URLSearchParams({ query }).toString(),
    'query=SELECT+*+FROM+Account+WHERE+FullyQualifiedName+%3D+%27Repairs+%26+Maintenance%3AO%5C%27Brien%5C%27s+Fees%27+AND+Active+IN+%28true%2C+false%29+MAXRESULTS+2',
  );
});

test('an entity, a field or a bound outside Intuit’s shapes is refused before any text is built', () => {
  assert.throws(
    () => lookupQuery('account', 'FullyQualifiedName', 'x', 2),
    /not a QuickBooks entity/u,
  );
  assert.throws(() => lookupQuery('Account WHERE 1', 'Name', 'x', 2), /not a QuickBooks entity/u);
  assert.throws(() => lookupQuery('Account', "Name = 'x' OR", 'x', 2), /not a QuickBooks field/u);
  assert.throws(
    () => lookupQuery('Account', 'MetaData.CreateTime', 'x', 2),
    /not a QuickBooks field/u,
  );
  for (const bound of [0, -1, 1.5, 1_001, Number.NaN]) {
    assert.throws(() => lookupQuery('Account', 'Name', 'x', bound), /MAXRESULTS/u);
  }
  assert.ok(lookupQuery('Account', 'Name', 'x', 1_000).endsWith('MAXRESULTS 1000'));
});

test('a lookup by several names is one IN query, every value quoted, active or not', () => {
  assert.equal(
    lookupInQuery('Account', 'FullyQualifiedName', ['Utilities:Electric', "O'Brien's \\ Fees"], 4),
    "SELECT * FROM Account WHERE FullyQualifiedName IN ('Utilities:Electric', 'O\\'Brien\\'s \\\\ Fees') AND Active IN (true, false) MAXRESULTS 4",
  );
  assert.equal(
    lookupInQuery('Employee', 'DisplayName', ['Robin Example'], 2),
    "SELECT * FROM Employee WHERE DisplayName IN ('Robin Example') AND Active IN (true, false) MAXRESULTS 2",
  );
});

test('an IN list must name at least one value, and no value twice in any case', () => {
  assert.throws(() => lookupInQuery('Account', 'Name', [], 2), /at least one value/u);
  assert.throws(() => lookupInQuery('Account', 'Name', ['Meals', 'MEALS'], 4), /twice/u);
  assert.throws(() => lookupInQuery('account', 'Name', ['x'], 2), /not a QuickBooks entity/u);
  assert.throws(() => lookupInQuery('Account', 'Name)', ['x'], 2), /not a QuickBooks field/u);
  assert.throws(() => lookupInQuery('Account', 'Name', ['x'], 0), /MAXRESULTS/u);
});

test('a transaction search joins its conditions by AND, quotes every value, orders and bounds, and never asks for Active', () => {
  assert.equal(
    transactionQuery({
      entity: 'Purchase',
      where: dateRange('TxnDate', '2026-09-13', '2026-10-04'),
      orderBy: { field: 'TxnDate', descending: true },
      maxResults: 50,
    }),
    "SELECT * FROM Purchase WHERE TxnDate >= '2026-09-13' AND TxnDate <= '2026-10-04' ORDERBY TxnDate DESC MAXRESULTS 50",
  );
  assert.equal(
    transactionQuery({
      entity: 'Bill',
      where: [
        { field: 'VendorRef', operator: '=', value: '56' },
        { field: 'DocNumber', operator: 'IN', values: ["INV-1'01", 'INV-1002'] },
        { field: 'TotalAmt', operator: '>', value: '0' },
      ],
      orderBy: { field: 'TxnDate' },
      maxResults: 40,
    }),
    "SELECT * FROM Bill WHERE VendorRef = '56' AND DocNumber IN ('INV-1\\'01', 'INV-1002') AND TotalAmt > '0' ORDERBY TxnDate MAXRESULTS 40",
  );
  // A compared value is quoted as a lookup's is: each backslash doubled, then each apostrophe escaped.
  assert.equal(
    transactionQuery({
      entity: 'VendorCredit',
      where: [{ field: 'DocNumber', operator: '=', value: "O'B-7\\" }],
      maxResults: 3,
    }),
    "SELECT * FROM VendorCredit WHERE DocNumber = 'O\\'B-7\\\\' MAXRESULTS 3",
  );
  for (const operator of ['=', '<', '>', '<=', '>='] as const) {
    assert.equal(
      transactionQuery({
        entity: 'VendorCredit',
        where: [{ field: 'TotalAmt', operator, value: '120.00' }],
        maxResults: 3,
      }),
      `SELECT * FROM VendorCredit WHERE TotalAmt ${operator} '120.00' MAXRESULTS 3`,
    );
  }
  assert.deepEqual(TRANSACTION_ENTITIES, ['Bill', 'Purchase', 'VendorCredit', 'JournalEntry']);
  for (const entity of TRANSACTION_ENTITIES) {
    const text = transactionQuery({
      entity,
      where: [{ field: 'DocNumber', operator: '=', value: 'A-1' }],
      maxResults: 3,
    });
    assert.ok(!text.includes('Active'), text);
  }
});

test('a search of a name list, with no condition, or with a name, operator, bound or order outside Intuit’s shapes is refused', () => {
  const one = [{ field: 'DocNumber', operator: '=', value: 'A-1' }] as const;
  for (const entity of ['Account', 'Vendor', 'Employee', 'purchase']) {
    assert.throws(
      () => transactionQuery({ entity: entity as 'Bill', where: one, maxResults: 3 }),
      /not a transaction/u,
    );
  }
  assert.throws(
    () => transactionQuery({ entity: 'Bill', where: [], maxResults: 3 }),
    /needs a condition/u,
  );
  assert.throws(
    () =>
      transactionQuery({
        entity: 'Bill',
        where: [{ field: "DocNumber = 'x' OR", operator: '=', value: 'A' }],
        maxResults: 3,
      }),
    /not a QuickBooks field/u,
  );
  assert.throws(
    () =>
      transactionQuery({
        entity: 'Bill',
        where: [{ field: 'DocNumber', operator: 'LIKE' as '=', value: '%A%' }],
        maxResults: 3,
      }),
    /not a QuickBooks operator/u,
  );
  assert.throws(
    () =>
      transactionQuery({
        entity: 'Bill',
        where: [{ field: 'DocNumber', operator: 'IN', values: [] }],
        maxResults: 3,
      }),
    /at least one value/u,
  );
  assert.throws(
    () => transactionQuery({ entity: 'Bill', where: one, maxResults: 1_001 }),
    /MAXRESULTS/u,
  );
  assert.throws(
    () =>
      transactionQuery({
        entity: 'Bill',
        where: one,
        orderBy: { field: 'MetaData.CreateTime' },
        maxResults: 3,
      }),
    /not a QuickBooks field/u,
  );
});

test('a date range is two real days, the first not after the second', () => {
  assert.deepEqual(dateRange('TxnDate', '2026-02-28', '2026-02-28'), [
    { field: 'TxnDate', operator: '>=', value: '2026-02-28' },
    { field: 'TxnDate', operator: '<=', value: '2026-02-28' },
  ]);
  for (const [from, to] of [
    ['2026-02-30', '2026-03-01'],
    ['2026-01-01', '2026-13-01'],
    ['01/02/2026', '2026-01-03'],
    ['2026-1-02', '2026-01-03'],
  ]) {
    assert.throws(() => dateRange('TxnDate', from ?? '', to ?? ''), /two YYYY-MM-DD days/u);
  }
  assert.throws(() => dateRange('TxnDate', '2026-10-02', '2026-10-01'), /must not end before/u);
});

test('a LIKE lookup searches one word inside a name, active or not, the word letters and digits alone', () => {
  assert.equal(
    lookupLikeQuery('Vendor', 'DisplayName', 'acme', 3),
    "SELECT * FROM Vendor WHERE DisplayName LIKE '%acme%' AND Active IN (true, false) MAXRESULTS 3",
  );
  assert.equal(
    lookupLikeQuery('Vendor', 'DisplayName', 'société', 3),
    "SELECT * FROM Vendor WHERE DisplayName LIKE '%société%' AND Active IN (true, false) MAXRESULTS 3",
  );
  assert.ok(lookupLikeQuery('Vendor', 'DisplayName', '3m', 3).includes("LIKE '%3m%'"));
  // A wildcard, a quote, a backslash or a space would change what is searched: refused.
  for (const word of ['', 'ac%me', "o'brien", 'a\\b', 'two words', 'acme_']) {
    assert.throws(() => lookupLikeQuery('Vendor', 'DisplayName', word, 3), /one word/u, word);
  }
  assert.throws(() => lookupLikeQuery('vendor', 'DisplayName', 'acme', 3), /entity/u);
  assert.throws(() => lookupLikeQuery('Vendor', 'Display Name', 'acme', 3), /field/u);
  assert.throws(() => lookupLikeQuery('Vendor', 'DisplayName', 'acme', 0), /MAXRESULTS/u);
});
