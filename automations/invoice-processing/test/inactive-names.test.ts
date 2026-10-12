import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOOKUP_SENTENCES } from '../src/lookups/read.js';
import { bill, receipt } from './check-world.js';
import { lines } from './fixtures.js';
import { lineOf, queriesOf, routeRun, sampleVendor, stateOf } from './lookups-world.js';
import { approve, firstRun, writesOf } from './writes-world.js';

/**
 * The names QuickBooks gives what it makes inactive (sandbox G4–5, 2026-10-12): a vendor made
 * inactive is renamed "<name> (deleted)", its company name left as it was. So the vendor lookups
 * ask for both forms: an inactive vendor is said to be inactive, never taken for a new one — which
 * create-vendor would then add a second time — an active vendor made with the name an inactive one
 * had is that vendor, and a similar name that is inactive is shown once and marked once.
 */

const THROUGH = 'find-employee-name';
const failed = (sentence: string) => ({ outcome: 'failed', failureReason: sentence });

/** A vendor as QuickBooks keeps it once made inactive: its display name marked, the rest as it was. */
const inactiveAs = (id: string, name: string, displayName = name) =>
  sampleVendor(id, `${displayName} (deleted)`, {
    CompanyName: name,
    PrintOnCheckName: name,
    Active: false,
  });

test('an inactive vendor, as QuickBooks keeps it, is inactive and not new: a bill fails "reactivate it" at find-vendor, a receipt’s seller is not linked', async () => {
  const billed = await routeRun({
    answer: bill(),
    bare: true,
    company: (sim) => sim.company.vendors.push(inactiveAs('72', 'Harrowgate Office Supply')),
  });
  assert.deepEqual(billed.result, failed(LOOKUP_SENTENCES.vendor_inactive));
  assert.deepEqual(lines(billed.platform).at(-1), [
    'find-vendor',
    'failed',
    'Vendor not accepted (vendor_inactive)',
  ]);
  assert.deepEqual(Object.keys(queriesOf(billed)), ['find-vendor']);
  const receipted = await routeRun({
    answer: receipt(),
    bare: true,
    through: THROUGH,
    company: (sim) => sim.company.vendors.push(inactiveAs('9', 'Tidewell Hardware')),
  });
  assert.deepEqual(stateOf(receipted.result).vendor, {
    status: 'not_linked',
    reason: 'inactive',
    matchedBy: 'display name',
  });
  assert.equal(
    lineOf(receipted, 'find-vendor'),
    "An inactive vendor has the name 'Tidewell Hardware' in QuickBooks, so it is not linked: no payee",
  );
});

test('an active vendor made with the name an inactive one had is that vendor, the inactive one no near-miss; by company name both share it, and the bill fails as two (sandbox G4–5 #19)', async () => {
  const world = await routeRun({
    answer: bill(),
    bare: true,
    through: THROUGH,
    company: (sim) =>
      sim.company.vendors.push(
        inactiveAs('72', 'Harrowgate Office Supply'),
        sampleVendor('73', 'Harrowgate Office Supply'),
      ),
  });
  assert.equal(
    lineOf(world, 'find-vendor'),
    "Found vendor 'Harrowgate Office Supply' in QuickBooks by its name (Id 73)",
  );
  assert.equal((stateOf(world.result).vendor as { id: string }).id, '73');
  assert.equal(lineOf(world, 'find-vendor-company'), undefined, 'settled by its name');
  // Display names that are not the printed name: only the company name, which QuickBooks left on
  // the inactive vendor, finds them — both, as before; the bill fails as two vendors with it.
  const shared = (sim: Parameters<NonNullable<Parameters<typeof routeRun>[0]['company']>>[0]) =>
    sim.company.vendors.push(
      inactiveAs('72', 'Harrowgate Office Supply', 'Harrowgate Co.'),
      sampleVendor('73', 'Harrowgate Co.', { CompanyName: 'Harrowgate Office Supply' }),
    );
  const company = await routeRun({ answer: bill(), bare: true, company: shared });
  assert.deepEqual(company.result, failed(LOOKUP_SENTENCES.vendor_company_ambiguous));
  assert.deepEqual(Object.keys(queriesOf(company)), ['find-vendor', 'find-vendor-company']);
});

test('confirm-vendor: a new vendor added while the run waited and made inactive since is inactive, and nothing is created', async () => {
  const first = await firstRun({ answer: bill(), bare: true });
  first.simulator.company.vendors.push(inactiveAs('77', 'Harrowgate Office Supply'));
  const approved = await approve(first);
  assert.deepEqual(approved.result, failed(LOOKUP_SENTENCES.vendor_inactive));
  assert.deepEqual(approved.steps.at(-1), [
    'confirm-vendor',
    'failed',
    'New vendor not looked up again (vendor_inactive)',
  ]);
  assert.deepEqual(writesOf(approved.providerCalls), []);
  assert.equal(first.simulator.company.vendors.length, 1, 'no second vendor');
});

test('find-similar-vendors shows an inactive vendor by the name it had, marked inactive once, and still likely the same', async () => {
  const world = await routeRun({
    answer: bill({ vendorName: 'Acme Supplies, Inc.' }),
    through: THROUGH,
    bare: true,
    company: (sim) =>
      sim.company.vendors.push(
        inactiveAs('2', 'Acme Corp'),
        inactiveAs('3', 'ACME Supplies Inc'),
        // A person may name an active vendor so: its name is its own.
        sampleVendor('4', 'Acme Tools (deleted)'),
      ),
  });
  assert.equal(
    lineOf(world, 'find-similar-vendors'),
    "Vendors with 'acme' in the name: 'ACME Supplies Inc' (likely the same) (inactive); 'Acme Corp' (inactive); 'Acme Tools (deleted)'; maybe more",
  );
  assert.deepEqual(stateOf(world.result).similarVendors, {
    names: ['ACME Supplies Inc', 'Acme Corp', 'Acme Tools (deleted)'],
  });
});
