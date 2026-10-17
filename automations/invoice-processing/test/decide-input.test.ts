import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { LOOKUP_KEYS, readDecideState, type VendorState } from '../src/decide/contract.js';
import { requiredLookups } from '../src/decide/lookup-uses.js';
import type { ExpenseSearch } from '../src/lookups/expense-search.js';
import type { DocumentState } from '../src/state.js';
import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import { routeRun, sampleVendor, stateOf, type RouteRun } from './lookups-world.js';

/**
 * decide's whole input, per path (the plan's §2.9): the state the real steps before it leave on
 * the simulator, read by decide's contract (`src/decide/contract.ts`) — complete, holding exactly
 * the lookups the route requires and no other, the vendor, the name checks for a new vendor's bill
 * alone, the chart — under both of sandbox S4's answers. A second read is in it only when one was
 * due.
 */

const PATHS: readonly [string, RouteRun][] = [
  ['bill', { answer: bill() }],
  ['bill, a new vendor', { answer: bill(), bare: true }],
  ['bill, no number', { answer: bill({ documentNumber: null }) }],
  ['company receipt', { answer: receipt() }],
  ['company receipt, the seller no vendor', { answer: receipt(), bare: true }],
  ['card refund', { answer: sampleAnswer('card-refund') }],
  ['card refund, the seller no vendor', { answer: sampleAnswer('card-refund'), bare: true }],
  ['vendor credit', { answer: creditNote() }],
  ['vendor credit, the vendor not in QuickBooks', { answer: creditNote(), bare: true }],
  ['statement', { answer: statement() }],
  ['statement, the vendor not in QuickBooks', { answer: statement(), bare: true }],
  [
    'company receipt, the seller an inactive vendor’s name: not linked',
    {
      answer: receipt(),
      bare: true,
      company: (sim) =>
        sim.company.vendors.push(sampleVendor('9', 'Tidewell Hardware', { Active: false })),
    },
  ],
  [
    'card refund, the seller two vendors’ name: not linked',
    {
      answer: sampleAnswer('card-refund'),
      bare: true,
      company: (sim) =>
        sim.company.vendors.push(
          sampleVendor('9', 'Tidewell Hardware'),
          sampleVendor('19', 'TIDEWELL HARDWARE'),
        ),
    },
  ],
  [
    'vendor credit, its original number past 21 characters',
    { answer: creditNote({ originalInvoiceNumber: 'O'.repeat(22) }) },
  ],
  [
    'statement, every listed number past 21 characters',
    {
      answer: statement({
        listedItems: [{ reference: 'L'.repeat(22), amount: 686.54, kind: 'invoice' }],
      }),
    },
  ],
];

/** The keys the steps before decide write, besides the lookups and the name checks. */
const EARLIER = ['file', 'company', 'preferences', 'chart', 'modelServed', 'document'];

for (const how of ['amount', 'window'] as const satisfies readonly ExpenseSearch[]) {
  test(`every path leaves decide a whole input, its lookups exactly those required (S4: ${how})`, async () => {
    for (const [label, run] of PATHS) {
      const world = await routeRun({ ...run, through: 'find-related', expenseSearch: how });
      const state = stateOf(world.result);
      const read = readDecideState(state, how);
      assert.ok(read, `${label}: decide reads it whole`);
      const document = state.document as unknown as DocumentState;
      const vendor = state.vendor as VendorState;
      assert.ok(vendor, `${label}: a vendor on every route`);
      const required = requiredLookups(document.route, document, vendor, how);
      assert.deepEqual(
        LOOKUP_KEYS.filter((key) => key in state).sort(),
        [...required].sort(),
        `${label}: the lookups present`,
      );
      // A new vendor's name checks: a bill's, and in v3 a receipt's or a card refund's (B3).
      const newVendorBill =
        vendor.status === 'new' &&
        ['bill', 'company_receipt', 'card_refund'].includes(document.route);
      for (const key of ['similarVendors', 'customerNameClash', 'employeeNameClash']) {
        assert.equal(key in state, newVendorBill, `${label}: ${key}`);
      }
      const expected = [
        ...EARLIER,
        'vendor',
        ...('verification' in state ? ['verification'] : []),
        ...(newVendorBill ? ['similarVendors', 'customerNameClash', 'employeeNameClash'] : []),
        ...required,
      ];
      assert.deepEqual(Object.keys(state).sort(), expected.sort(), `${label}: nothing else`);
    }
  });
}

test("the bill's D32 lookup is required under D21 and not under S4's fallback", async () => {
  const world = await routeRun({
    answer: bill(),
    through: 'find-related',
    expenseSearch: 'window',
  });
  const state = stateOf(world.result);
  assert.ok(!('otherRecordLookup' in state));
  assert.ok(readDecideState(state, 'window'));
  assert.equal(
    readDecideState(state, 'amount'),
    undefined,
    'under D21 its absence is "incomplete"',
  );
});

test('each typed record decide reads is held to the contract: a malformed one is refused', async () => {
  const world = await routeRun({ answer: receipt(), through: 'find-related' });
  const state = stateOf(world.result);
  const broken: JsonObject = {
    ...state,
    amountLookup: {
      reachedMax: false,
      records: [{ kind: 'expense', id: '1', txnDate: '2026-09-27', totalCents: 1 }],
    },
  };
  assert.equal(readDecideState(broken), undefined);
});
