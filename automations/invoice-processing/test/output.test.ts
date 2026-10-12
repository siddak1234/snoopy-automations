import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineAutomation, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { decideRun } from '../src/decide/decide.js';
import type { SavedState } from '../src/decide/saved.js';
import { THROWN_SENTENCES, withFixedSentences } from '../src/failures.js';
import { runResult } from '../src/output.js';
import type { CreatedState } from '../src/writes/saved-state.js';
import { bill, creditNote, paidBy, receipt, sampleAnswer, statement } from './check-world.js';
import { VENDOR, billRow, decideState, found, type DecideSetUp } from './decide-world.js';
import { HOLD_ORDER } from '../src/decide/holds.js';
import { OUTPUT_SCHEMA, assertOutputValid, outputValid } from './output-schema.js';

/**
 * The run's result (`src/output.ts`; the plan's §5 "Output"): a record made — its type and
 * QuickBooks Id, payment type, payer, Paid from account and the next step, the summary
 * create-record's line — or a statement's comparison with its full list of missing invoice
 * numbers; each held to the manifest's outputSchema; never a throw once a record exists, and a
 * fault, never a made-up output, when the run holds no decision at all.
 */

const FIRST = invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 1 });
const APPROVED = invokeFixture({
  templateId: TEMPLATE_ID,
  templateVersion: 1,
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
  const decision = decideRun({ state: decideState(setUp), config: {}, switchOn: false });
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
    totalCents: plan.record === 'journal_entry' ? null : plan.amountCents,
    payeeName: null,
    ...created,
  };
  return { ...saved, created: record as unknown as JsonObject };
}

const CONTRACTOR: DecideSetUp = {
  answer: bill(),
  check: paidBy('not_employee', { paidFrom: null }),
  vendor: { ...VENDOR, id: '31', displayName: 'Sam Lee' },
};

test('each record made, as the summary says it: the record, its QuickBooks Id, and the next step', () => {
  const cases: [DecideSetUp, string][] = [
    [
      { answer: bill() },
      'Recorded bill 145 from Harrowgate Office Supply, HOS-1042, $413.34, due 2026-10-14.',
    ],
    [
      { answer: receipt() },
      'Recorded expense 145 from Company Visa, $60.63. When this charge arrives in your bank feed, choose Match, not Add.',
    ],
    [
      { answer: sampleAnswer('card-refund') },
      'Recorded refund 145 to Company Visa, $23.72. When this charge arrives in your bank feed, choose Match, not Add.',
    ],
    [
      { answer: creditNote() },
      'Recorded vendor credit 145 from Harrowgate Office Supply, CM-0077, $203.20.',
    ],
    [
      { answer: receipt(), check: paidBy('employee', { paidFrom: null }) },
      'Recorded journal entry 145: the company owes Robin Example $60.63. Repay with a check or expense using Owed to Team Members as the category.',
    ],
    [
      { answer: receipt(), check: paidBy('owner', { paidFrom: null }) },
      "Recorded journal entry 145: Pat Owner's owner investment of $60.63. Categorise the repayment to Owner investments.",
    ],
    [CONTRACTOR, 'Recorded bill 145 to Sam Lee, $413.34. Pay it in Pay bills.'],
  ];
  for (const [setUp, summary] of cases) {
    const result = runResult(recordedState(savedOf(setUp)), FIRST);
    assert.equal(result.summary, summary);
    assert.equal(result.output.outcome, 'recorded');
    assertOutputValid(result.output, summary);
  }
  // QuickBooks' total, when it differs from the amount sent, is said; the vendor's name as
  // QuickBooks wrote it on the record wins.
  const differs = runResult(
    recordedState(savedOf({ answer: bill() }), { totalCents: 41_400, payeeName: 'HARROWGATE' }),
    FIRST,
  );
  assert.equal(
    differs.summary,
    'Recorded bill 145 from HARROWGATE, HOS-1042, $413.34, due 2026-10-14; QuickBooks shows $414.00.',
  );
  // Long names are shortened first: the amount and the next step stay whole, at most 200.
  const long = runResult(
    recordedState(
      savedOf({
        answer: receipt(),
        check: paidBy('employee', {
          paidFrom: null,
          payer: {
            route: 'employee',
            name: 'R'.repeat(500),
            employeeId: '55',
            account: { id: '120', fullyQualifiedName: 'O'.repeat(300), accountType: 'Liability' },
          },
        }),
      }),
      { id: '9'.repeat(40) },
    ),
    FIRST,
  );
  assert.ok(long.summary.length <= 200, String(long.summary.length));
  assert.match(
    long.summary,
    / \$60\.63\. Repay with a check or expense using O+…? as the category\.$/u,
  );
});

test('a record made after an approval: the whole output — type and Id, payment type, payer, Paid from, the next step, why it was held — decided after approval', () => {
  const saved = savedOf({ answer: receipt(), check: paidBy('employee', { paidFrom: null }) });
  const { output } = runResult(recordedState(saved, { id: '228' }), APPROVED);
  assert.deepEqual(output, {
    outcome: 'recorded',
    documentType: 'receipt',
    route: 'employee',
    record: {
      type: 'journal_entry',
      id: '228',
      operation: 'journalEntry.create',
      paymentType: null,
      amountCents: 6063,
      quickBooksTotalCents: null,
      date: '2026-09-27',
      dueDate: null,
      docNumber: null,
      documentNumber: '55120',
      payee: { kind: 'employee', id: '55', name: 'Robin Example' },
      category: {
        id: '57',
        name: 'Utilities:Electric',
        why: 'no category set for repairs and maintenance',
      },
      paidFromAccount: null,
    },
    newVendor: null,
    payer: { route: 'employee', id: '55', name: 'Robin Example', vendor1099: null },
    nextStep: 'Repay with a check or expense using Owed to Team Members as the category.',
    holdReasons: ['paid_personally'],
    decidedBy: 'after approval',
  });
  assertOutputValid(output);
  // A receipt from the company card: its payment type and Paid from account.
  const card = runResult(recordedState(savedOf({ answer: receipt() })), FIRST).output;
  assert.deepEqual(
    [
      (card.record as JsonObject).paymentType,
      (card.record as JsonObject).paidFromAccount,
      card.decidedBy,
      card.nextStep,
    ],
    [
      'CreditCard',
      { id: '41', name: 'Company Visa' },
      'automatically',
      'When this charge arrives in your bank feed, choose Match, not Add.',
    ],
  );
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

test("a statement's output holds every listed invoice number QuickBooks lacks, its summary decide's line", () => {
  const decision = decideRun({
    state: decideState({
      answer: statement(),
      vendor: { ...VENDOR, balanceCents: 68_654 },
      lookups: { numberLookup: found(billRow({ docNumber: 'HOS-1042' })) },
    }),
    config: {},
    switchOn: true,
  });
  assert.ok(decision.outcome === 'compared');
  const { output, summary } = runResult(decision.result as unknown as JsonObject, FIRST);
  assert.equal(summary, decision.summary);
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
    switchIgnored: true,
  });
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
      switchOn: false,
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

test('the outputSchema refuses what the output never is: an extra key, a date not YYYY-MM-DD, an unknown hold, a plan never written', () => {
  const { output } = runResult(recordedState(savedOf({ answer: bill() })), FIRST);
  const record = output.record as JsonObject;
  assert.ok(outputValid(output));
  for (const wrong of [
    { ...output, extra: 1 },
    { ...output, record: { ...record, date: '14/09/2026' } },
    { ...output, record: { ...record, id: '' } },
    { ...output, holdReasons: ['made_up'] },
    { ...output, outcome: 'planned' },
    { ...output, decidedBy: 'later' },
    { ...output, record: { ...record, payee: { kind: 'new_vendor', name: 'X' } } },
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
    'employee',
    'owner',
    'contractor',
  ]);
});

test('never a throw once a record is made: a state that no longer reads whole still answers with its type and Id', () => {
  for (const state of [
    { created: { record: 'bill', id: '151' } },
    { v: 1, route: 'bill', created: { record: 'bill', id: '151' } },
    { ...recordedState(savedOf({ answer: bill() }), { id: '151' }), plan: null },
  ]) {
    const result = runResult(state as JsonObject, FIRST);
    assert.deepEqual(result, {
      output: { outcome: 'recorded', record: { type: 'bill', id: '151' } },
      summary: 'Recorded bill 151 in QuickBooks.',
    });
  }
});

test('a state that holds no decision is a fault — the run fails with the general sentence, never a made-up output', async () => {
  assert.throws(() => runResult({ file: { artifactId: 'x' } }, FIRST), /without a decision/u);
  assert.throws(() => runResult({ v: 1, route: 'statement' }, FIRST), /without a decision/u);
  // A saved plan with no record made: create-record always writes `created` or fails the run.
  assert.throws(() => runResult(savedOf({ answer: bill() }) as unknown as JsonObject, FIRST));
  const automation = withFixedSentences(
    defineAutomation({
      templateId: TEMPLATE_ID,
      manifests: [
        {
          templateId: TEMPLATE_ID,
          version: 1,
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
      invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 1 }),
      new RecordingPlatform(),
    ),
    { outcome: 'failed', failureReason: THROWN_SENTENCES.other },
  );
});
