import type { KeptType, RefundMethod, Route } from '../document.js';
import type { PayerState } from '../state.js';

/**
 * The routing table (the plan's §2.1, in the automation as §2.11 asks): what a document becomes,
 * by read 1's type, the switch "I paid for this with my own money" and who paid.
 *
 * | Read 1 says        | Switch off                                  | Switch on                       |
 * | bill               | bill                                        | the paid-personally record      |
 * | receipt            | company_receipt (an expense from Paid from) | the paid-personally record      |
 * | credit_note        | vendor_credit; card_refund for a card       | fails, C7                       |
 * | supplier_statement | statement (compare only)                    | statement; the switch ignored   |
 *
 * The paid-personally record follows find-payer: an owner from the settings, an employee, or —
 * neither — a contractor, whom find-vendor looks up among vendors (V1 when nobody). A credit
 * refunded by check or cash fails (C19), and a bank statement, a quote, an order or anything else
 * fails (C1–C4), before the route is used: the fail rules come first, in their order.
 */
export function routeOf(
  type: KeptType,
  switchOn: boolean,
  payer: Pick<PayerState, 'route'> | null,
  refundMethod: RefundMethod,
): Route {
  if (type === 'supplier_statement') return 'statement';
  if (type === 'credit_note')
    return refundMethod === 'refund_to_card' ? 'card_refund' : 'vendor_credit';
  if (!switchOn) return type === 'bill' ? 'bill' : 'company_receipt';
  // find-payer keeps who paid whenever the switch is on (P1 refuses no name): never a silent company record.
  if (payer === null) throw new Error('the switch is on, and find-payer kept no payer');
  if (payer.route === 'owner') return 'owner';
  return payer.route === 'employee' ? 'employee' : 'contractor';
}
