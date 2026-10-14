import type { KeptType, RefundMethod, Route } from '../document.js';

/**
 * The routing table (the plan's §2.1, as v2 keeps it): what a document becomes, by read 1's type.
 *
 * | Read 1 says        | Route                                         |
 * | bill               | bill                                          |
 * | receipt            | company_receipt (an expense from a bank or card) |
 * | credit_note        | vendor_credit; card_refund for a card refund  |
 * | supplier_statement | statement (compare only)                      |
 *
 * A bank statement, a quote, an order or anything else fails (C1–C4) before the route is used.
 */
export function routeOf(type: KeptType, refundMethod: RefundMethod): Route {
  if (type === 'supplier_statement') return 'statement';
  if (type === 'credit_note') {
    return refundMethod === 'refund_to_card' ? 'card_refund' : 'vendor_credit';
  }
  return type === 'bill' ? 'bill' : 'company_receipt';
}
