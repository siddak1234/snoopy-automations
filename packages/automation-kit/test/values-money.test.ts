import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAXIMUM_CENTS,
  floorCents,
  formatLimit,
  formatMoney,
  groupedDigits,
  queryAmount,
  toCents,
  withinOneCent,
} from '../src/values/money.js';

const cents = (value: number, fraction = false) => ({ kind: 'cents', cents: value, fraction });

test('an amount is whole cents, read from the shortest decimal form the model wrote', () => {
  for (const [value, expected] of [
    [412.5, 41250],
    [0.1, 10],
    [1234.56, 123456],
    [9999999999.99, MAXIMUM_CENTS],
    [-25, -2500],
    [-0.07, -7],
    [7, 700],
  ] as const) {
    assert.deepEqual(toCents(value), cents(expected), String(value));
  }
  assert.deepEqual(toCents(-0), cents(0));
  assert.deepEqual(toCents(0), cents(0));
});

test('a fraction of a cent is rounded half away from zero and marked', () => {
  for (const [value, expected] of [
    [412.505, 41251],
    [412.504, 41250],
    [0.30000000000000004, 30],
    [-412.505, -41251],
    [1.995, 200],
    [1e-7, 0],
  ] as const) {
    assert.deepEqual(toCents(value), cents(expected, true), String(value));
  }
});

test('1e21 and past it is out of range, with its sign; null, NaN and anything else is none', () => {
  assert.deepEqual(toCents(1e21), { kind: 'out_of_range', negative: false });
  assert.deepEqual(toCents(-5e22), { kind: 'out_of_range', negative: true });
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '12.50', true]) {
    assert.deepEqual(toCents(value), { kind: 'none' }, String(value));
  }
  // Just below the bound is read, and is past what QuickBooks takes.
  const big = toCents(9.99e20);
  assert.ok(big.kind === 'cents' && big.cents > MAXIMUM_CENTS);
});

test('a limit is cut down to the cent, read exactly: 499.995 is 49999 and 500.005 is 50000', () => {
  assert.equal(floorCents(500), 50000);
  assert.equal(floorCents(499.995), 49999);
  assert.equal(floorCents(500.005), 50000);
  assert.equal(floorCents(0), 0);
  assert.equal(floorCents(1e-9), 0);
  assert.equal(floorCents(2e21), Number.MAX_SAFE_INTEGER);
  for (const value of [-1, Number.NaN, null, 'abc', undefined, Number.POSITIVE_INFINITY]) {
    assert.equal(floorCents(value), undefined, String(value));
  }
});

test('within one cent either way', () => {
  assert.ok(withinOneCent(100, 101));
  assert.ok(withinOneCent(101, 100));
  assert.ok(withinOneCent(100, 100));
  assert.ok(!withinOneCent(100, 102));
});

test('money as a person reads it: dollars with a sign in front, any other code after', () => {
  assert.equal(formatMoney(125000), '$1,250.00');
  assert.equal(formatMoney(5), '$0.05');
  assert.equal(formatMoney(-4120), '-$41.20');
  assert.equal(formatMoney(MAXIMUM_CENTS), '$9,999,999,999.99');
  assert.equal(formatMoney(125000, 'CAD'), '1,250.00 CAD');
  assert.equal(formatLimit(50000), '$500');
  assert.equal(formatLimit(50050), '$500.50');
  assert.equal(groupedDigits(1234567), '1,234,567');
  assert.equal(groupedDigits(999), '999');
});

test("a searched amount is the query's literal: whole dollars, a dot, two digits, from the integer", () => {
  assert.equal(queryAmount(125000), '1250.00');
  assert.equal(queryAmount(50), '0.50');
  assert.equal(queryAmount(100), '1.00');
  assert.equal(queryAmount(0), '0.00');
  assert.equal(queryAmount(123456789), '1234567.89');
  assert.equal(queryAmount(MAXIMUM_CENTS), '9999999999.99');
  for (const cents of [-1, 1.5, Number.NaN, 2 ** 53]) {
    assert.throws(() => queryAmount(cents), /whole cents/u, String(cents));
  }
});
