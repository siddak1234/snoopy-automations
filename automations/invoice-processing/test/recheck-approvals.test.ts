import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { RESULTS } from '../src/words.js';
import { bill, creditNote, receipt, sampleAnswer } from './check-world.js';
import { PAID, REF, sampleBill, samplePurchase, type RouteRun } from './lookups-world.js';
import { approve, firstRun, heldState, ownNumbers, writesOf } from './writes-world.js';

/**
 * confirm-no-duplicate end to end, on the simulator (the plan's §5; ip-review design-after-
 * approval-writes-notify-tests.json, its whole-path case "an approval while a new run of the same
 * invoice is in flight (exactly one bill)"): two uploads of one document, held and both approved
 * before either wrote, make ONE record on every path — the re-check searches by the document's
 * number only when the record carries it; the second is not recorded, its details saved — and after
 * a full lookup ("too many to check") a match QuickBooks made before the hold is allowed, one made
 * while it waited is not.
 */

const HOLD_ALL = { ...PAID.company.config, holdAboveAmount: 0 };
/** Not recorded, the details saved: the record may already be in QuickBooks (decision 6). */
const DUPLICATE = RESULTS.notRecorded('may already be in QuickBooks');
const summaryOf = (result: RunResult) =>
  result.outcome === 'success' ? result.summary : JSON.stringify(result);
const STOPPED = [
  'confirm-no-duplicate',
  'failed',
  'Not recorded in QuickBooks: may already be in QuickBooks',
];

/** Every path, held whatever its amount. */
const PATHS: readonly [string, RouteRun][] = [
  ['a bill, its number sent', { answer: bill() }],
  [
    "a bill whose number another vendor's bill has, kept in the memo",
    {
      answer: bill(),
      company: (sim) =>
        sim.company.bills.push(sampleBill('161', REF.other, { DocNumber: 'HOS-1042' })),
    },
  ],
  ["a new vendor's bill", { answer: bill(), bare: true }],
  ['a company receipt on the card', { answer: receipt() }],
  [
    'a company receipt paid by check from the bank',
    { answer: receipt({ paymentMethod: 'check' }), ...PAID.bank },
  ],
  [
    'a company receipt paid by card from the bank — the company has no card — its seller no vendor',
    { answer: receipt(), bare: true, ...PAID.bank },
  ],
  ['a card refund', { answer: sampleAnswer('card-refund') }],
  ['a vendor credit, own numbers unstated: its number in the memo', { answer: creditNote() }],
  ['a vendor credit, own numbers off', { answer: creditNote(), company: ownNumbers('false') }],
  [
    'a vendor credit, own numbers on: its number sent',
    { answer: creditNote(), company: ownNumbers('true') },
  ],
];

test('two uploads of one document, held and both approved before either wrote, make ONE record on every path: the second approval finds the first', async () => {
  for (const [label, run] of PATHS) {
    const first = await firstRun({
      ...run,
      config: { ...(run.config ?? PAID.company.config), holdAboveAmount: 0 },
    });
    const { bills, purchases, vendorCredits, journalEntries } = first.simulator.company;
    const records = () =>
      bills.length + purchases.length + vendorCredits.length + journalEntries.length;
    const before = records();
    const one = await approve(first, { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    assert.equal(one.result.outcome, 'success', label);
    // The second upload's hold: the same decision, made before the first approval wrote anything.
    const two = await approve(first, { runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    assert.equal(summaryOf(two.result), DUPLICATE, label);
    assert.deepEqual(writesOf(two.providerCalls), [], label);
    assert.equal(records(), before + 1, label);
  }
});

/** `count` identical charges on the card, all there before the run, dated a day apart. */
const charges = (count: number) => (sim: Parameters<NonNullable<RouteRun['company']>>[0]) => {
  for (let index = 0; index < count; index += 1) {
    sim.company.purchases.push(
      samplePurchase(String(300 + index), REF.visa4417, {
        TxnDate: `2026-09-${26 + index}`,
        TotalAmt: 60.63,
      }),
    );
  }
};

/** The bank feed's charge, made while the run waited: after decide's answer, by QuickBooks' clock. */
const fedWhileWaiting = (id: string) =>
  samplePurchase(id, REF.visa4417, {
    TxnDate: '2026-09-30',
    TotalAmt: 60.63,
    MetaData: {
      CreateTime: '2026-10-10T11:30:00-07:00',
      LastUpdatedTime: '2026-10-10T11:30:00-07:00',
    },
  });

test('confirm-no-duplicate after a full lookup ("too many to check"): a match QuickBooks made before the hold is allowed, one made while it waited keeps it out', async () => {
  // Identical charges on the card, all there before the run: decide's bank-feed check read three,
  // its bound, so the re-check's fourth row was never shown to the approver.
  const four = await firstRun({ answer: receipt(), company: charges(4) });
  const held = heldState(four);
  assert.deepEqual(held.holdReasons, ['possible_duplicate', 'company_charge_found']);
  assert.deepEqual((held.duplicates as JsonObject).expenseIds, ['300', '301', '302']);
  const approved = await approve(four);
  assert.equal(approved.result.outcome, 'success');
  assert.equal(
    approved.steps.find(([stepId]) => stepId === 'confirm-no-duplicate')?.[2],
    'No duplicate',
  );
  assert.deepEqual(writesOf(approved.providerCalls).length, 1);
  // Three before the run, and the bank feed's fourth while it waited, made after decide's answer.
  const three = await firstRun({ answer: receipt(), company: charges(3) });
  three.simulator.company.purchases.push(fedWhileWaiting('303'));
  const fed = await approve(three);
  assert.equal(summaryOf(fed.result), DUPLICATE);
  assert.deepEqual(
    fed.steps.find(([stepId]) => stepId === 'confirm-no-duplicate'),
    STOPPED,
  );
  // A match decide's lookup did not show though it was not full was changed, or added, meanwhile:
  // it fails however old QuickBooks says it is.
  const notFull = await firstRun({ answer: receipt(), config: HOLD_ALL, company: charges(2) });
  notFull.simulator.company.purchases.push(
    samplePurchase('309', REF.visa4417, { TxnDate: '2026-09-30', TotalAmt: 60.63 }),
  );
  assert.equal(summaryOf((await approve(notFull)).result), DUPLICATE);
});

test('the re-check asks for the newest created first, so a match made while the run waited is found however many older ones lie past its bound (sandbox G4–5)', async () => {
  // Five identical charges before the run — decide's lookup read three, "too many to check" — and
  // the feed's sixth while it waited: in the order QuickBooks holds them it would be the sixth row,
  // past the re-check's four.
  const five = await firstRun({ answer: receipt(), company: charges(5) });
  assert.deepEqual(heldState(five).holdReasons, ['possible_duplicate', 'company_charge_found']);
  five.simulator.company.purchases.push(fedWhileWaiting('305'));
  const fed = await approve(five);
  assert.equal(summaryOf(fed.result), DUPLICATE);
  assert.deepEqual(
    fed.steps.find(([stepId]) => stepId === 'confirm-no-duplicate'),
    STOPPED,
  );
  assert.match(
    String(
      fed.providerCalls.find(
        (call) =>
          call.operation === 'query.run' &&
          String(call.input.query).includes('ORDERBY MetaData.CreateTime DESC'),
      )?.input.query,
    ),
    / ORDERBY MetaData\.CreateTime DESC MAXRESULTS 4$/u,
  );
});
