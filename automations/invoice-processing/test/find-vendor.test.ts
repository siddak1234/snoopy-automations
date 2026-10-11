import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { LOOKUP_SENTENCES } from '../src/lookups/read.js';
import { bill, receipt } from './check-world.js';
import { lines } from './fixtures.js';
import {
  PAID,
  lineOf,
  queriesOf,
  reported,
  routeRun,
  sampleVendor,
  stateOf,
} from './lookups-world.js';

/**
 * find-vendor and find-vendor-company (steps 9–10): the seller by its exact name, active or not,
 * then by company name; a contractor who paid, the same way; the fails — an inactive vendor, two
 * with the name, V1 — each its sentence with nothing after it; a near-miss ignored; and names
 * escaped as Intuit reads them.
 */

const THROUGH = 'find-vendor-company';
const failed = (sentence: string) => ({ outcome: 'failed', failureReason: sentence });

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
  assert.equal(
    lineOf(world, 'find-vendor'),
    "Found vendor 'HARROWGATE OFFICE SUPPLY' in QuickBooks by its name (Id 7)",
  );
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
      "SELECT * FROM Vendor WHERE DisplayName = 'Harrowgate Office Supply' AND Active IN (true, false) MAXRESULTS 2",
    'find-vendor-company':
      "SELECT * FROM Vendor WHERE CompanyName = 'Harrowgate Office Supply' AND Active IN (true, false) MAXRESULTS 2",
  });
  assert.equal(
    lineOf(byCompany, 'find-vendor-company'),
    "Found vendor 'Harrowgate' (Id 61) by its company name 'Harrowgate Office Supply'",
  );
  const none = await routeRun({ answer: bill(), through: THROUGH, bare: true });
  assert.deepEqual(stateOf(none.result).vendor, { status: 'new' });
  assert.deepEqual(lines(none.platform).slice(-2), [
    ['find-vendor', 'ok', "No vendor named 'Harrowgate Office Supply' in QuickBooks"],
    [
      'find-vendor-company',
      'ok',
      "No vendor has the company name 'Harrowgate Office Supply' either: new vendor",
    ],
  ]);
  // A receipt's seller nobody has: no vendor to link (D20).
  const seller = await routeRun({ answer: receipt(), through: THROUGH, bare: true });
  assert.match(lineOf(seller, 'find-vendor-company') ?? '', /either: no vendor to link$/u);
});

test('an inactive vendor fails "reactivate it", and two vendors with the name fail; by company name too; nothing after the step runs', async () => {
  const cases: [
    string,
    (sim: Parameters<NonNullable<Parameters<typeof routeRun>[0]['company']>>[0]) => void,
    string,
    string,
  ][] = [
    [
      'inactive',
      (sim) =>
        sim.company.vendors.push(sampleVendor('7', 'Harrowgate Office Supply', { Active: false })),
      LOOKUP_SENTENCES.vendor_inactive,
      'find-vendor',
    ],
    [
      'two',
      (sim) =>
        sim.company.vendors.push(
          sampleVendor('7', 'Harrowgate Office Supply'),
          sampleVendor('8', 'harrowgate office supply'),
        ),
      LOOKUP_SENTENCES.vendor_ambiguous,
      'find-vendor',
    ],
    [
      'inactive by company name',
      (sim) =>
        sim.company.vendors.push(
          sampleVendor('61', 'HOS', { CompanyName: 'Harrowgate Office Supply', Active: false }),
        ),
      LOOKUP_SENTENCES.vendor_company_inactive,
      'find-vendor-company',
    ],
    [
      'two by company name',
      (sim) =>
        sim.company.vendors.push(
          sampleVendor('61', 'HOS East', { CompanyName: 'Harrowgate Office Supply' }),
          sampleVendor('62', 'HOS West', { CompanyName: 'Harrowgate Office Supply' }),
        ),
      LOOKUP_SENTENCES.vendor_company_ambiguous,
      'find-vendor-company',
    ],
  ];
  for (const [label, company, sentence, stepId] of cases) {
    const world = await routeRun({ answer: bill(), bare: true, company });
    assert.deepEqual(world.result, failed(sentence), label);
    assert.equal(reported(world).at(-1), stepId, `${label}: nothing after it runs`);
    assert.match(lines(world.platform).at(-1)?.[2] ?? '', /^Vendor not accepted \(vendor_/u);
    assert.ok(sentence.endsWith('then run it again. Nothing was created.'), label);
  }
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
  assert.equal(
    lineOf(world, 'find-vendor'),
    "No vendor named 'Harrowgate Office Supply' in QuickBooks; 1 near-miss ignored",
  );
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
      "SELECT * FROM Vendor WHERE DisplayName = 'O\\'Brien & Sons' AND Active IN (true, false) MAXRESULTS 2",
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

test('a contractor who paid is found among vendors by name or company name; nobody is V1; inactive or two have their own sentences', async () => {
  const found = await routeRun({ answer: receipt(), through: THROUGH, ...PAID.contractor });
  assert.equal(
    lineOf(found, 'find-vendor'),
    "Found the person who paid, 'Sam Lee', among QuickBooks vendors (Id 31)",
  );
  assert.equal((stateOf(found.result).vendor as JsonObject).vendor1099, true);
  const byCompany = await routeRun({
    answer: receipt(),
    through: THROUGH,
    ...PAID.contractor,
    input: { ...PAID.contractor.input, paidBy: 'Lee Fixtures' },
  });
  assert.equal((stateOf(byCompany.result).vendor as JsonObject).matchedBy, 'company name');
  const nobody = await routeRun({
    answer: receipt(),
    ...PAID.contractor,
    input: { ...PAID.contractor.input, paidBy: 'Nobody Known' },
  });
  assert.deepEqual(nobody.result, failed(LOOKUP_SENTENCES.payer_not_found));
  assert.equal(
    LOOKUP_SENTENCES.payer_not_found,
    "The name in 'Who paid' isn't an employee or vendor in QuickBooks, or an owner in this flow's settings. Type it as QuickBooks shows it, then run it again. Nothing was created.",
  );
  assert.deepEqual(Object.keys(queriesOf(nobody)), ['find-vendor', 'find-vendor-company']);
  const longName = await routeRun({
    answer: receipt(),
    ...PAID.contractor,
    input: { ...PAID.contractor.input, paidBy: 'N'.repeat(101) },
  });
  assert.deepEqual(longName.result, failed(LOOKUP_SENTENCES.payer_not_found));
  assert.deepEqual(Object.keys(queriesOf(longName)), ['find-vendor'], 'no company name that long');
  const inactive = await routeRun({
    answer: receipt(),
    ...PAID.contractor,
    bare: true,
    company: (sim) => sim.company.vendors.push(sampleVendor('31', 'Sam Lee', { Active: false })),
  });
  assert.deepEqual(inactive.result, failed(LOOKUP_SENTENCES.payer_inactive));
  const two = await routeRun({
    answer: receipt(),
    ...PAID.contractor,
    bare: true,
    company: (sim) =>
      sim.company.vendors.push(sampleVendor('31', 'Sam Lee'), sampleVendor('32', 'SAM LEE')),
  });
  assert.deepEqual(two.result, failed(LOOKUP_SENTENCES.payer_ambiguous));
});

test('an employee or an owner who paid has no vendor: both vendor lookups are skipped, with no line and no call', async () => {
  for (const paid of [PAID.employee, PAID.owner]) {
    const world = await routeRun({ answer: receipt(), through: THROUGH, ...paid });
    assert.deepEqual(queriesOf(world), {});
    assert.ok(!reported(world).some((stepId) => stepId.startsWith('find-vendor')));
    assert.equal(stateOf(world.result).vendor, undefined);
  }
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
