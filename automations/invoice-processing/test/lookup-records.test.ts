import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expenseLine } from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';

import { lookupRows } from '../src/lookups/read.js';
import { creditNote, receipt } from './check-world.js';
import {
  REF,
  lineOf,
  routeRun,
  sampleBill,
  sampleJournalEntry,
  samplePurchase,
  stateOf,
} from './lookups-world.js';

/**
 * What each record lookup keeps in the run's state, for decide and for the re-check
 * after an approval: every record as decide's contract types it (`src/decide/contract.ts`), and
 * QuickBooks' own time on the answer, which the re-check holds a record's creation against
 * (`src/decide/recheck.ts`).
 */

/** The `time` the kit's simulator gives every answer. */
const SIMULATOR_TIME = '2026-10-10T09:00:00.000-07:00';

test("each record is kept as decide's contract types it: a bill, an expense, a vendor credit, a journal entry and its lines", async () => {
  const world = await routeRun({
    answer: receipt(),
    through: 'find-other-record',
    company: (sim) => {
      sim.company.bills.push(
        sampleBill('160', REF.tidewell, {
          DocNumber: '55120',
          TxnDate: '2026-09-20',
          TotalAmt: 60.63,
          Balance: 0,
        }),
      );
      sim.company.purchases.push(
        samplePurchase('201', REF.visa, {
          TxnDate: '2026-09-28',
          TotalAmt: 60.63,
          DocNumber: 'X 1',
        }),
      );
      sim.company.journalEntries.push(
        sampleJournalEntry(
          '401',
          60.63,
          { debit: REF.electric, credit: REF.teamOwed },
          { TxnDate: '2026-09-27' },
          { Type: 'Employee', EntityRef: { value: '55', name: 'Robin Example' } },
        ),
      );
    },
  });
  const state = stateOf(world.result);
  const bill160 = {
    kind: 'bill',
    id: '160',
    vendorId: '9',
    docNumber: '55120',
    txnDate: '2026-09-20',
    totalCents: 6063,
    balanceCents: 0,
    lineAccounts: [{ id: '64', name: 'Office Supplies' }],
  };
  // QuickBooks' own time on each answer, the simulator's: the re-check after an approval holds a
  // record's creation against it.
  const answeredAt = SIMULATOR_TIME;
  assert.deepEqual(state.numberLookup, { reachedMax: false, records: [bill160], answeredAt });
  assert.deepEqual(state.relatedLookup, { reachedMax: false, records: [bill160], answeredAt });
  assert.deepEqual(state.amountLookup, {
    reachedMax: false,
    answeredAt,
    records: [
      {
        kind: 'expense',
        id: '201',
        accountId: '41',
        txnDate: '2026-09-28',
        totalCents: 6063,
        credit: false,
        docNumber: 'X 1',
      },
    ],
  });
  assert.deepEqual(state.otherRecordLookup, {
    reachedMax: false,
    answeredAt,
    records: [
      {
        kind: 'journal_entry',
        id: '401',
        txnDate: '2026-09-27',
        lines: [
          { postingType: 'Debit', amountCents: 6063, accountId: '57', entity: null },
          {
            postingType: 'Credit',
            amountCents: 6063,
            accountId: '120',
            entity: { type: 'Employee', id: '55' },
          },
        ],
      },
    ],
  });
  // Each line says only whether it found a record to weigh (§3.E).
  for (const stepId of ['find-duplicate-number', 'find-duplicate-amount', 'find-other-record']) {
    assert.equal(lineOf(world, stepId), 'Possible duplicate', stepId);
  }
});

test("a lookup keeps QuickBooks' time only when the answer's `time` is a date and time with its offset; else none", async () => {
  const answeredAt = async (time?: unknown) => {
    const body = { QueryResponse: {}, ...(time === undefined ? {} : { time }) };
    const read = await lookupRows({
      context: {
        platform: { callProvider: () => Promise.resolve({ status: 200, body }) },
        request: { deadline: new Date(Date.now() + 60_000).toISOString() },
        state: {},
      } as never,
      clock: { now: () => Date.now(), sleep: () => Promise.resolve() },
      query: "SELECT * FROM Bill WHERE DocNumber = 'HOS-1042' MAXRESULTS 3",
      entity: 'Bill',
      purpose: 'looking for records with this number',
    });
    assert.ok(read.ok);
    return read.answeredAt;
  };
  assert.equal(await answeredAt(SIMULATOR_TIME), SIMULATOR_TIME);
  assert.equal(await answeredAt('2026-10-10T16:00:00Z'), '2026-10-10T16:00:00Z');
  for (const time of [undefined, null, 7, '', 'soon', '2026-10-10', '2026-10-10T09:00:00']) {
    assert.equal(await answeredAt(time), null, String(time));
  }
});

test('a vendor credit kept with its vendor, compared in code; an item line leaves a bill’s accounts unknown', async () => {
  const world = await routeRun({
    answer: creditNote(),
    through: 'find-other-record',
    company: (sim) => {
      sim.company.vendorCredits.push({
        Id: '301',
        VendorRef: REF.other,
        DocNumber: 'CM-0077',
        TxnDate: '2026-09-01',
        TotalAmt: 15,
      });
      sim.company.bills.push(
        sampleBill('151', REF.harrowgate, {
          DocNumber: 'HOS-1042',
          Line: [
            {
              Id: '1',
              Amount: 5,
              DetailType: 'ItemBasedExpenseLineDetail',
              ItemBasedExpenseLineDetail: {},
            },
            // An account line beside the item's: still not "one account the bill used".
            expenseLine(5, { value: '64', name: 'Office Supplies' }),
          ],
        }),
      );
    },
  });
  const state = stateOf(world.result);
  assert.deepEqual((state.numberLookup as JsonObject).records, [
    {
      kind: 'vendor_credit',
      id: '301',
      vendorId: '88',
      docNumber: 'CM-0077',
      txnDate: '2026-09-01',
      totalCents: 1500,
    },
  ]);
  assert.equal(lineOf(world, 'find-duplicate-number'), 'Possible duplicate');
  assert.deepEqual(
    ((state.relatedLookup as JsonObject).records as JsonObject[])[0]?.lineAccounts,
    [],
  );
});
