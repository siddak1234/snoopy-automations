import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lookupQuery, quoteQueryValue } from '../src/quickbooks/query.js';

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
