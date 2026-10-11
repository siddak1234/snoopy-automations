import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAXIMUM_NAME_LENGTH,
  MAXIMUM_NUMBER_LENGTH,
  QUICKBOOKS_NUMBER_LENGTH,
  cleanText,
  sameName,
  shorten,
} from '../src/values/text.js';

test('a name printed over two lines, with a no-break space, is one line of single spaces', () => {
  assert.equal(cleanText('Acme\n  Supplies Inc'), 'Acme Supplies Inc');
  assert.equal(cleanText('\tAcme\r\n Supplies  '), 'Acme Supplies');
});

test('curly quotes and dashes become plain; zero-width and bidirectional characters are removed', () => {
  assert.equal(cleanText('O’Brien “Electric” – Repairs'), 'O\'Brien "Electric" - Repairs');
  assert.equal(cleanText('Ac​me­ Sup‮plies﻿'), 'Acme Supplies');
  assert.equal(cleanText('− 12′'), "- 12'");
});

test('NFC: a decomposed accent is one character; case, punctuation, # and leading zeros stay', () => {
  assert.equal(cleanText('Café Ltd'), 'Café Ltd');
  assert.equal(cleanText(' INV #0042-a '), 'INV #0042-a');
});

test('nothing left, or no text at all, is null', () => {
  for (const value of ['   ', '​', '', null, undefined, 42, {}, ['Acme']]) {
    assert.equal(cleanText(value), null, JSON.stringify(value));
  }
});

test('two names are one when, cleaned, they differ only in case; nothing is never a name', () => {
  assert.ok(sameName('Sample Bakery', 'SAMPLE  bakery'));
  assert.ok(sameName('O’Brien', "o'brien"));
  assert.ok(!sameName('Sample Bakery', 'Sample Bakery LLC'));
  assert.ok(!sameName(null, null));
  assert.ok(!sameName('  ', '  '));
});

test("a name shortened to fit ends with '…', never splitting a character", () => {
  assert.equal(shorten('Acme Supplies', 13), 'Acme Supplies');
  assert.equal(shorten('Acme Supplies', 12), 'Acme Suppli…');
  assert.equal(shorten('Acme Supplies', 6), 'Acme…', 'a space before the cut is dropped');
  assert.equal(shorten('Acme', 1), '…');
  assert.equal(shorten('Acme', 0), '');
  // An astral character is two UTF-16 units: never cut in half.
  const astral = '\u{1F600}'.repeat(5);
  const cut = shorten(astral, 6);
  assert.ok(cut.length <= 6);
  assert.equal(cut, `${'\u{1F600}'.repeat(2)}…`);
  assert.ok(!/[\ud800-\udbff]$/u.test(cut.slice(0, -1)));
});

test("QuickBooks' bounds: a name of 500, a document number of 100 read cleanly, 21 sent as its number", () => {
  assert.deepEqual(
    [MAXIMUM_NAME_LENGTH, MAXIMUM_NUMBER_LENGTH, QUICKBOOKS_NUMBER_LENGTH],
    [500, 100, 21],
  );
});
