import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeOf } from '../src/checks/route.js';
import { DOCUMENT_TYPES, REFUND_METHODS } from '../src/document.js';
import { checkedSummary } from '../src/steps/check-document.js';
import {
  PAYERS,
  bill,
  check,
  creditNote,
  documentOf,
  paidBy,
  receipt,
  ruleOf,
  statement,
} from './check-world.js';

/**
 * The routing table (the plan's §2.1, §2.9 "Routing"): every document type, with the switch off
 * and on for each payer route, gives the expected path or its exact fail rule.
 */

const ON = Object.keys(PAYERS) as (keyof typeof PAYERS)[];
const PERSONAL = { owner: 'owner', employee: 'employee', not_employee: 'contractor' } as const;

/** What a route of each kind is, with the rule that ends it otherwise. */
function routeOrRule(answer: object, options = {}): string {
  const outcome = check(answer, options);
  return outcome.outcome === 'ok' ? outcome.document.route : outcome.rule;
}

test('a bill: a Bill with the switch off; with it on, the paid-personally record find-payer chose', () => {
  assert.equal(routeOrRule(bill()), 'bill');
  for (const payer of ON) assert.equal(routeOrRule(bill(), paidBy(payer)), PERSONAL[payer], payer);
});

test('a receipt: an expense from Paid from with the switch off; with it on, the paid-personally record', () => {
  assert.equal(routeOrRule(receipt()), 'company_receipt');
  for (const payer of ON) {
    assert.equal(routeOrRule(receipt(), paidBy(payer, { paidFrom: null })), PERSONAL[payer], payer);
  }
});

test('a credit note: a vendor credit, a card refund for a refund to a card, C19 by check or cash; C7 with the switch on', () => {
  const expected: Record<(typeof REFUND_METHODS)[number], string> = {
    credit_on_account: 'vendor_credit',
    not_shown: 'vendor_credit',
    not_applicable: 'vendor_credit',
    refund_to_card: 'card_refund',
    refund_by_check_or_cash: 'C19',
  };
  for (const method of REFUND_METHODS) {
    assert.equal(routeOrRule(creditNote({ refundMethod: method })), expected[method], method);
    for (const payer of ON) {
      assert.equal(routeOrRule(creditNote({ refundMethod: method }), paidBy(payer)), 'C7', payer);
    }
  }
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

test("a supplier statement: compared only, the switch ignored — its line says the switch doesn't apply", () => {
  assert.equal(routeOrRule(statement()), 'statement');
  for (const payer of ON) assert.equal(routeOrRule(statement(), paidBy(payer)), 'statement', payer);
  const on = documentOf(check(statement(), paidBy('employee')));
  assert.match(checkedSummary(on, true), /a supplier statement \(the switch doesn't apply\)/u);
  assert.doesNotMatch(checkedSummary(on, false), /switch/u);
});

test('a bank or card statement, a quote, an order or anything else fails, the switch on or off', () => {
  const rules = { bank_statement: 'C1', quote: 'C2', purchase_order: 'C3', other: 'C4' } as const;
  for (const [type, rule] of Object.entries(rules)) {
    assert.equal(ruleOf(check(bill({ documentType: type }))), rule, type);
    for (const payer of ON) {
      assert.equal(ruleOf(check(bill({ documentType: type }), paidBy(payer))), rule, type);
    }
  }
  // Every type is one of the eight, and each has its row.
  assert.equal(DOCUMENT_TYPES.length, 8);
});

test('the routing table itself: the switch off ignores who paid; on, a payer is required', () => {
  assert.equal(routeOf('bill', false, PAYERS.owner, 'not_applicable'), 'bill');
  assert.equal(routeOf('receipt', false, null, 'not_applicable'), 'company_receipt');
  assert.equal(routeOf('supplier_statement', true, PAYERS.employee, 'not_applicable'), 'statement');
  assert.equal(routeOf('credit_note', false, null, 'refund_to_card'), 'card_refund');
  assert.throws(() => routeOf('receipt', true, null, 'not_applicable'), /kept no payer/u);
});
