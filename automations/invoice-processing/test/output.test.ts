import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineAutomation, type JsonObject, type RunDocument } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { decideRun } from '../src/decide/decide.js';
import { HOLD_ORDER } from '../src/decide/holds.js';
import type { SavedState } from '../src/decide/saved.js';
import { withFixedSentences } from '../src/failures.js';
import { partAnswerOf } from '../src/run/answer.js';
import { documentReadOf } from '../src/run/document-read.js';
import { runResult } from '../src/run/result.js';
import { KIND_OF, type Entry } from '../src/run/state.js';
import { RUN_FAILS } from '../src/words.js';
import type { CreatedState } from '../src/writes/saved-state.js';
import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import { VENDOR, billRow, decideState, found, type DecideSetUp } from './decide-world.js';
import { QUICKBOOKS, documentAnswer, partAnswer } from './fixtures.js';
import {
  OUTPUT_SCHEMA,
  assertOutputValid,
  assertResultValid,
  outputValid,
} from './output-schema.js';

/**
 * The run's result once its documents are done (`automations/invoice-processing/src/run/result.ts`, `automations/invoice-processing/src/run/documents.ts`): for
 * each document its output item — v2's record made, statement compared, or details saved (§2.8),
 * with its place — the run's summary in v2's words for one document, and the document whole, its
 * status line and the lines a person reads beside it (`details`); the output as the manifest's
 * outputSchema describes it; never a throw once a record exists, and a fault, never a made-up
 * output, when the state holds no documents.
 */

const REQUEST = { config: QUICKBOOKS };

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

/** One document done: read from `answer`, its steps' state `engine`. */
function entryOf(answer: JsonObject, engine: JsonObject, changes: Partial<Entry> = {}): Entry {
  const [read] = partAnswerOf(partAnswer([documentAnswer(answer)]))?.documents ?? [];
  assert.ok(read, 'a usable read');
  return {
    index: 1,
    kind: KIND_OF[read.documentType],
    read: documentReadOf(read),
    doubts: [],
    engine,
    stage: 'done',
    ...changes,
  };
}

/** The result of a run whose one document is `entry`: its output item, summary and document. */
function resultOf(entry: Entry) {
  const result = runResult({ documents: [entry as unknown as JsonObject] }, REQUEST);
  const [item] = result.output.documents as JsonObject[];
  const [document] = result.documents as [RunDocument];
  assertOutputValid(result.output);
  assertResultValid({ outcome: 'success', ...result });
  const { index: _index, ...output } = item ?? {};
  return { ...result, output, document };
}

test('each record made, in the result line §3.F words: "Recorded in QuickBooks: {noun} from {vendor}, {total}."', () => {
  const cases: [JsonObject, string, string][] = [
    [bill(), 'bill', 'Recorded in QuickBooks: bill from Harrowgate Office Supply, $413.34.'],
    [
      receipt(),
      'expense',
      'Recorded in QuickBooks: expense from Harrowgate Office Supply, $60.63.',
    ],
    [
      sampleAnswer('card-refund'),
      'card refund',
      'Recorded in QuickBooks: card refund from Harrowgate Office Supply, $23.72.',
    ],
    [
      creditNote(),
      'vendor credit',
      'Recorded in QuickBooks: vendor credit from Harrowgate Office Supply, $203.20.',
    ],
  ];
  for (const [answer, noun, summary] of cases) {
    const result = resultOf(entryOf(answer, recordedState(savedOf({ answer }))));
    assert.equal(result.summary, summary);
    assert.equal(result.output.outcome, 'recorded');
    assert.equal(result.document.status, 'recorded');
    assert.equal(result.document.statusText, `Recorded in QuickBooks: ${noun}`);
    assert.deepEqual(result.document.recordedIn, {
      providerId: 'quickbooks',
      recordType: noun,
      recordId: '145',
      accountName: 'Sample Bakery',
    });
  }
  // The vendor's name as QuickBooks wrote it on the record wins; its total is the one shown.
  const differs = resultOf(
    entryOf(
      bill(),
      recordedState(savedOf({ answer: bill() }), { totalCents: 41_400, payeeName: 'HARROWGATE' }),
    ),
  );
  assert.equal(differs.summary, 'Recorded in QuickBooks: bill from HARROWGATE, $414.00.');
  // A long vendor's name is shortened: the line stays one short sentence.
  const long = resultOf(
    entryOf(bill(), recordedState(savedOf({ answer: bill() }), { payeeName: 'H'.repeat(300) })),
  );
  assert.ok(long.summary.length <= 120, String(long.summary.length));
  assert.match(long.summary, /, \$413\.34\.$/u);
});

test("a record's details: what the document's own fields don't say — Category, Paid from, Decided, Next, Due, Shipping — each with a value", () => {
  const card = resultOf(entryOf(receipt(), recordedState(savedOf({ answer: receipt() }))));
  assert.deepEqual(card.document.details, [
    { label: 'Category', value: 'Repairs & Maintenance' },
    { label: 'Paid from', value: 'Visa 4417' },
    { label: 'Decided', value: 'Automatically' },
    { label: 'Next', value: 'When this charge arrives in your bank feed, choose Match, not Add.' },
  ]);
  // The type, seller, number and total are the document's own fields, as read, never repeated.
  assert.deepEqual(
    [card.document.type, card.document.vendor.name, card.document.number, card.document.total],
    ['receipt', 'Tidewell Hardware', '55120', '60.63'],
  );
  const owed = resultOf(
    entryOf(bill(), recordedState(savedOf({ answer: bill() })), { afterApproval: true }),
  );
  assert.deepEqual(owed.document.details, [
    { label: 'Category', value: 'Office Supplies' },
    { label: 'Decided', value: 'After approval' },
    { label: 'Due', value: 'Oct 14, 2026' },
    { label: 'Shipping', value: '$12.00' },
  ]);
});

test('a record made after an approval: the whole output item — no payer, the category and why, Paid from, the next step, why it was held', () => {
  const saved = savedOf({ answer: receipt(), config: { holdAboveAmount: 10 } });
  const { output } = resultOf(
    entryOf(receipt(), recordedState(saved, { id: '228' }), { afterApproval: true }),
  );
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
  // A bill's new vendor, as the vendor it became.
  const fresh = savedOf({ answer: bill(), vendor: { status: 'new' } });
  const made = resultOf(
    entryOf(bill(), {
      ...recordedState(fresh),
      newVendor: { how: 'created', id: '1001', displayName: 'Harrowgate Office Supply' },
    }),
  ).output;
  assert.deepEqual(
    [(made.record as JsonObject).payee, made.newVendor],
    [
      { kind: 'vendor', id: '1001', name: 'Harrowgate Office Supply' },
      { how: 'created', id: '1001', displayName: 'Harrowgate Office Supply' },
    ],
  );
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
  const { output, summary, document } = resultOf(
    entryOf(statement(), decision.result as unknown as JsonObject),
  );
  assert.equal(summary, decision.summary);
  assert.equal(summary, 'Compared with QuickBooks: 2 invoices not in QuickBooks.');
  assert.equal(document.statusText, 'Compared with QuickBooks: 2 invoices not in QuickBooks');
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
  assert.deepEqual(document.details, [
    { label: 'Statement total', value: '$686.54' },
    { label: 'Open in QuickBooks', value: '$686.54' },
  ]);
  assert.equal(document.type, 'statement');
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
    const result = resultOf(entryOf(statement(), decision.result as unknown as JsonObject)).output;
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

test('a document saved: its type as read, and whether QuickBooks refused it or never confirmed', () => {
  const quote = resultOf(entryOf(bill({ documentType: 'quote' }), {}));
  assert.deepEqual(quote.output, {
    outcome: 'saved',
    documentType: 'quote',
    notRecorded: null,
    unconfirmed: false,
  });
  assert.equal(quote.document.statusText, 'Saved. QuickBooks has no record for a quote.');
  const refused = resultOf(
    entryOf(receipt(), { quickBooks: { notRecorded: 'it includes cash back' } }),
  );
  assert.deepEqual(refused.output.notRecorded, 'it includes cash back');
  assert.equal(refused.summary, 'Saved. Not recorded in QuickBooks: it includes cash back.');
  const unsure = resultOf(entryOf(bill(), { quickBooks: { unconfirmed: true } }));
  assert.deepEqual([unsure.output.unconfirmed, unsure.document.status], [true, 'unconfirmed']);
});

test('the outputSchema refuses what the output never is: an extra key, a date not YYYY-MM-DD, an unknown hold, a payer, a journal entry', () => {
  const { output } = resultOf(entryOf(bill(), recordedState(savedOf({ answer: bill() }))));
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

test('never a throw once a record is made: a state that no longer reads whole still answers with its type and Id, recorded', () => {
  for (const engine of [
    { created: { record: 'bill', id: '151' } },
    { v: 2, route: 'bill', created: { record: 'bill', id: '151' } },
    { ...recordedState(savedOf({ answer: bill() }), { id: '151' }), plan: null },
  ]) {
    const entry = entryOf(bill(), engine as JsonObject);
    const result = runResult({ documents: [entry as unknown as JsonObject] }, REQUEST);
    const [item] = result.output.documents as JsonObject[];
    assert.deepEqual(item, { index: 1, outcome: 'recorded', record: { type: 'bill', id: '151' } });
    assert.equal(result.documents[0]?.status, 'recorded');
    assert.match(result.summary, /^Recorded in QuickBooks: bill from Harrowgate Office Supply/u);
  }
});

test('a state that holds no documents is a fault — the run fails with the general sentence, never a made-up output', async () => {
  assert.throws(() => runResult({ file: { artifactId: 'x' } }, REQUEST), /without its documents/u);
  assert.throws(() => runResult({ documents: [] }, REQUEST), /without its documents/u);
  const automation = withFixedSentences(
    defineAutomation({
      templateId: TEMPLATE_ID,
      manifests: [
        {
          templateId: TEMPLATE_ID,
          version: 3,
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
      invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 3 }),
      new RecordingPlatform(),
    ),
    { outcome: 'failed', failureReason: RUN_FAILS.other },
  );
});
