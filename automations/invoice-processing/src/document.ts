/**
 * The values v2's checks read where the prompt gives a list (the owner's plan of 2026-10-11, §4);
 * v3's prompt (`prompts/extract-documents.v1.json`) gives the same lists, which a test holds it
 * to, its document types in `src/run/answer.ts`.
 */

/** What the document is; it chooses the record (the plan's §2.1). */
export const DOCUMENT_TYPES = [
  'bill',
  'receipt',
  'credit_note',
  'supplier_statement',
  'bank_statement',
  'quote',
  'purchase_order',
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** How a receipt was paid (D18); never empty: `not_shown` when nothing says. */
export const PAYMENT_METHODS = [
  'card',
  'cash',
  'check',
  'bank_transfer',
  'other',
  'not_shown',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** How a credit note gives the credit back (D25); `not_applicable` on any other document. */
export const REFUND_METHODS = [
  'credit_on_account',
  'refund_to_card',
  'refund_by_check_or_cash',
  'not_shown',
  'not_applicable',
] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** What a row a document lists is: a statement's rows, or the earlier invoices a bill lists. */
export const LISTED_KINDS = ['invoice', 'payment', 'credit', 'balance_forward'] as const;
export type ListedKind = (typeof LISTED_KINDS)[number];

/** The document types this automation records or compares; every other type fails (C1–C4). */
export const KEPT_TYPES = ['bill', 'receipt', 'credit_note', 'supplier_statement'] as const;
export type KeptType = (typeof KEPT_TYPES)[number];

/**
 * What a document becomes (the plan's §2.1): `check-document` routes it by read 1's type, and for
 * a credit note how it is given back. v2 has no "I paid with my own money" (the session's decision
 * 4, approved in advance by the owner's "approve. complete", 2026-10-14): it returns with the
 * platform's run starter (26.2.4).
 *
 * - `bill`: a Bill, owed to the supplier through accounts payable.
 * - `company_receipt`: an expense (Intuit's Purchase) from the bank or card account picked from
 *   the company's accounts (decision 1).
 * - `card_refund`: an expense with `Credit` true on a card account.
 * - `vendor_credit`: a vendor credit for an existing vendor.
 * - `statement`: a supplier's statement, compared with QuickBooks and never recorded.
 *
 * With the vendor "None" the route only names what the document is: nothing is recorded.
 */
export const ROUTES = [
  'bill',
  'company_receipt',
  'card_refund',
  'vendor_credit',
  'statement',
] as const;
export type Route = (typeof ROUTES)[number];
