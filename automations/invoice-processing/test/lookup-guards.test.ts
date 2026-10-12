import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleBill, sampleJournalEntry, samplePurchase } from '@autom8x/automation-kit/testing';
import { defineAutomation, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, pipelineSteps } from '../src/automation.js';
import { LOOKUP_SENTENCES, lookupDocumentOf } from '../src/lookups/read.js';
import {
  billOf,
  expenseOf,
  journalEntryOf,
  matchedVendorOf,
  recordsOf,
  vendorCreditOf,
} from '../src/lookups/records.js';
import { bill, check, documentOf, receipt, statement } from './check-world.js';
import { lines } from './fixtures.js';
import { LOOKUP_STEPS, PAID, REF, routeRun, stateOf } from './lookups-world.js';

/**
 * The guards that should never fire: the state a lookup reads, missing or malformed, ends the run
 * with "could not finish its checks", never a guess; and a QuickBooks row missing what decide weighs
 * is no record at all.
 */

test('the document a lookup reads: a record needs its date and amount; a statement, its rows', () => {
  const state = (document: unknown): JsonObject => ({ document: document as JsonObject });
  const good = documentOf(check(bill())) as unknown as JsonObject;
  assert.ok(lookupDocumentOf(state(good)));
  assert.ok(lookupDocumentOf(state(documentOf(check(statement())))));
  for (const broken of [
    undefined,
    { ...good, route: 'cheque' },
    { ...good, type: 'quote' },
    { ...good, seller: '' },
    { ...good, number: 7 },
    { ...good, numberUsable: 'yes' },
    { ...good, originalInvoiceNumber: 5 },
    { ...good, dueDate: '14/10/2026' },
    { ...good, date: null },
    { ...good, amountCents: 0 },
    { ...good, amountCents: 1.5 },
    { ...(documentOf(check(statement())) as unknown as JsonObject), statement: null },
    {
      ...(documentOf(check(statement())) as unknown as JsonObject),
      statement: { rows: [{ amountCents: 1 }] },
    },
  ]) {
    assert.equal(
      lookupDocumentOf(state(broken)),
      undefined,
      String(JSON.stringify(broken)).slice(0, 80),
    );
  }
});

test('a row without what decide weighs is no record: the whole answer is unexpected', () => {
  const visa = REF.visa;
  assert.equal(
    billOf({ ...sampleBill('1', REF.tidewell), Balance: undefined } as JsonObject),
    undefined,
  );
  assert.equal(billOf({ ...sampleBill('1', REF.tidewell), TxnDate: '2026/09/27' }), undefined);
  assert.equal(billOf({ ...sampleBill('1', REF.tidewell), TotalAmt: '60.63' }), undefined);
  assert.equal(expenseOf({ ...samplePurchase('2', visa), AccountRef: {} }), undefined);
  assert.equal(vendorCreditOf({ Id: '7', TxnDate: '2026-09-01', TotalAmt: 1 }), undefined);
  assert.ok(vendorCreditOf({ Id: '7', VendorRef: REF.other, TxnDate: '2026-09-01', TotalAmt: 1 }));
  assert.equal(expenseOf({ ...samplePurchase('2', visa), Id: ' ' }), undefined);
  const entry = sampleJournalEntry('3', 5, { debit: REF.electric, credit: REF.teamOwed });
  const lines0 = entry.Line as JsonObject[];
  assert.equal(
    journalEntryOf({
      ...entry,
      Line: [
        { ...lines0[0], JournalEntryLineDetail: { PostingType: 'Both', AccountRef: REF.electric } },
      ],
    }),
    undefined,
  );
  // A Name of a kind a journal line cannot carry is no Name; a description line is no line.
  const named = journalEntryOf(
    sampleJournalEntry(
      '4',
      5,
      { debit: REF.electric, credit: REF.teamOwed },
      {},
      {
        Type: 'Other',
        EntityRef: { value: '9', name: 'Someone' },
      },
    ),
  );
  assert.deepEqual(
    named?.lines.map((line) => line.entity),
    [null, null],
  );
  assert.equal(
    journalEntryOf({ ...entry, Line: [...lines0, { DetailType: 'DescriptionOnly', Amount: 0 }] })
      ?.lines.length,
    2,
  );
  assert.equal(recordsOf('Purchase', [samplePurchase('5', visa), { Id: '6' }]), undefined);
  assert.equal(matchedVendorOf({ DisplayName: 'Acme' }, 'display name', 'Acme'), undefined);
  assert.equal(
    matchedVendorOf({ Id: '1', DisplayName: '  ' }, 'display name', 'Acme')?.displayName,
    'Acme',
    "QuickBooks' name, or the name searched",
  );
});

/** One lookup step on the runner, after a seed that leaves `state`. */
async function stepOn(stepId: string, state: JsonObject) {
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [
      {
        templateId: TEMPLATE_ID,
        version: 1,
        requiredCapabilities: [],
        pipeline: [{ id: 'seed' }, { id: stepId }],
      },
    ],
    steps: {
      seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state }),
      [stepId]: pipelineSteps({ now: () => Date.now(), sleep: () => Promise.resolve() }, 'amount')[
        stepId
      ]!,
    },
    result: (end) => ({ output: end }),
  });
  const platform = new RecordingPlatform();
  const result = await automation.execute(
    invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 1 }),
    platform,
  );
  return { result, platform };
}

test("a lookup's state missing or malformed — no document, a vendor where none can be, none where one must be — fails before asking QuickBooks", async () => {
  const company = stateOf((await routeRun({ answer: receipt(), through: 'find-vendor' })).result);
  const employee = stateOf(
    (await routeRun({ answer: receipt(), through: 'verify-read', ...PAID.employee })).result,
  );
  const { document: _gone, ...noDocument } = company;
  const { vendor: _none, ...noVendor } = company;
  const RECORDS = LOOKUP_STEPS.slice(5);
  // Each state, and the steps it must stop; every other step skips it, asking nothing.
  const cases: [string, JsonObject, readonly string[]][] = [
    ['no document', noDocument, LOOKUP_STEPS],
    ['no vendor on a company receipt', noVendor, ['find-vendor-company', ...RECORDS]],
    [
      'a vendor on an employee’s receipt',
      { ...employee, vendor: company.vendor as JsonObject },
      RECORDS,
    ],
    [
      'a malformed vendor',
      { ...company, vendor: { status: 'matched', id: '9' } },
      ['find-vendor-company', ...RECORDS],
    ],
  ];
  for (const [label, state, stopped] of cases) {
    for (const stepId of LOOKUP_STEPS) {
      // find-vendor writes the vendor rather than reading it: only a missing document stops it.
      if (stepId === 'find-vendor' && label !== 'no document') continue;
      const { result, platform } = await stepOn(stepId, state);
      const expected = stopped.includes(stepId)
        ? { outcome: 'failed', failureReason: LOOKUP_SENTENCES.state_incomplete }
        : { outcome: 'success', output: state };
      assert.deepEqual(result, expected, `${stepId}: ${label}`);
      if (expected.outcome === 'failed') {
        assert.match(lines(platform).at(-1)?.[2] ?? '', /\(state_incomplete\)$/u);
        assert.deepEqual(platform.providerCalls, [], `${stepId}: ${label}`);
      }
    }
  }
  const { result } = await stepOn('find-vendor', noDocument);
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason: LOOKUP_SENTENCES.state_incomplete,
  });
  const contractor = { ...employee, payer: undefined } as unknown as JsonObject;
  assert.equal(
    (await stepOn('find-vendor', contractor)).result.outcome,
    'success',
    'employee: skipped',
  );
});
