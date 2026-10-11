import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAXIMUM_NAME_LENGTH, cleanText } from '@autom8x/automation-kit/values';

import { MAXIMUM_OWNERS, readOwners } from '../src/owners.js';

/** The reading of "Owners and partners", and the cleaning a name gets before it is compared. */

test('a name is cleaned: NFC, plain quotes and dashes, no invisible characters, one space, trimmed', () => {
  assert.equal(cleanText('  Jo \u2019Brien\u2013Smith '), "Jo 'Brien-Smith");
  assert.equal(cleanText('\u201cAce\u201d\u00a0Co\n\tLtd'), '"Ace" Co Ltd');
  assert.equal(cleanText('Pa\u200bt\u00ad Owner\ufeff'), 'Pat Owner');
  assert.equal(cleanText('Re\u0301ne'), 'R\u00e9ne', 'composed (NFC)');
  assert.equal(cleanText('a\u0000\u0007b'), 'a b');
  assert.equal(cleanText('Pat \u2212 Owner'), 'Pat - Owner');
  for (const empty of ['', '   ', '\u200b\u200c', 7, null, undefined, ['Pat']]) {
    assert.equal(cleanText(empty), null, String(empty));
  }
  assert.equal(MAXIMUM_NAME_LENGTH, 500);
});

test('one entry per person, an "=" giving their own account; an empty setting is no owners', () => {
  assert.deepEqual(readOwners('Jane Doe = Partner investments : Jane; Sam Lee;'), [
    { name: 'Jane Doe', accountName: 'Partner investments:Jane' },
    { name: 'Sam Lee', accountName: null },
  ]);
  assert.deepEqual(readOwners('  Pat\u2019s  Shop  '), [{ name: "Pat's Shop", accountName: null }]);
  assert.deepEqual(readOwners('A = Equity = Odd'), [{ name: 'A', accountName: 'Equity = Odd' }]);
  for (const empty of [undefined, null, '', '   ', 3]) assert.deepEqual(readOwners(empty), []);
  assert.deepEqual(readOwners(';;Pat;;'), [{ name: 'Pat', accountName: null }]);
});

test('a setting that cannot be read: no name, too long a name, an empty or impossible account, a person twice, too many people', () => {
  for (const value of [
    '= Partner investments',
    'Jane Doe =',
    'Jane Doe =   ',
    'Jane Doe = Equity::Jane',
    'Jane = :Equity',
    `${'A'.repeat(501)}`,
    'Jane Doe; jane  doe',
    'Jane Doe = X; JANE DOE',
    Array.from({ length: 21 }, (_, index) => `Owner ${index}`).join('; '),
  ]) {
    assert.equal(readOwners(value), undefined, value.slice(0, 40));
  }
  assert.equal(MAXIMUM_OWNERS, 20);
  assert.equal(
    readOwners(Array.from({ length: 20 }, (_, index) => `Owner ${index}`).join('; '))?.length,
    20,
  );
  assert.equal(readOwners('A'.repeat(500))?.length, 1);
  assert.equal(readOwners(`Jane = ${'B'.repeat(1_001)}`), undefined);
});
