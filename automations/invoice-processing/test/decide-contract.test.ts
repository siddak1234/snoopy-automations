import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { readDecideState, requiredLookups } from '../src/decide/contract.js';
import { decideRun } from '../src/decide/decide.js';
import { DECIDE_SENTENCES } from '../src/decide/fails.js';
import {
  bill,
  check,
  creditNote,
  documentOf,
  paidBy,
  receipt,
  sampleAnswer,
  statement,
} from './check-world.js';
import { RUN_ID, VENDOR, decideState, found, type DecideSetUp } from './decide-world.js';

/**
 * decide's whole input, per path (the plan's §2.9 "decide's whole input"): the keys every path
 * needs, Group 4's included, each one missing or malformed refused as "could not finish its
 * checks" — never a guess.
 */

const PATHS: readonly [string, DecideSetUp][] = [
  ['bill', { answer: bill() }],
  ['bill, a new vendor', { answer: bill(), vendor: { status: 'new' } }],
  ['company receipt', { answer: receipt() }],
  ['company receipt, the seller no vendor', { answer: receipt(), vendor: { status: 'new' } }],
  ['card refund', { answer: sampleAnswer('card-refund') }],
  ['vendor credit', { answer: creditNote() }],
  ['employee', { answer: receipt(), check: paidBy('employee', { paidFrom: null }) }],
  ['owner', { answer: receipt(), check: paidBy('owner', { paidFrom: null }) }],
  ['contractor', { answer: receipt(), check: paidBy('not_employee', { paidFrom: null }) }],
  ['statement', { answer: statement() }],
];

const run = (state: JsonObject, switchOn = false) =>
  decideRun({ state, config: {}, switchOn, runId: RUN_ID });

test('a complete state decides on every path', () => {
  for (const [label, setUp] of PATHS) {
    const state = decideState(setUp);
    assert.ok(readDecideState(state), label);
    assert.notEqual(run(state, setUp.check?.switchOn === true).outcome, 'failed', label);
  }
});

test('every key a path reads, missing or malformed, is "could not finish its checks"', () => {
  const incomplete = {
    outcome: 'failed',
    failure: 'state_incomplete',
    sentence: DECIDE_SENTENCES.state_incomplete,
  };
  const always = [
    'file',
    'company',
    'preferences',
    'accounts',
    'document',
    'verification',
    'modelServed',
  ];
  for (const [label, setUp] of PATHS) {
    const state = decideState(setUp);
    const document = state.document as JsonObject;
    const vendor = state.vendor as JsonObject | undefined;
    const needed = [
      ...always,
      ...(state.vendor === undefined ? [] : ['vendor']),
      ...(state.payer === undefined ? [] : ['payer']),
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
    { accounts: { owners: [] } },
    { verification: { status: 'maybe' } },
    { modelServed: 7 },
    { vendor: { status: 'matched', id: '7' } },
    { vendor: { status: 'skipped' } },
    { amountLookup: { reachedMax: 'no', records: [] } },
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

test('the vendor: every route that has one needs it; an employee or owner has none; a contractor is found', () => {
  const incomplete = (state: JsonObject) => run(state).outcome === 'failed';
  assert.ok(
    incomplete(
      decideState({
        answer: receipt(),
        check: paidBy('employee', { paidFrom: null }),
        state: { vendor: VENDOR as never },
      }),
    ),
  );
  assert.ok(
    incomplete(
      decideState({
        answer: receipt(),
        check: paidBy('not_employee', { paidFrom: null }),
        vendor: { status: 'new' },
      }),
    ),
  );
  // The name checks: a new vendor's bill needs both; a matched vendor's, neither.
  const newBill = decideState({ answer: bill(), vendor: { status: 'new' } });
  const { customerNameClash: _gone, ...withoutClash } = newBill;
  assert.ok(incomplete(withoutClash));
  assert.notEqual(run(decideState({ answer: bill() })).outcome, 'failed');
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
  assert.deepEqual(requiredLookups('employee', document(receipt(), paidBy('employee')), null), [
    'amountLookup',
    'relatedLookup',
  ]);
  assert.deepEqual(requiredLookups('owner', document(bill(), paidBy('owner')), null), [
    'amountLookup',
    'numberLookup',
    'relatedLookup',
  ]);
  assert.deepEqual(requiredLookups('statement', document(statement()), matched), [
    'amountLookup',
    'numberLookup',
  ]);
  assert.deepEqual(
    requiredLookups('statement', document(statement({ listedItems: [] })), matched),
    ['amountLookup'],
  );
});
