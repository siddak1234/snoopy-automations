import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeOf } from '../src/checks/route.js';
import { DOCUMENT_TYPES, REFUND_METHODS } from '../src/document.js';
import { checkedSummary } from '../src/steps/check-document.js';
import {
  NONE_PATH,
  bill,
  check,
  creditNote,
  documentOf,
  receipt,
  ruleOf,
  statement,
} from './check-world.js';

/**
 * The routing table (the plan's §2.1, as v2 keeps it — no "I paid with my own money", the session's
 * decision 4): every document type gives the expected path, the vendor QuickBooks or "None", or the
 * exact rule that ends it.
 */

/** What a route of each kind is, with the rule that ends it otherwise. */
function routeOrRule(answer: object, options = {}): string {
  const outcome = check(answer, options);
  if (outcome.outcome === 'failed') return outcome.rule;
  return outcome.recordingRule ?? outcome.document.route;
}

test('a bill is a Bill, a receipt an expense, on either path', () => {
  for (const options of [{}, NONE_PATH]) {
    assert.equal(routeOrRule(bill(), options), 'bill');
    assert.equal(routeOrRule(receipt(), options), 'company_receipt');
  }
});

test('a credit note: a vendor credit, a card refund for a refund to a card; by check or cash, C19 — which QuickBooks alone cannot take', () => {
  const expected: Record<(typeof REFUND_METHODS)[number], string> = {
    credit_on_account: 'vendor_credit',
    not_shown: 'vendor_credit',
    not_applicable: 'vendor_credit',
    refund_to_card: 'card_refund',
    refund_by_check_or_cash: 'C19',
  };
  for (const method of REFUND_METHODS) {
    assert.equal(routeOrRule(creditNote({ refundMethod: method })), expected[method], method);
  }
  assert.equal(
    routeOrRule(creditNote({ refundMethod: 'refund_by_check_or_cash' }), NONE_PATH),
    'vendor_credit',
    'with "None" the details are kept',
  );
  // Not shown, or a value only another document has: recorded as a vendor credit, and held.
  for (const method of ['not_shown', 'not_applicable']) {
    assert.ok(
      documentOf(check(creditNote({ refundMethod: method }))).findings.includes(
        'refund_method_not_shown',
      ),
    );
  }
  assert.ok(
    !documentOf(check(creditNote())).findings.includes('refund_method_not_shown'),
    'credit on account',
  );
});

test('a supplier statement: compared only, its checks passed', () => {
  assert.equal(routeOrRule(statement()), 'statement');
  assert.equal(checkedSummary(documentOf(check(statement()))), 'Checks passed');
});

test('a bank or card statement, a quote, an order or anything else fails, on either path', () => {
  const rules = { bank_statement: 'C1', quote: 'C2', purchase_order: 'C3', other: 'C4' } as const;
  for (const [type, rule] of Object.entries(rules)) {
    assert.equal(ruleOf(check(bill({ documentType: type }))), rule, type);
    assert.equal(ruleOf(check(bill({ documentType: type }), NONE_PATH)), rule, type);
  }
  // Every type is one of the eight, and each has its row.
  assert.equal(DOCUMENT_TYPES.length, 8);
});

test('the routing table itself', () => {
  assert.equal(routeOf('bill', 'not_applicable'), 'bill');
  assert.equal(routeOf('receipt', 'not_applicable'), 'company_receipt');
  assert.equal(routeOf('supplier_statement', 'not_applicable'), 'statement');
  assert.equal(routeOf('credit_note', 'refund_to_card'), 'card_refund');
  assert.equal(routeOf('credit_note', 'credit_on_account'), 'vendor_credit');
});
