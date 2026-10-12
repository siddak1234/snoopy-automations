import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { VendorState } from '../src/decide/contract.js';
import { lookupUses, requiredLookups } from '../src/decide/lookup-uses.js';
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
import { VENDOR, decideState } from './decide-world.js';

/**
 * The lookups' table, shared by the steps and decide (`lookupUses`, Group 4's change to the
 * contract): per route, each lookup runs, says "Not checked" (no number QuickBooks could hold —
 * the document's own, a credit's original, or every one a statement lists: G4-4), or is skipped; a
 * vendor credit's or a statement's vendor not in QuickBooks skips them all, so decide reaches F5 or
 * F6 rather than "could not finish its checks"; S4's fallback drops a bill's D32 lookup.
 */

const doc = (answer: JsonObject, options = {}) => documentOf(check(answer, options));
const NEW: VendorState = { status: 'new' };
const uses = (number: string, amount: string, related: string, otherRecord: string) => ({
  numberLookup: number,
  amountLookup: amount,
  relatedLookup: related,
  otherRecordLookup: otherRecord,
});

test('per route, under D21: run, "Not checked" for a number QuickBooks could not hold, or skip', () => {
  assert.deepEqual(lookupUses('bill', doc(bill()), VENDOR), uses('run', 'run', 'run', 'run'));
  for (const number of [null, 'N'.repeat(22)]) {
    assert.deepEqual(
      lookupUses('bill', doc(bill({ documentNumber: number })), NEW),
      uses('not_checked', 'run', 'not_checked', 'run'),
    );
  }
  assert.deepEqual(
    lookupUses('company_receipt', doc(receipt()), VENDOR),
    uses('run', 'run', 'run', 'run'),
  );
  assert.deepEqual(
    lookupUses('company_receipt', doc(receipt({ documentNumber: null })), VENDOR),
    uses('not_checked', 'run', 'run', 'run'),
  );
  assert.deepEqual(
    lookupUses('company_receipt', doc(receipt()), NEW),
    uses('skip', 'run', 'run', 'run'),
  );
  const refund = doc(sampleAnswer('card-refund'));
  assert.deepEqual(lookupUses('card_refund', refund, VENDOR), uses('run', 'run', 'run', 'skip'));
  assert.deepEqual(lookupUses('card_refund', refund, NEW), uses('run', 'run', 'skip', 'skip'));
  assert.deepEqual(
    lookupUses('vendor_credit', doc(creditNote()), VENDOR),
    uses('run', 'run', 'run', 'skip'),
  );
  assert.deepEqual(
    lookupUses('vendor_credit', doc(creditNote({ originalInvoiceNumber: null })), VENDOR),
    uses('run', 'run', 'skip', 'skip'),
  );
  assert.deepEqual(
    lookupUses('employee', doc(receipt(), paidBy('employee', { paidFrom: null })), null),
    uses('skip', 'run', 'run', 'skip'),
  );
  assert.deepEqual(
    lookupUses(
      'owner',
      doc(bill({ documentNumber: null }), paidBy('owner', { paidFrom: null })),
      null,
    ),
    uses('not_checked', 'run', 'run', 'skip'),
  );
  assert.deepEqual(
    lookupUses('statement', doc(statement()), VENDOR),
    uses('run', 'run', 'skip', 'skip'),
  );
});

test('a number QuickBooks could not hold is never sent: a credit\'s original invoice number past 21 characters is "Not checked", and a statement whose every listed number is says so too (G4-4)', () => {
  for (const [length, use] of [
    [21, 'run'],
    [22, 'not_checked'],
  ] as const) {
    const original = 'O'.repeat(length);
    assert.deepEqual(
      lookupUses('vendor_credit', doc(creditNote({ originalInvoiceNumber: original })), VENDOR),
      uses('run', 'run', use, 'skip'),
      `vendor credit, ${length}`,
    );
    const refund = doc(sampleAnswer('card-refund', { originalInvoiceNumber: original }));
    assert.deepEqual(
      lookupUses('card_refund', refund, VENDOR),
      uses('run', 'run', use, 'skip'),
      `card refund, ${length}`,
    );
    // No vendor to search: skipped, whatever its length.
    assert.deepEqual(lookupUses('card_refund', refund, NEW), uses('run', 'run', 'skip', 'skip'));
  }
  assert.deepEqual(
    requiredLookups(
      'vendor_credit',
      doc(creditNote({ originalInvoiceNumber: 'O'.repeat(22) })),
      VENDOR,
    ),
    ['amountLookup', 'numberLookup'],
  );
  const listing = (...references: string[]) =>
    doc(
      statement({
        listedItems: references.map((reference) => ({ reference, amount: 10, kind: 'invoice' })),
        total: 10 * references.length,
      }),
    );
  // One a bill's number could be is enough to search: the longer ones are left out of it.
  assert.deepEqual(
    lookupUses('statement', listing('L'.repeat(22), 'HOS-1031'), VENDOR),
    uses('run', 'run', 'skip', 'skip'),
  );
  assert.deepEqual(
    lookupUses('statement', listing('L'.repeat(22), 'M'.repeat(30)), VENDOR),
    uses('not_checked', 'run', 'skip', 'skip'),
  );
  assert.deepEqual(requiredLookups('statement', listing('L'.repeat(22)), VENDOR), ['amountLookup']);
});

test("a seller not linked is a seller with no vendor: a receipt's number lookup and a card refund's original bill are skipped", () => {
  const notLinked: VendorState = {
    status: 'not_linked',
    reason: 'ambiguous',
    matchedBy: 'display name',
  };
  assert.deepEqual(
    lookupUses('company_receipt', doc(receipt()), notLinked),
    lookupUses('company_receipt', doc(receipt()), NEW),
  );
  assert.deepEqual(
    lookupUses('card_refund', doc(sampleAnswer('card-refund')), notLinked),
    uses('run', 'run', 'skip', 'skip'),
  );
});

test("a vendor credit's or a statement's vendor not in QuickBooks: nothing runs, and decide fails F5 or F6", () => {
  const none = uses('skip', 'skip', 'skip', 'skip');
  assert.deepEqual(lookupUses('vendor_credit', doc(creditNote()), NEW), none);
  assert.deepEqual(lookupUses('statement', doc(statement()), NEW), none);
  assert.deepEqual(requiredLookups('statement', doc(statement()), NEW), []);
  for (const [answer, rule] of [
    [creditNote(), 'F5'],
    [statement(), 'F6'],
  ] as const) {
    const decision = decideRun({
      state: decideState({ answer, vendor: NEW }),
      config: {},
      switchOn: false,
    });
    assert.deepEqual(decision, {
      outcome: 'failed',
      failure: rule,
      sentence: DECIDE_SENTENCES[rule],
    });
  }
});

test("S4's fallback drops a bill's D32 lookup, and decide then needs it not; nothing else changes", () => {
  assert.deepEqual(
    lookupUses('bill', doc(bill()), VENDOR, 'window'),
    uses('run', 'run', 'run', 'skip'),
  );
  assert.deepEqual(requiredLookups('bill', doc(bill()), VENDOR, 'window'), [
    'amountLookup',
    'numberLookup',
    'relatedLookup',
  ]);
  assert.deepEqual(
    lookupUses('company_receipt', doc(receipt()), VENDOR, 'window'),
    lookupUses('company_receipt', doc(receipt()), VENDOR, 'amount'),
  );
  const { otherRecordLookup: _dropped, ...state } = decideState({ answer: bill() });
  const run = (expenseSearch: 'amount' | 'window') =>
    decideRun({ state, config: {}, switchOn: false, expenseSearch }).outcome;
  assert.equal(run('window'), 'ok');
  assert.equal(run('amount'), 'failed', 'under D21 its absence is "could not finish its checks"');
});
