import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunResult } from '@autom8x/automation-sdk';

import { RESULTS } from '../src/words.js';
import { bill, receipt } from './check-world.js';
import { lines } from './fixtures.js';
import { lineOf, queriesOf, routeRun, sampleVendor, stateOf } from './lookups-world.js';
import { approve, firstRun, writesOf } from './writes-world.js';

/**
 * The names QuickBooks gives what it makes inactive (sandbox G4–5, 2026-10-12): a vendor made
 * inactive is renamed "<name> (deleted)", its company name left as it was. So the vendor lookups
 * ask for both forms: an inactive vendor is never taken for a new one — which create-vendor would
 * then add a second time — an active vendor made with the name an inactive one had is that vendor,
 * and a similar name that is inactive is counted once.
 */

const THROUGH = 'find-names';
const summaryOf = (result: RunResult) =>
  result.outcome === 'success' ? result.summary : JSON.stringify(result);
const NOT_IN_QUICKBOOKS = RESULTS.notRecorded("the vendor isn't in QuickBooks");

/** A vendor as QuickBooks keeps it once made inactive: its display name marked, the rest as it was. */
const inactiveAs = (id: string, name: string, displayName = name) =>
  sampleVendor(id, `${displayName} (deleted)`, {
    CompanyName: name,
    PrintOnCheckName: name,
    Active: false,
  });

test('an inactive vendor, as QuickBooks keeps it, is inactive and not new: a bill is not recorded at find-vendor, a receipt’s seller is not linked', async () => {
  const billed = await routeRun({
    answer: bill(),
    bare: true,
    company: (sim) => sim.company.vendors.push(inactiveAs('72', 'Harrowgate Office Supply')),
  });
  assert.equal(summaryOf(billed.result), NOT_IN_QUICKBOOKS);
  assert.deepEqual(
    lines(billed.platform).find(([stepId]) => stepId === 'find-vendors'),
    ['find-vendors', 'failed', "Not recorded in QuickBooks: the vendor isn't in QuickBooks"],
  );
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
  assert.equal(lineOf(receipted, 'find-vendors'), 'Vendor found');
});

test('an active vendor made with the name an inactive one had is that vendor, the inactive one no near-miss; by company name both share it, and the bill is not recorded (sandbox G4–5 #19)', async () => {
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
  assert.equal(lineOf(world, 'find-vendors'), 'Vendor found');
  assert.equal((stateOf(world.result).vendor as { id: string }).id, '73');
  assert.deepEqual(Object.keys(queriesOf(world)), ['find-vendor'], 'settled by its name');
  // Display names that are not the printed name: only the company name, which QuickBooks left on
  // the inactive vendor, finds them — both, as before; no one vendor is it, so the bill is not
  // recorded.
  const shared = (sim: Parameters<NonNullable<Parameters<typeof routeRun>[0]['company']>>[0]) =>
    sim.company.vendors.push(
      inactiveAs('72', 'Harrowgate Office Supply', 'Harrowgate Co.'),
      sampleVendor('73', 'Harrowgate Co.', { CompanyName: 'Harrowgate Office Supply' }),
    );
  const company = await routeRun({ answer: bill(), bare: true, company: shared });
  assert.equal(summaryOf(company.result), NOT_IN_QUICKBOOKS);
  assert.deepEqual(Object.keys(queriesOf(company)), ['find-vendor', 'find-vendor-company']);
});

test('confirm-vendor: a new vendor added while the run waited and made inactive since is inactive: not recorded, nothing created', async () => {
  const first = await firstRun({ answer: bill(), bare: true });
  first.simulator.company.vendors.push(inactiveAs('77', 'Harrowgate Office Supply'));
  const approved = await approve(first);
  assert.equal(summaryOf(approved.result), NOT_IN_QUICKBOOKS);
  assert.deepEqual(
    approved.steps.find(([stepId]) => stepId === 'confirm-vendors'),
    ['confirm-vendors', 'failed', "Not recorded in QuickBooks: the vendor isn't in QuickBooks"],
  );
  assert.deepEqual(writesOf(approved.providerCalls), []);
  assert.equal(first.simulator.company.vendors.length, 1, 'no second vendor');
});

test('find-similar-vendors keeps an inactive vendor by the name it had, and counts it once', async () => {
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
  assert.equal(lineOf(world, 'find-vendors'), 'New vendor, 3 similar names');
  assert.deepEqual(stateOf(world.result).similarVendors, {
    names: ['ACME Supplies Inc', 'Acme Corp', 'Acme Tools (deleted)'],
  });
});
