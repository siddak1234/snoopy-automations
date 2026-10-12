import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import {
  PAID,
  REF,
  queriesOf,
  reported,
  routeRun,
  sampleBill,
  samplePurchase,
  type RouteRun,
} from './lookups-world.js';

/**
 * Every route through v1 on the simulator (the plan's §2.6): the steps that report, in order; the
 * lookups that ask QuickBooks; and the run's outcome — the record made straight through, one hold,
 * or a statement compared. Each path held, then approved: `writes.test.ts`.
 */

const FIRST = ['receive', 'read-company', 'read-preferences', 'find-accounts'];
const READS = ['extract', 'check-document', 'verify-read'];
const PAYER = ['find-payer'];
const RECORDS = ['find-duplicate-number', 'find-duplicate-amount', 'find-related'];

async function route(run: RouteRun) {
  const world = await routeRun(run);
  return { world, steps: reported(world), lookups: Object.keys(queriesOf(world)) };
}

const planned = (result: RunResult) => {
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 300));
  return (result as Extract<RunResult, { outcome: 'success' }>).output as JsonObject;
};
const held = (result: RunResult) => {
  assert.equal(result.outcome, 'held', JSON.stringify(result).slice(0, 300));
  return (result as Extract<RunResult, { outcome: 'held' }>).held;
};

test('a bill from a vendor QuickBooks has: four record lookups, straight through, the bill created', async () => {
  const { world, steps, lookups } = await route({ answer: bill() });
  assert.deepEqual(steps, [
    ...FIRST,
    ...READS,
    'find-vendor',
    ...RECORDS,
    'find-other-record',
    'decide',
    'create-record',
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
    'find-vendor',
    'find-vendor-company',
    'find-similar-vendors',
    'find-customer-name',
    'find-employee-name',
    ...RECORDS,
    'find-other-record',
    'decide',
  ]);
  const hold = held(world.result);
  assert.equal(hold.stepId, 'decide');
  assert.equal(hold.reason, 'New vendor: Harrowgate Office Supply, HOS-1042, $413.34');
});

test('a company receipt whose seller is a vendor: linked as payee; one that is none: no payee, and no number lookup', async () => {
  const linked = await route({ answer: receipt() });
  assert.deepEqual(linked.lookups, ['find-vendor', ...RECORDS, 'find-other-record']);
  const record = planned(linked.world.result).record as JsonObject;
  assert.deepEqual(record.payee, { kind: 'vendor', id: '9', name: 'Tidewell Hardware' });
  assert.deepEqual([record.type, record.paymentType], ['expense', 'CreditCard']);
  const unlinked = await route({ answer: receipt(), bare: true });
  assert.deepEqual(unlinked.lookups, [
    'find-vendor',
    'find-vendor-company',
    'find-duplicate-amount',
    'find-related',
    'find-other-record',
  ]);
  assert.deepEqual((planned(unlinked.world.result).record as JsonObject).payee, { kind: 'none' });
});

test('a card refund: its number, the card feed and the original bill; a refund planned on the card', async () => {
  const { world, lookups } = await route({ answer: sampleAnswer('card-refund') });
  assert.deepEqual(lookups, ['find-vendor', ...RECORDS]);
  const record = planned(world.result).record as JsonObject;
  assert.deepEqual([record.type, record.paymentType], ['card_refund', 'CreditCard']);
  assert.deepEqual(record.paidFromAccount, { id: '41', name: 'Company Visa' });
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

test('an employee and an owner who paid: no vendor, the day’s journal entries and the company charge; always held', async () => {
  for (const [paid, reason] of [
    [PAID.employee, 'Paid personally: Robin Example paid Tidewell Hardware, $60.63'],
    [PAID.owner, 'Paid personally: Pat Owner paid Tidewell Hardware, $60.63'],
  ] as const) {
    const { world, steps, lookups } = await route({ answer: receipt(), ...paid });
    assert.deepEqual(steps, [
      ...FIRST,
      ...PAYER,
      ...READS,
      'find-duplicate-amount',
      'find-related',
      'decide',
    ]);
    assert.deepEqual(lookups, ['find-duplicate-amount', 'find-related']);
    assert.equal(held(world.result).reason, reason);
  }
});

test('a contractor who paid: found among vendors, their bills and the company charge; held, with the 1099 mark', async () => {
  const { world, steps } = await route({ answer: receipt(), ...PAID.contractor });
  assert.deepEqual(steps, [
    ...FIRST,
    ...PAYER,
    ...READS,
    'find-vendor',
    'find-duplicate-amount',
    'find-related',
    'decide',
  ]);
  const hold = held(world.result);
  assert.equal(
    hold.reason,
    'Paid personally: Sam Lee (1099 vendor) paid Tidewell Hardware, $60.63',
  );
  assert.deepEqual((hold.state as JsonObject).payer, {
    route: 'contractor',
    id: '31',
    name: 'Sam Lee',
    vendor1099: true,
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
  assert.deepEqual(steps, [
    ...FIRST,
    ...READS,
    'find-vendor',
    'find-duplicate-number',
    'find-duplicate-amount',
    'decide',
  ]);
  assert.ok(world.result.outcome === 'success');
  assert.deepEqual(world.result.output, {
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
    secondCheck: 'made',
    switchIgnored: false,
  });
  assert.equal(
    world.result.summary,
    'Statement balance $686.54; QuickBooks shows $980.00 open (differs by $293.46); 2 listed invoices not in QuickBooks; 1 open bill not on it ($50.00). Nothing was created.',
  );
  assert.equal(
    world.platform.steps.some((step) => step.outcome === 'held'),
    false,
  );
});

test("a statement whose vendor has 41 open bills it does not list, the lookup reading 40: the output's flag, decide's line and the run's summary each say the count may be short (D6)", async () => {
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
    world.platform.steps.find((step) => step.stepId === 'find-duplicate-amount')?.summary,
    'Open bills from this vendor: 40, $400.00 open in all; maybe more',
  );
  assert.ok(world.result.outcome === 'success');
  const compared = (world.result.output as { statement: JsonObject }).statement;
  assert.deepEqual(
    [compared.openBillsNotListed, compared.openBillsCheckable, compared.listedCheckable],
    [{ count: 40, totalCents: 40_000 }, false, true],
  );
  const line =
    'Statement balance $686.54; QuickBooks shows $980.00 open (differs by $293.46); 3 listed invoices not in QuickBooks; 40 open bills not on it ($400.00) (too many to check). Nothing was created.';
  assert.equal(
    world.platform.steps.find((step) => step.stepId === 'decide')?.summary,
    line,
    "decide's line",
  );
  assert.equal(world.result.summary, line, "the run's summary");
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
  assert.deepEqual((hold.state as JsonObject).holdReasons, ['possible_duplicate']);
  // The approver sees how it was paid and to whom: a check to someone else (the design's find-expense).
  assert.equal(
    world.platform.steps.find((step) => step.stepId === 'find-related')?.summary,
    "Expenses with number 'HOS-1042': Id 139 (Check to Pacific Gas, 2026-08-02, $1,200.00)",
  );
});
