import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { readDecideState } from '../src/decide/contract.js';
import { decideRun } from '../src/decide/decide.js';
import { requiredLookups } from '../src/decide/lookup-uses.js';
import {
  bill,
  check,
  creditNote,
  documentOf,
  receipt,
  sampleAnswer,
  statement,
} from './check-world.js';
import { VENDOR, decideState, found, type DecideSetUp } from './decide-world.js';

/**
 * decide's whole input, per path (the plan's §2.9 "decide's whole input"): the keys every path
 * needs — the chart among them — each one missing or malformed refused as the guard
 * `state_incomplete` ("Something went wrong") — never a guess. A verification verify-read did not
 * write is "not needed": it was not due.
 */

/** A seller an inactive vendor's name leaves unlinked (D20). */
const NOT_LINKED = { status: 'not_linked', reason: 'inactive', matchedBy: 'display name' } as const;

const PATHS: readonly [string, DecideSetUp][] = [
  ['bill', { answer: bill() }],
  ['bill, a new vendor', { answer: bill(), vendor: { status: 'new' } }],
  ['company receipt', { answer: receipt() }],
  ['company receipt, the seller no vendor', { answer: receipt(), vendor: { status: 'new' } }],
  ['company receipt, the seller not linked', { answer: receipt(), vendor: NOT_LINKED }],
  ['card refund', { answer: sampleAnswer('card-refund') }],
  [
    'card refund, the seller not linked',
    { answer: sampleAnswer('card-refund'), vendor: NOT_LINKED },
  ],
  ['vendor credit', { answer: creditNote() }],
  ['statement', { answer: statement() }],
];

const run = (state: JsonObject) => decideRun({ state, config: {} });

test('a complete state decides on every path', () => {
  for (const [label, setUp] of PATHS) {
    const state = decideState(setUp);
    assert.ok(readDecideState(state), label);
    assert.notEqual(run(state).outcome, 'failed', label);
  }
});

test('no verification is a second read not needed, and it decides', () => {
  const { verification: _none, ...state } = decideState({ answer: bill() });
  assert.deepEqual(readDecideState(state)?.verification, { status: 'not_needed' });
  assert.equal(run(state).outcome, 'ok');
});

test('every key a path reads, missing or malformed, is "could not finish its checks"', () => {
  const incomplete = { outcome: 'failed', failure: 'state_incomplete' };
  const always = ['file', 'company', 'preferences', 'chart', 'document', 'modelServed', 'vendor'];
  for (const [label, setUp] of PATHS) {
    const state = decideState(setUp);
    const document = state.document as JsonObject;
    const vendor = state.vendor as JsonObject | undefined;
    const needed = [
      ...always,
      ...(state.customerNameClash === undefined ? [] : ['customerNameClash', 'employeeNameClash']),
      ...requiredLookups(document.route as never, document as never, (vendor ?? null) as never),
    ];
    for (const key of needed) {
      const { [key]: _gone, ...rest } = state;
      assert.deepEqual(run(rest), incomplete, `${label} without ${key}`);
    }
  }
  const state = decideState({ answer: bill() });
  const malformed: JsonObject[] = [
    { file: { artifactId: '' } },
    { company: { legalName: null } },
    { preferences: { homeCurrency: 'USD' } },
    { chart: { banks: [] } },
    { chart: { ...(state.chart as JsonObject), uncategorized: 'Uncategorized Expense' } },
    { verification: { status: 'maybe' } },
    { modelServed: 7 },
    { vendor: { status: 'matched', id: '7' } },
    { vendor: { status: 'skipped' } },
    { amountLookup: { reachedMax: 'no', records: [] } },
    { amountLookup: { reachedMax: false, records: [], answeredAt: 7 } },
    { amountLookup: found({ kind: 'bill', id: '1' } as never) },
    {
      amountLookup: {
        reachedMax: false,
        records: [{ kind: 'payment', id: '1', txnDate: '2026-09-01' }],
      },
    },
    {
      numberLookup: {
        reachedMax: false,
        records: [
          {
            kind: 'journal_entry',
            id: '1',
            txnDate: '2026-09-01',
            lines: [{ postingType: 'Debit', amountCents: 1.5, accountId: '57', entity: null }],
          },
        ],
      },
    },
    { customerNameClash: 'yes' },
  ];
  for (const change of malformed) {
    assert.deepEqual(run({ ...state, ...change }), incomplete, JSON.stringify(change).slice(0, 80));
  }
});

test("the vendor: every route needs it; a new vendor's bill needs both name checks", () => {
  const incomplete = (state: JsonObject) => run(state).outcome === 'failed';
  const { vendor: _gone, ...noVendor } = decideState({ answer: receipt() });
  assert.ok(incomplete(noVendor));
  // The name checks: a new vendor's bill needs both; a matched vendor's, neither.
  const newBill = decideState({ answer: bill(), vendor: { status: 'new' } });
  const { customerNameClash: _clash, ...withoutClash } = newBill;
  assert.ok(incomplete(withoutClash));
  assert.notEqual(run(decideState({ answer: bill() })).outcome, 'failed');
});

test('a seller not linked is a company receipt\'s or a card refund\'s alone, with its reason and how it was found; anything else is "could not finish its checks"', () => {
  const incomplete = (state: JsonObject) => {
    const decision = run(state);
    return decision.outcome === 'failed' && decision.failure === 'state_incomplete';
  };
  for (const answer of [receipt(), sampleAnswer('card-refund')]) {
    for (const reason of ['inactive', 'ambiguous']) {
      for (const matchedBy of ['display name', 'company name']) {
        const state = decideState({
          answer,
          vendor: { ...NOT_LINKED, reason, matchedBy } as never,
        });
        assert.deepEqual(readDecideState(state)?.vendor, {
          status: 'not_linked',
          reason,
          matchedBy,
        });
        assert.equal(run(state).outcome, 'ok', `${reason}, ${matchedBy}`);
      }
    }
    for (const broken of [
      { ...NOT_LINKED, reason: 'renamed' },
      { ...NOT_LINKED, matchedBy: 'id' },
      { status: 'not_linked' },
    ]) {
      assert.ok(
        incomplete(decideState({ answer, state: { vendor: broken } })),
        JSON.stringify(broken),
      );
    }
  }
  // A bill, a credit note and a statement need QuickBooks' vendor itself.
  for (const setUp of [
    { answer: bill() },
    { answer: creditNote() },
    { answer: statement() },
  ] satisfies DecideSetUp[]) {
    assert.ok(
      incomplete(decideState({ ...setUp, vendor: NOT_LINKED })),
      setUp.answer.documentType as string,
    );
  }
});

test("which lookups must have run, per route (the plan's §5): a number QuickBooks could hold, a linked seller, an original invoice", () => {
  const document = (answer: JsonObject, options = {}) => documentOf(check(answer, options));
  const matched = VENDOR;
  const fresh = { status: 'new' } as const;
  assert.deepEqual(requiredLookups('bill', document(bill()), matched), [
    'amountLookup',
    'numberLookup',
    'relatedLookup',
    'otherRecordLookup',
  ]);
  assert.deepEqual(requiredLookups('bill', document(bill({ documentNumber: null })), matched), [
    'amountLookup',
    'otherRecordLookup',
  ]);
  assert.deepEqual(
    requiredLookups('bill', document(bill({ documentNumber: 'N'.repeat(22) })), matched),
    ['amountLookup', 'otherRecordLookup'],
  );
  assert.deepEqual(requiredLookups('company_receipt', document(receipt()), matched), [
    'amountLookup',
    'numberLookup',
    'relatedLookup',
    'otherRecordLookup',
  ]);
  assert.deepEqual(requiredLookups('company_receipt', document(receipt()), fresh), [
    'amountLookup',
    'relatedLookup',
    'otherRecordLookup',
  ]);
  assert.deepEqual(requiredLookups('card_refund', document(sampleAnswer('card-refund')), matched), [
    'amountLookup',
    'numberLookup',
    'relatedLookup',
  ]);
  assert.deepEqual(requiredLookups('card_refund', document(sampleAnswer('card-refund')), fresh), [
    'amountLookup',
    'numberLookup',
  ]);
  assert.deepEqual(requiredLookups('vendor_credit', document(creditNote()), matched), [
    'amountLookup',
    'numberLookup',
    'relatedLookup',
  ]);
  assert.deepEqual(
    requiredLookups(
      'vendor_credit',
      document(creditNote({ originalInvoiceNumber: null })),
      matched,
    ),
    ['amountLookup', 'numberLookup'],
  );
  assert.deepEqual(requiredLookups('statement', document(statement()), matched), [
    'amountLookup',
    'numberLookup',
  ]);
  assert.deepEqual(
    requiredLookups('statement', document(statement({ listedItems: [] })), matched),
    ['amountLookup'],
  );
});
