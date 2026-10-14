import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineAutomation, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { decideRun } from '../src/decide/decide.js';
import { HOLD_ORDER } from '../src/decide/holds.js';
import type { SavedState } from '../src/decide/saved.js';
import { withFixedSentences } from '../src/failures.js';
import { runResult } from '../src/output.js';
import { RUN_FAILS } from '../src/words.js';
import type { CreatedState } from '../src/writes/saved-state.js';
import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import { VENDOR, billRow, decideState, found, type DecideSetUp } from './decide-world.js';
import { QUICKBOOKS } from './fixtures.js';
import { OUTPUT_SCHEMA, assertOutputValid, outputValid } from './output-schema.js';

/**
 * The run's result (`src/output.ts`; v2's §2.8 and §3.F): the details saved — the vendor "None",
 * or QuickBooks not recording it after all — a record made, or a statement compared; each with its
 * one result line in the spec's words, the `details` a person reads on the run, and an output the
 * manifest's outputSchema describes; never a throw once a record exists, and a fault, never a
 * made-up output, when the run holds no decision at all.
 */

const FIRST = invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 2, config: QUICKBOOKS });
const APPROVED = invokeFixture({
  templateId: TEMPLATE_ID,
  templateVersion: 2,
  config: QUICKBOOKS,
  continuation: {
    ofRunId: '77777777-7777-4777-8777-777777777777',
    kind: 'approval',
    stepId: 'decide',
    decision: 'approved',
    state: {},
  },
});

/** decide's saved plan for a path, held or straight through. */
function savedOf(setUp: DecideSetUp): SavedState {
  const decision = decideRun({ state: decideState(setUp), config: setUp.config ?? {} });
  if (decision.outcome === 'ok') return decision.saved;
  assert.equal(decision.outcome, 'held', JSON.stringify(decision).slice(0, 200));
  return (decision as Extract<typeof decision, { outcome: 'held' }>).saved;
}

/** The state create-record leaves: the saved plan and the record as QuickBooks answered it. */
function recordedState(saved: SavedState, created: Partial<CreatedState> = {}): JsonObject {
  const { plan } = saved;
  const record: CreatedState = {
    record: plan.record,
    id: '145',
    docNumber: plan.docNumber,
    txnDate: plan.date,
    dueDate: plan.dueDate,
    totalCents: plan.amountCents,
    payeeName: null,
    ...created,
  };
  return { ...saved, created: record as unknown as JsonObject };
}

test('each record made, in the result line §3.F words: "Recorded in QuickBooks: {noun} from {vendor}, {total}."', () => {
  const cases: [DecideSetUp, string][] = [
    [{ answer: bill() }, 'Recorded in QuickBooks: bill from Harrowgate Office Supply, $413.34.'],
    [
      { answer: receipt() },
      'Recorded in QuickBooks: expense from Harrowgate Office Supply, $60.63.',
    ],
    [
      { answer: sampleAnswer('card-refund') },
      'Recorded in QuickBooks: card refund from Harrowgate Office Supply, $23.72.',
    ],
    [
      { answer: creditNote() },
      'Recorded in QuickBooks: vendor credit from Harrowgate Office Supply, $203.20.',
    ],
  ];
  for (const [setUp, summary] of cases) {
    const result = runResult(recordedState(savedOf(setUp)), FIRST);
    assert.equal(result.summary, summary);
    assert.equal(result.output.outcome, 'recorded');
    assert.deepEqual(result.mail.kind, 'recorded');
    assertOutputValid(result.output, summary);
  }
  // The vendor's name as QuickBooks wrote it on the record wins; its total is the one shown.
  const differs = runResult(
    recordedState(savedOf({ answer: bill() }), { totalCents: 41_400, payeeName: 'HARROWGATE' }),
    FIRST,
  );
  assert.equal(differs.summary, 'Recorded in QuickBooks: bill from HARROWGATE, $414.00.');
  // A long vendor's name is shortened: the line stays one short sentence.
  const long = runResult(
    recordedState(savedOf({ answer: bill() }), { payeeName: 'H'.repeat(300) }),
    FIRST,
  );
  assert.ok(long.summary.length <= 120, String(long.summary.length));
  assert.match(long.summary, /, \$413\.34\.$/u);
});

test("a record's details (§2.8): Recorded as, Vendor, Number, Date, Due, Total, Category, Paid from, Decided, Next — each with a value", () => {
  const card = runResult(recordedState(savedOf({ answer: receipt() })), FIRST);
  assert.deepEqual(card.details, [
    { label: 'Recorded as', value: 'Expense' },
    { label: 'Vendor', value: 'Harrowgate Office Supply' },
    { label: 'Number', value: '55120' },
    { label: 'Date', value: 'Sep 27, 2026' },
    { label: 'Total', value: '$60.63' },
    { label: 'Category', value: 'Repairs & Maintenance' },
    { label: 'Paid from', value: 'Visa 4417' },
    { label: 'Decided', value: 'Automatically' },
    { label: 'Next', value: 'When this charge arrives in your bank feed, choose Match, not Add.' },
  ]);
  const owed = runResult(recordedState(savedOf({ answer: bill() })), APPROVED);
  assert.deepEqual(owed.details, [
    { label: 'Recorded as', value: 'Bill' },
    { label: 'Vendor', value: 'Harrowgate Office Supply' },
    { label: 'Number', value: 'HOS-1042' },
    { label: 'Date', value: 'Sep 14, 2026' },
    { label: 'Due', value: 'Oct 14, 2026' },
    { label: 'Total', value: '$413.34' },
    { label: 'Category', value: 'Office Supplies' },
    { label: 'Decided', value: 'After approval' },
  ]);
});

test('a record made after an approval: the whole output — no payer, the category and why, Paid from, the next step, why it was held', () => {
  const saved = savedOf({ answer: receipt(), config: { holdAboveAmount: 10 } });
  const { output } = runResult(recordedState(saved, { id: '228' }), APPROVED);
  assert.deepEqual(output, {
    outcome: 'recorded',
    documentType: 'receipt',
    route: 'company_receipt',
    record: {
      type: 'expense',
      id: '228',
      operation: 'purchase.create',
      paymentType: 'CreditCard',
      amountCents: 6063,
      quickBooksTotalCents: 6063,
      date: '2026-09-27',
      dueDate: null,
      docNumber: null,
      documentNumber: '55120',
      payee: { kind: 'vendor', id: '7', name: 'Harrowgate Office Supply' },
      category: { id: '305', name: 'Repairs & Maintenance', why: 'its name' },
      paidFromAccount: { id: '42', name: 'Visa 4417' },
    },
    newVendor: null,
    nextStep: 'When this charge arrives in your bank feed, choose Match, not Add.',
    holdReasons: ['over_limit'],
    decidedBy: 'after approval',
  });
  assertOutputValid(output);
  // A bill's new vendor, as the vendor it became.
  const fresh = savedOf({ answer: bill(), vendor: { status: 'new' } });
  const made = runResult(
    {
      ...recordedState(fresh),
      newVendor: { how: 'created', id: '1001', displayName: 'Harrowgate Office Supply' },
    },
    APPROVED,
  ).output;
  assert.deepEqual(
    [(made.record as JsonObject).payee, made.newVendor],
    [
      { kind: 'vendor', id: '1001', name: 'Harrowgate Office Supply' },
      { how: 'created', id: '1001', displayName: 'Harrowgate Office Supply' },
    ],
  );
  assertOutputValid(made);
});

test("a statement compared: every listed number QuickBooks lacks, decide's line, and its details", () => {
  const decision = decideRun({
    state: decideState({
      answer: statement(),
      vendor: { ...VENDOR, balanceCents: 68_654 },
      lookups: { numberLookup: found(billRow({ docNumber: 'HOS-1042' })) },
    }),
    config: {},
  });
  assert.ok(decision.outcome === 'compared');
  const { output, summary, details } = runResult(decision.result as unknown as JsonObject, FIRST);
  assert.equal(summary, decision.summary);
  assert.equal(summary, 'Compared with QuickBooks: 2 invoices not in QuickBooks.');
  assert.deepEqual(output, {
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
      openBillsNotListed: { count: 0, totalCents: 0 },
      openBillsCheckable: true,
      quickBooksOpenCents: 68654,
      differenceCents: 0,
    },
    secondCheck: 'made',
  });
  assert.deepEqual(details, [
    { label: 'Vendor', value: 'Harrowgate Office Supply' },
    { label: 'Statement total', value: '$686.54' },
    { label: 'Not in QuickBooks', value: '2 invoices' },
    { label: 'Open in QuickBooks', value: '$686.54' },
  ]);
  assertOutputValid(output);
});

test("a statement's open-bills lookup at its maximum: the output keeps the count and says it may be short (D6)", () => {
  const output = (reachedMax: boolean) => {
    const decision = decideRun({
      state: decideState({
        answer: statement(),
        lookups: {
          amountLookup: {
            reachedMax,
            records: [billRow({ id: '9', docNumber: 'HOS-0999', balanceCents: 1_000 })],
          },
        },
      }),
      config: {},
    });
    assert.ok(decision.outcome === 'compared');
    const result = runResult(decision.result as unknown as JsonObject, FIRST).output;
    assertOutputValid(result);
    return result.statement as JsonObject;
  };
  for (const reachedMax of [false, true]) {
    const { openBillsNotListed, openBillsCheckable, listedCheckable } = output(reachedMax);
    assert.deepEqual(
      [openBillsNotListed, openBillsCheckable, listedCheckable],
      [{ count: 1, totalCents: 1_000 }, !reachedMax, true],
    );
  }
});

test('the outputSchema refuses what the output never is: an extra key, a date not YYYY-MM-DD, an unknown hold, a payer, a journal entry', () => {
  const { output } = runResult(recordedState(savedOf({ answer: bill() })), FIRST);
  const record = output.record as JsonObject;
  assert.ok(outputValid(output));
  for (const wrong of [
    { ...output, extra: 1 },
    { ...output, record: { ...record, date: '14/09/2026' } },
    { ...output, record: { ...record, id: '' } },
    { ...output, holdReasons: ['made_up'] },
    { ...output, holdReasons: ['paid_personally'] },
    { ...output, outcome: 'planned' },
    { ...output, decidedBy: 'later' },
    { ...output, payer: null },
    { ...output, route: 'employee' },
    { ...output, record: { ...record, type: 'journal_entry' } },
    { ...output, record: { ...record, payee: { kind: 'employee', id: '5', name: 'X' } } },
  ]) {
    assert.equal(outputValid(wrong), false, JSON.stringify(wrong).slice(0, 120));
  }
});

test("the outputSchema's lists are the code's: every hold reason, and the routes that record", () => {
  const [recordedSchema] = OUTPUT_SCHEMA.oneOf;
  assert.deepEqual(recordedSchema?.properties.holdReasons?.items?.enum, [...HOLD_ORDER]);
  assert.deepEqual(recordedSchema?.properties.route?.enum, [
    'bill',
    'company_receipt',
    'card_refund',
    'vendor_credit',
  ]);
});

test('never a throw once a record is made: a state that no longer reads whole still answers with its type and Id', () => {
  for (const state of [
    { created: { record: 'bill', id: '151' } },
    { v: 2, route: 'bill', created: { record: 'bill', id: '151' } },
    { ...recordedState(savedOf({ answer: bill() }), { id: '151' }), plan: null },
  ]) {
    const result = runResult(state as JsonObject, FIRST);
    assert.deepEqual(result.output, { outcome: 'recorded', record: { type: 'bill', id: '151' } });
    assert.equal(result.summary, 'Recorded in QuickBooks: bill.');
  }
});

test('a state that holds no decision is a fault — the run fails with the general sentence, never a made-up output', async () => {
  assert.throws(() => runResult({ file: { artifactId: 'x' } }, FIRST), /without a decision/u);
  assert.throws(() => runResult({ v: 2, route: 'statement' }, FIRST), /without a decision/u);
  // A saved plan with no record made: create-record always writes `created` or ends not recorded.
  assert.throws(() => runResult(savedOf({ answer: bill() }) as unknown as JsonObject, FIRST));
  const automation = withFixedSentences(
    defineAutomation({
      templateId: TEMPLATE_ID,
      manifests: [
        {
          templateId: TEMPLATE_ID,
          version: 2,
          requiredCapabilities: [],
          pipeline: [{ id: 'seed' }],
        },
      ],
      steps: {
        seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: { file: {} } }),
      },
      result: (state, request) => runResult(state, request),
    }),
    () => undefined,
  );
  assert.deepEqual(
    await automation.execute(
      invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 2 }),
      new RecordingPlatform(),
    ),
    { outcome: 'failed', failureReason: RUN_FAILS.other },
  );
});
