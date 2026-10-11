import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardDigits, sameCard } from '../src/values/card.js';
import { creditSignRule } from '../src/values/credit.js';
import { tipRule } from '../src/values/tip.js';

test('card digits are kept only when they are exactly four digits; anything else is unclear', () => {
  assert.deepEqual(cardDigits('4417'), { kind: 'digits', digits: '4417' });
  assert.deepEqual(cardDigits(' 0042 '), { kind: 'digits', digits: '0042' });
  for (const value of ['****4417', '441', '44171', '44 17', 'xx17', '４４１７', 4417]) {
    assert.deepEqual(cardDigits(value), { kind: 'unclear' }, String(value));
  }
  for (const value of [null, undefined, '', '  ']) {
    assert.deepEqual(cardDigits(value), { kind: 'none' }, String(value));
  }
});

test('the card check: the same, different, or unknown unless both are four digits', () => {
  const card = (value: unknown) => cardDigits(value);
  assert.equal(sameCard(card('1234'), card('1234')), 'same');
  assert.equal(sameCard(card('5678'), card('1234')), 'different');
  assert.equal(sameCard(card(null), card('1234')), 'unknown');
  assert.equal(sameCard(card('1234'), card(null)), 'unknown');
  assert.equal(sameCard(card('12'), card('1234')), 'unknown');
});

test('the tip rule: with the tip, only without it, neither way, or nothing to tell', () => {
  // Restaurant: 42.00 + 3.47 + 9.00 = 54.47 — the total includes the tip.
  assert.equal(tipRule(5447, 900, 4547), 'included');
  // A tip written under a total printed before it: 30.00 + 2.48 = 32.48.
  assert.equal(tipRule(3248, 600, 3248), 'added');
  // Within one cent either way.
  assert.equal(tipRule(5448, 900, 4547), 'included');
  assert.equal(tipRule(3249, 600, 3248), 'added');
  assert.equal(tipRule(5000, 600, 3248), 'neither');
  // A card slip with only a tip written in: nothing printed adds up.
  assert.equal(tipRule(3850, 700, null), 'unknown');
  assert.equal(tipRule(3850, null, null), 'none');
  assert.equal(tipRule(3850, 0, null), 'none');
});

test('the credit sign rule weighs every amount but the discount: as printed, flipped, or mixed', () => {
  assert.equal(creditSignRule([21390, null, 20320, 18900, 2490]), 'as_printed');
  assert.equal(creditSignRule([-21390, null, -20320, -18900, -2490]), 'flipped');
  assert.equal(creditSignRule([-2248, -124, 0, -2372]), 'flipped');
  assert.equal(creditSignRule([21390, -20320]), 'mixed');
  assert.equal(creditSignRule([0, null, 0]), 'as_printed');
  assert.equal(creditSignRule([]), 'as_printed');
});
