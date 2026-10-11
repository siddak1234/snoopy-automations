import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ISO_4217_LIST_ONE, cleanCurrency } from '../src/values/currency.js';

test('the list is ISO 4217 List One of 2026-09-17: 155 codes, sorted, each once, three capitals', () => {
  assert.equal(ISO_4217_LIST_ONE.published, '2026-09-17');
  const { codes } = ISO_4217_LIST_ONE;
  assert.equal(codes.length, 155);
  assert.deepEqual([...codes].sort(), codes);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.match(code, /^[A-Z]{3}$/u);
  for (const kept of ['USD', 'EUR', 'CAD', 'GBP', 'JPY', 'XAF', 'XCD', 'XCG', 'XOF', 'XPF']) {
    assert.ok(codes.includes(kept), kept);
  }
  // The fund codes and the codes with no minor unit are not currencies a document is paid in.
  for (const out of ['USN', 'BOV', 'CHE', 'CLF', 'XAD', 'XAU', 'XAG', 'XDR', 'XTS', 'XXX', 'XSU']) {
    assert.ok(!codes.includes(out), out);
  }
});

test('a printed code is trimmed and upper-cased; anything else is not recognised and its text is not kept', () => {
  assert.deepEqual(cleanCurrency('usd'), { kind: 'code', code: 'USD' });
  assert.deepEqual(cleanCurrency(' EUR '), { kind: 'code', code: 'EUR' });
  for (const value of ['US$', 'XXX', 'XAU', 'USN', 'ABC', '$', 'U S D', 840]) {
    assert.deepEqual(cleanCurrency(value), { kind: 'unrecognised' }, String(value));
  }
  for (const value of [null, undefined, '', '  ']) {
    assert.deepEqual(cleanCurrency(value), { kind: 'none' }, String(value));
  }
});
