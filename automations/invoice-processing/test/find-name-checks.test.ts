import assert from 'node:assert/strict';
import { test } from 'node:test';

import { faultAnswer, sampleEmployee, type ScriptedAnswer } from '@autom8x/automation-kit/testing';
import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { RESULTS } from '../src/words.js';
import { bill, receipt } from './check-world.js';
import { lines } from './fixtures.js';
import {
  lineOf,
  queriesOf,
  reported,
  routeRun,
  sampleCustomer,
  sampleVendor,
  stateOf,
} from './lookups-world.js';

/**
 * A new vendor's three checks: the similar names an approver counts — likely-the-same first, never
 * a hold of their own — and a customer's or an employee's use of the name, which holds and names
 * the vendor "(vendor)"; employees a connection cannot read go on as unreadable. Lines (§3.E,
 * §2.6's phrases): `New vendor`, `New vendor, 2 similar names`, `Name used by a customer or
 * employee`.
 */

const summaryOf = (result: RunResult) =>
  result.outcome === 'success' ? result.summary : JSON.stringify(result);

const THROUGH = 'find-employee-name';
/** QuickBooks' answers before step `n` of a new vendor's bill: find-accounts', then each lookup's. */
const before = (count: number): ScriptedAnswer[] =>
  Array.from({ length: count }, () => ({ status: 200 }));

test('a found vendor, or any document but a bill, skips all three: no line, no call', async () => {
  const matched = await routeRun({ answer: bill(), through: THROUGH });
  const receiptOfNewSeller = await routeRun({ answer: receipt(), through: THROUGH, bare: true });
  for (const world of [matched, receiptOfNewSeller]) {
    for (const stepId of ['find-similar-vendors', 'find-customer-name', 'find-employee-name']) {
      assert.ok(!reported(world).includes(stepId), stepId);
      assert.equal(queriesOf(world)[stepId], undefined, stepId);
    }
  }
});

test('similar names: likely-the-same first, inactive ones too; the names kept for decide to count', async () => {
  const world = await routeRun({
    answer: bill({ vendorName: 'Acme Supplies, Inc.' }),
    through: THROUGH,
    bare: true,
    company: (sim) =>
      sim.company.vendors.push(
        sampleVendor('1', 'Acme Tools'),
        sampleVendor('2', 'Acme Corp', { Active: false }),
        sampleVendor('3', 'ACME Supplies Inc'),
      ),
  });
  assert.equal(
    queriesOf(world)['find-similar-vendors'],
    "SELECT * FROM Vendor WHERE DisplayName LIKE '%acme%' AND Active IN (true, false) MAXRESULTS 3",
  );
  assert.equal(lineOf(world, 'find-similar-vendors'), 'New vendor, 3 similar names');
  assert.deepEqual(stateOf(world.result).similarVendors, {
    names: ['ACME Supplies Inc', 'Acme Tools', 'Acme Corp'],
  });
  const none = await routeRun({ answer: bill(), through: THROUGH, bare: true });
  assert.equal(lineOf(none, 'find-similar-vendors'), 'New vendor');
  assert.deepEqual(stateOf(none.result).similarVendors, { names: [] });
});

test('long names are kept cut to 100 characters, and the line counts them', async () => {
  const world = await routeRun({
    answer: bill({ vendorName: 'Acme Supplies' }),
    through: THROUGH,
    bare: true,
    company: (sim) =>
      sim.company.vendors.push(
        ...['1', '2', '3'].map((id) => sampleVendor(id, `Acme ${id}${'x'.repeat(480)}`)),
      ),
  });
  const names = (stateOf(world.result).similarVendors as { names: string[] } | undefined)?.names;
  assert.ok(names?.length === 3 && names.every((name) => name.length === 100), 'kept cut to 100');
  assert.equal(lineOf(world, 'find-similar-vendors'), 'New vendor, 3 similar names');
});

test('a name with no distinctive word sends nothing; the run goes on', async () => {
  const world = await routeRun({
    answer: bill({ vendorName: 'A & B Co' }),
    through: THROUGH,
    bare: true,
  });
  assert.equal(queriesOf(world)['find-similar-vendors'], undefined);
  assert.equal(lineOf(world, 'find-similar-vendors'), 'New vendor');
  assert.equal(stateOf(world.result).similarVendors, undefined);
});

test('QuickBooks unable to list similar names (429s, a Fault): the run goes on to hold as a new vendor', async () => {
  for (const answer of [[{ status: 429 }, { status: 429 }, { status: 429 }], [{ status: 400 }]]) {
    const world = await routeRun({
      answer: bill(),
      bare: true,
      company: (sim) => sim.script('query.run', [...before(3), ...(answer as ScriptedAnswer[])]),
    });
    assert.deepEqual(
      lines(world.platform).find(([stepId]) => stepId === 'find-similar-vendors'),
      ['find-similar-vendors', 'ok', 'New vendor'],
    );
    assert.equal(world.result.outcome, 'held', 'held as a new vendor, not failed');
    assert.ok(reported(world).includes('find-customer-name'));
  }
});

test("a customer or an employee with the name, active or not: a clash; decide holds and creates '<name> (vendor)'", async () => {
  const customer = await routeRun({
    answer: bill(),
    bare: true,
    company: (sim) =>
      sim.company.customers.push(
        sampleCustomer('5', 'harrowgate office supply', { Active: false }),
      ),
  });
  assert.equal(lineOf(customer, 'find-customer-name'), 'Name used by a customer or employee');
  assert.ok(customer.result.outcome === 'held');
  assert.equal(customer.result.held.reason, 'New vendor, name used by a customer or employee.');
  const employee = await routeRun({
    answer: bill(),
    bare: true,
    company: (sim) => sim.company.employees.push(sampleEmployee('56', 'Harrowgate Office Supply')),
  });
  assert.equal(lineOf(employee, 'find-employee-name'), 'Name used by a customer or employee');
  assert.ok(employee.result.outcome === 'held');
  assert.equal(employee.result.held.reason, 'New vendor, name used by a customer or employee.');
  const none = await routeRun({ answer: bill(), through: THROUGH, bare: true });
  const state = stateOf(none.result);
  assert.deepEqual([state.customerNameClash, state.employeeNameClash], ['none', 'none']);
  assert.equal(lineOf(none, 'find-employee-name'), 'New vendor');
});

test('employees this connection cannot read — a 403, an AuthorizationFault — are unreadable and the run goes on; a 401 is QuickBooks not connected (sandbox S7)', async () => {
  const unreadable: ScriptedAnswer[] = [
    { status: 403 },
    { status: 200, body: faultAnswer('3100', 'AuthorizationFault') },
  ];
  for (const answer of unreadable) {
    const world = await routeRun({
      answer: bill(),
      bare: true,
      company: (sim) => sim.script('query.run', [...before(5), answer]),
    });
    assert.deepEqual(
      lines(world.platform).find(([stepId]) => stepId === 'find-employee-name'),
      ['find-employee-name', 'ok', 'New vendor'],
    );
    assert.ok(reported(world).includes('find-duplicate-number'), 'the run went on');
    assert.ok(world.result.outcome === 'held');
    assert.deepEqual(
      (world.result.held.state as JsonObject).holdReasons,
      ['new_vendor'],
      'unreadable adds no hold',
    );
  }
  const through = await routeRun({
    answer: bill(),
    bare: true,
    through: THROUGH,
    company: (sim) => sim.script('query.run', [...before(5), { status: 403 }]),
  });
  assert.equal(stateOf(through.result).employeeNameClash, 'unreadable');
  const reconnect = await routeRun({
    answer: bill(),
    bare: true,
    company: (sim) => sim.script('query.run', [...before(5), { status: 401 }]),
  });
  assert.equal(summaryOf(reconnect.result), RESULTS.notRecorded("QuickBooks isn't connected"));
});

test('a body that is no query answer: the similar-names list goes on past it; the employee check keeps the bill out of QuickBooks, the details saved (N5)', async () => {
  const similar = await routeRun({
    answer: bill(),
    bare: true,
    company: (sim) =>
      sim.script('query.run', [...before(3), { status: 200, body: { Vendor: [] } }]),
  });
  assert.deepEqual(
    lines(similar.platform).find(([stepId]) => stepId === 'find-similar-vendors'),
    ['find-similar-vendors', 'ok', 'New vendor'],
  );
  assert.ok(reported(similar).includes('find-customer-name'), 'the run went on');
  assert.equal(similar.result.outcome, 'held', 'held as a new vendor, not failed');
  const employee = await routeRun({
    answer: bill(),
    bare: true,
    company: (sim) =>
      sim.script('query.run', [...before(5), { status: 200, body: { Employee: [] } }]),
  });
  assert.equal(summaryOf(employee.result), RESULTS.notRecorded("QuickBooks didn't answer"));
  assert.deepEqual(
    lines(employee.platform).find(([stepId]) => stepId === 'find-employee-name'),
    ['find-employee-name', 'failed', "Not recorded in QuickBooks: QuickBooks didn't answer"],
  );
});

test("QuickBooks refusing the customer query keeps the bill out of QuickBooks, never Intuit's words", async () => {
  const world = await routeRun({
    answer: bill(),
    bare: true,
    company: (sim) => sim.script('query.run', [...before(4), { status: 400 }]),
  });
  assert.equal(summaryOf(world.result), RESULTS.notRecorded("QuickBooks didn't answer"));
  assert.deepEqual(
    lines(world.platform).find(([stepId]) => stepId === 'find-customer-name'),
    ['find-customer-name', 'failed', "Not recorded in QuickBooks: QuickBooks didn't answer"],
  );
});

test('a customer or employee QuickBooks returns under another name is no clash', async () => {
  const nearMiss = (entity: string, row: JsonObject): ScriptedAnswer => ({
    status: 200,
    body: { QueryResponse: { startPosition: 1, [entity]: [row], maxResults: 1 } },
  });
  const world = await routeRun({
    answer: bill(),
    through: THROUGH,
    bare: true,
    company: (sim) =>
      sim.script('query.run', [
        ...before(4),
        nearMiss('Customer', sampleCustomer('5', 'Harrowgate Office Supply West')),
        nearMiss('Employee', sampleEmployee('6', 'Harrowgate Office')),
      ]),
  });
  const state = stateOf(world.result);
  assert.deepEqual([state.customerNameClash, state.employeeNameClash], ['none', 'none']);
});

test('a similar-name row without the word, however QuickBooks matched it, is not listed', async () => {
  const world = await routeRun({
    answer: bill({ vendorName: 'Acme Supplies' }),
    through: THROUGH,
    bare: true,
    company: (sim) =>
      sim.script('query.run', [
        ...before(3),
        {
          status: 200,
          body: {
            QueryResponse: {
              startPosition: 1,
              Vendor: [sampleVendor('1', 'Acme Tools'), sampleVendor('2', 'Zenith Corp')],
              maxResults: 2,
            },
          },
        },
      ]),
  });
  assert.deepEqual(stateOf(world.result).similarVendors, { names: ['Acme Tools'] });
  assert.equal(lineOf(world, 'find-similar-vendors'), 'New vendor, 1 similar name');
});
