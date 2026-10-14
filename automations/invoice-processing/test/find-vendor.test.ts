import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { RESULTS } from '../src/words.js';
import { bill, creditNote, receipt, statement } from './check-world.js';
import { lines } from './fixtures.js';
import { lineOf, queriesOf, reported, routeRun, sampleVendor, stateOf } from './lookups-world.js';

/**
 * find-vendor and find-vendor-company: the seller by its exact name, active or not, then by company
 * name; a bill's, a credit note's or a statement's vendor inactive, or two with the name, keeps it
 * out of QuickBooks — the details saved (decision 6) — but for a company receipt's or a card
 * refund's seller, which is then not linked (D20; unlinked-seller.test.ts); a near-miss ignored; and
 * names escaped as Intuit reads them. Lines (§3.E): `Vendor found`, `New vendor`.
 */

const THROUGH = 'find-vendor-company';
const summaryOf = (result: RunResult) =>
  result.outcome === 'success' ? result.summary : JSON.stringify(result);
const NOT_IN_QUICKBOOKS = RESULTS.notRecorded("the vendor isn't in QuickBooks");

test("one vendor with the name, capital letters aside: matched with QuickBooks' name, balance, currency and 1099 mark; the company-name lookup skipped", async () => {
  const world = await routeRun({
    answer: bill(),
    through: THROUGH,
    bare: true,
    company: (sim) =>
      sim.company.vendors.push(
        sampleVendor('7', 'HARROWGATE OFFICE SUPPLY', {
          Balance: 980.5,
          Vendor1099: true,
          CurrencyRef: { value: 'usd', name: 'United States Dollar' },
        }),
      ),
  });
  assert.deepEqual(stateOf(world.result).vendor, {
    status: 'matched',
    id: '7',
    displayName: 'HARROWGATE OFFICE SUPPLY',
    currency: 'USD',
    matchedBy: 'display name',
    balanceCents: 98050,
    vendor1099: true,
  });
  assert.equal(lineOf(world, 'find-vendor'), 'Vendor found');
  assert.equal(lineOf(world, 'find-vendor-company'), undefined, 'skipped: no line');
  assert.deepEqual(Object.keys(queriesOf(world)), ['find-vendor']);
});

test('no vendor by name: one by company name is matched; none at all is a new vendor, both lines saying so', async () => {
  const byCompany = await routeRun({
    answer: bill(),
    through: THROUGH,
    bare: true,
    company: (sim) =>
      sim.company.vendors.push(
        sampleVendor('61', 'Harrowgate', { CompanyName: 'harrowgate office supply' }),
      ),
  });
  assert.deepEqual(stateOf(byCompany.result).vendor, {
    status: 'matched',
    id: '61',
    displayName: 'Harrowgate',
    currency: null,
    matchedBy: 'company name',
    balanceCents: 0,
    vendor1099: false,
  });
  assert.deepEqual(queriesOf(byCompany), {
    'find-vendor':
      "SELECT * FROM Vendor WHERE DisplayName IN ('Harrowgate Office Supply', 'Harrowgate Office Supply (deleted)') AND Active IN (true, false) MAXRESULTS 4",
    'find-vendor-company':
      "SELECT * FROM Vendor WHERE CompanyName = 'Harrowgate Office Supply' AND Active IN (true, false) MAXRESULTS 2",
  });
  assert.equal(lineOf(byCompany, 'find-vendor-company'), 'Vendor found');
  const none = await routeRun({ answer: bill(), through: THROUGH, bare: true });
  assert.deepEqual(stateOf(none.result).vendor, { status: 'new' });
  assert.deepEqual(lines(none.platform).slice(-2), [
    ['find-vendor', 'ok', 'New vendor'],
    ['find-vendor-company', 'ok', 'New vendor'],
  ]);
  // A receipt's seller nobody has: no vendor to link (D20), the same line.
  const seller = await routeRun({ answer: receipt(), through: THROUGH, bare: true });
  assert.equal(lineOf(seller, 'find-vendor-company'), 'New vendor');
});

test("a bill's, a credit note's or a statement's vendor inactive, or two with the name — by company name too: not recorded, no QuickBooks step after it, the details saved", async () => {
  const cases: [
    string,
    (sim: Parameters<NonNullable<Parameters<typeof routeRun>[0]['company']>>[0]) => void,
    string,
  ][] = [
    [
      'inactive',
      (sim) =>
        sim.company.vendors.push(sampleVendor('7', 'Harrowgate Office Supply', { Active: false })),
      'find-vendor',
    ],
    [
      'two',
      (sim) =>
        sim.company.vendors.push(
          sampleVendor('7', 'Harrowgate Office Supply'),
          sampleVendor('8', 'harrowgate office supply'),
        ),
      'find-vendor',
    ],
    [
      'inactive by company name',
      (sim) =>
        sim.company.vendors.push(
          sampleVendor('61', 'HOS', { CompanyName: 'Harrowgate Office Supply', Active: false }),
        ),
      'find-vendor-company',
    ],
    [
      'two by company name',
      (sim) =>
        sim.company.vendors.push(
          sampleVendor('61', 'HOS East', { CompanyName: 'Harrowgate Office Supply' }),
          sampleVendor('62', 'HOS West', { CompanyName: 'Harrowgate Office Supply' }),
        ),
      'find-vendor-company',
    ],
  ];
  for (const [label, company, stepId] of cases) {
    const world = await routeRun({ answer: bill(), bare: true, company });
    assert.equal(summaryOf(world.result), NOT_IN_QUICKBOOKS, label);
    assert.deepEqual(
      reported(world).slice(-2),
      [stepId, 'save-details'],
      `${label}: no QuickBooks step after it`,
    );
    assert.deepEqual(lines(world.platform).at(-2), [
      stepId,
      'failed',
      "Not recorded in QuickBooks: the vendor isn't in QuickBooks",
    ]);
  }
  // A credit note's and a statement's vendor must be QuickBooks' own: the same.
  const inactive = await routeRun({
    answer: creditNote(),
    bare: true,
    company: (sim) =>
      sim.company.vendors.push(sampleVendor('7', 'Harrowgate Office Supply', { Active: false })),
  });
  assert.equal(summaryOf(inactive.result), NOT_IN_QUICKBOOKS);
  const two = await routeRun({
    answer: statement(),
    bare: true,
    company: (sim) =>
      sim.company.vendors.push(
        sampleVendor('7', 'Harrowgate Office Supply'),
        sampleVendor('8', 'HARROWGATE OFFICE SUPPLY'),
      ),
  });
  assert.equal(summaryOf(two.result), NOT_IN_QUICKBOOKS);
});

test('a row QuickBooks returns under another name is a near-miss, ignored: the vendor is new', async () => {
  const world = await routeRun({
    answer: bill(),
    through: THROUGH,
    bare: true,
    company: (sim) =>
      sim.script('query.run', [
        { status: 200 },
        {
          status: 200,
          body: {
            QueryResponse: {
              startPosition: 1,
              Vendor: [sampleVendor('70', 'Harrowgate Office Supply West')],
              maxResults: 1,
            },
          },
        },
      ]),
  });
  assert.deepEqual(stateOf(world.result).vendor, { status: 'new' });
  assert.equal(lineOf(world, 'find-vendor'), 'New vendor');
});

test('names with an apostrophe, an ampersand or a backslash are sent escaped and matched as printed', async () => {
  for (const name of ["O'Brien & Sons", 'Back\\Slash Supply', 'Say "Hi" Signs']) {
    const world = await routeRun({
      answer: bill({ vendorName: name }),
      through: THROUGH,
      bare: true,
      company: (sim) => sim.company.vendors.push(sampleVendor('91', name)),
    });
    assert.equal((stateOf(world.result).vendor as JsonObject).id, '91', name);
  }
  const world = await routeRun({
    answer: bill({ vendorName: "O'Brien & Sons" }),
    through: THROUGH,
    bare: true,
  });
  assert.deepEqual(queriesOf(world), {
    'find-vendor':
      "SELECT * FROM Vendor WHERE DisplayName IN ('O\\'Brien & Sons', 'O\\'Brien & Sons (deleted)') AND Active IN (true, false) MAXRESULTS 4",
    'find-vendor-company':
      "SELECT * FROM Vendor WHERE CompanyName = 'O\\'Brien & Sons' AND Active IN (true, false) MAXRESULTS 2",
  });
});

test('a name past the 100 characters a company name holds is not searched by company name', async () => {
  const long = `Harrowgate ${'Office '.repeat(14)}Supply`;
  assert.ok(long.length > 100 && long.length <= 500);
  const world = await routeRun({
    answer: bill({ vendorName: long }),
    through: THROUGH,
    bare: true,
  });
  assert.deepEqual(Object.keys(queriesOf(world)), ['find-vendor']);
  assert.deepEqual(stateOf(world.result).vendor, { status: 'new' });
});

test('a row QuickBooks returns under another company name is ignored too: the vendor stays new', async () => {
  const world = await routeRun({
    answer: bill(),
    through: THROUGH,
    bare: true,
    company: (sim) =>
      sim.script('query.run', [
        { status: 200 },
        { status: 200 },
        {
          status: 200,
          body: {
            QueryResponse: {
              startPosition: 1,
              Vendor: [sampleVendor('71', 'HOS', { CompanyName: 'Harrowgate Office Supply Ltd' })],
              maxResults: 1,
            },
          },
        },
      ]),
  });
  assert.deepEqual(stateOf(world.result).vendor, { status: 'new' });
});
