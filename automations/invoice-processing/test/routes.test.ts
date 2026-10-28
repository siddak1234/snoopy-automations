import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import {
  REF,
  queriesOf,
  reported,
  routeRun,
  sampleBill,
  samplePurchase,
  type RouteRun,
} from './lookups-world.js';
import { heldState, outputOf } from './writes-world.js';

/**
 * Every route through v3 for a file of one document on the simulator, QuickBooks chosen (the plan's
 * §2.6; v2's §2.2, in v3's steps): the steps that report, in order — verify-read only when the first
 * read shows a problem (decision 3), and save-documents skipped while QuickBooks records — the
 * lookups that ask QuickBooks; and the run's outcome: the record made straight through, one hold, or
 * a statement compared. With the vendor "None": `none-path.test.ts`. Each path held, then
 * approved: `writes-paths.test.ts`.
 */

const FIRST = ['receive', 'extract', 'check-documents', 'read-company', 'read-preferences'];
const READS = ['find-accounts'];
const RECORDS = ['find-duplicate-number', 'find-duplicate-amount', 'find-related'];

async function route(run: RouteRun) {
  const world = await routeRun(run);
  return { world, steps: reported(world), lookups: Object.keys(queriesOf(world)) };
}

const planned = (result: RunResult) => outputOf(result);
const held = (result: RunResult) => {
  assert.equal(result.outcome, 'held', JSON.stringify(result).slice(0, 300));
  return (result as Extract<RunResult, { outcome: 'held' }>).held;
};

test('a bill from a vendor QuickBooks has: four record lookups, straight through, the bill created', async () => {
  const { world, steps, lookups } = await route({ answer: bill() });
  assert.deepEqual(steps, [
    ...FIRST,
    ...READS,
    'find-vendors',
    'find-duplicates',
    'find-related',
    'decide',
    'create-records',
  ]);
  assert.deepEqual(lookups, ['find-vendor', ...RECORDS, 'find-other-record']);
  const output = planned(world.result);
  assert.deepEqual(
    [output.outcome, output.route, (output.record as JsonObject).type],
    ['recorded', 'bill', 'bill'],
  );
  assert.equal(world.simulator.company.bills.length, 1);
});

test('a bill from a new vendor: every lookup, and one hold naming the new vendor', async () => {
  const { world, steps } = await route({ answer: bill(), bare: true });
  assert.deepEqual(steps, [
    ...FIRST,
    ...READS,
    'find-vendors',
    'find-names',
    'find-duplicates',
    'find-related',
    'decide',
    'ask-approval',
  ]);
  const hold = held(world.result);
  assert.equal(hold.stepId, 'ask-approval');
  assert.equal(hold.reason, 'Document 1: new vendor.');
  assert.deepEqual(heldState(world).holdReasons, ['new_vendor']);
});

test('a company receipt whose seller is a vendor: linked as payee; one that is none: added as a vendor once its name checks come back clear (B3), and no number lookup', async () => {
  const linked = await route({ answer: receipt() });
  assert.deepEqual(linked.lookups, ['find-vendor', ...RECORDS, 'find-other-record']);
  const record = planned(linked.world.result).record as JsonObject;
  assert.deepEqual(record.payee, { kind: 'vendor', id: '9', name: 'Tidewell Hardware' });
  assert.deepEqual([record.type, record.paymentType], ['expense', 'CreditCard']);
  const added = await route({ answer: receipt(), bare: true });
  assert.deepEqual(added.lookups, [
    'find-vendor',
    'find-vendor-company',
    'find-similar-vendors',
    'find-customer-name',
    'find-employee-name',
    'find-duplicate-amount',
    'find-related',
    'find-other-record',
  ]);
  const vendor = added.world.simulator.company.vendors.find(
    (row) => row.DisplayName === 'Tidewell Hardware',
  );
  assert.ok(vendor, 'the seller added as a vendor');
  assert.deepEqual((planned(added.world.result).record as JsonObject).payee, {
    kind: 'vendor',
    id: vendor.Id,
    name: 'Tidewell Hardware',
  });
});

test('a card refund: its number, the card feed and the original bill; a refund planned on the card', async () => {
  const { world, lookups } = await route({ answer: sampleAnswer('card-refund') });
  assert.deepEqual(lookups, ['find-vendor', ...RECORDS]);
  const record = planned(world.result).record as JsonObject;
  assert.deepEqual([record.type, record.paymentType], ['card_refund', 'CreditCard']);
  // The card the refund names — its last four digits in the account's name (decision 1).
  assert.deepEqual(record.paidFromAccount, { id: '42', name: 'Visa 4417' });
});

test("a vendor credit: its category from the original bill's one account (D25)", async () => {
  const { world, lookups } = await route({
    answer: creditNote(),
    company: (sim) =>
      sim.company.bills.push(
        sampleBill('151', REF.harrowgate, {
          DocNumber: 'HOS-1042',
          TxnDate: '2026-09-14',
          TotalAmt: 413.34,
        }),
      ),
  });
  assert.deepEqual(lookups, ['find-vendor', ...RECORDS]);
  const record = planned(world.result).record as JsonObject;
  assert.equal(record.type, 'vendor_credit');
  assert.deepEqual(record.category, {
    id: '64',
    name: 'Office Supplies',
    why: 'the original bill used it',
  });
});

test("a statement: compared, never held — the vendor's bills among its numbers and its open bills; the run's output carries the comparison", async () => {
  const { world, steps } = await route({
    answer: statement(),
    company: (sim) =>
      sim.company.bills.push(
        sampleBill('140', REF.harrowgate, { DocNumber: 'HOS-1042', TotalAmt: 413.34, Balance: 0 }),
        sampleBill('141', REF.harrowgate, { DocNumber: 'HOS-0999', TotalAmt: 50, Balance: 50 }),
      ),
  });
  assert.deepEqual(steps, [...FIRST, ...READS, 'find-vendors', 'find-duplicates', 'decide']);
  assert.ok(world.result.outcome === 'success');
  assert.deepEqual(outputOf(world.result), {
    outcome: 'compared',
    documentType: 'supplier_statement',
    route: 'statement',
    vendor: { id: '7', displayName: 'Harrowgate Office Supply' },
    statement: {
      closingCents: 68654,
      ownSum: 'adds_up',
      ownSumDifferenceCents: null,
      listedNotInQuickBooks: ['HOS-1031', 'HOS-1050'],
      listedCheckable: true,
      openBillsNotListed: { count: 1, totalCents: 5000 },
      openBillsCheckable: true,
      quickBooksOpenCents: 98000,
      differenceCents: -29346,
    },
    secondCheck: 'not_needed',
  });
  assert.equal(world.result.summary, 'Compared with QuickBooks: 2 invoices not in QuickBooks.');
  const [document] = world.result.documents ?? [];
  assert.deepEqual(
    [document?.status, document?.statusText, document?.type],
    ['compared', 'Compared with QuickBooks: 2 invoices not in QuickBooks', 'statement'],
  );
  assert.deepEqual(document?.details, [
    { label: 'Statement total', value: '$686.54' },
    { label: 'Open in QuickBooks', value: '$980.00' },
  ]);
  assert.equal(
    world.platform.steps.some((step) => step.outcome === 'held'),
    false,
  );
});

test("a statement whose vendor has 41 open bills it does not list, the lookup reading 40: the output's flag says the count may be short (D6)", async () => {
  const { world } = await route({
    answer: statement(),
    company: (sim) => {
      for (let index = 0; index < 41; index += 1) {
        sim.company.bills.push(
          sampleBill(String(500 + index), REF.harrowgate, {
            DocNumber: `X-${index}`,
            TotalAmt: 10,
          }),
        );
      }
    },
  });
  assert.equal(
    world.platform.steps.find((step) => step.stepId === 'find-duplicates')?.summary,
    'Number checked; Amount checked',
  );
  assert.ok(world.result.outcome === 'success');
  const compared = (outputOf(world.result) as { statement: JsonObject }).statement;
  assert.deepEqual(
    [compared.openBillsNotListed, compared.openBillsCheckable, compared.listedCheckable],
    [{ count: 40, totalCents: 40_000 }, false, true],
  );
  assert.equal(world.result.summary, 'Compared with QuickBooks: 3 invoices not in QuickBooks.');
});

test('a bill whose number an expense already carries, whoever its payee, holds as a possible duplicate (decision 6, G4-5)', async () => {
  const { world } = await route({
    answer: bill(),
    company: (sim) =>
      sim.company.purchases.push(
        samplePurchase('139', REF.checking, {
          PaymentType: 'Check',
          DocNumber: 'HOS-1042',
          TxnDate: '2026-08-02',
          TotalAmt: 1200,
          EntityRef: { type: 'Vendor', value: '88', name: 'Pacific Gas' },
        }),
      ),
  });
  const hold = held(world.result);
  assert.deepEqual(heldState(world).holdReasons, ['possible_duplicate']);
  assert.equal(hold.reason, 'Document 1: may already be in QuickBooks.');
  assert.equal(
    world.platform.steps.find((step) => step.stepId === 'find-related')?.summary.split('; ')[0],
    'Possible duplicate',
  );
});

test('5c: a read that writes its type "Bill" ends on the bill route, the platform converting it to the schema’s spelling', async () => {
  // The platform hands on "Bill" as `bill` (its Round 21, 5c); the recording platform does too,
  // so an exact `case 'bill'` takes the bill branch and never the wrong one.
  const { world, steps } = await route({ answer: bill({ documentType: 'Bill' }) });
  assert.ok(steps.includes('create-records'), steps.join(', '));
  const output = planned(world.result);
  assert.deepEqual([output.outcome, output.route], ['recorded', 'bill']);
});
