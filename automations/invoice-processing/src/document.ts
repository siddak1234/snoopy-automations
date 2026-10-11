/**
 * The values the AI's answer may hold where the prompt gives it a list
 * (`prompts/extract-document.v1.json`, the owner's plan of 2026-10-11, §4): a test holds
 * the prompt's schema to these, and `extract` holds an answer to them.
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
 * What a document becomes (the plan's §2.1): `check-document` routes it by read 1's type, the
 * switch "I paid for this with my own money" and who paid.
 *
 * - `bill`: a Bill, owed to the supplier through accounts payable.
 * - `company_receipt`: an expense (Intuit's Purchase) from the "Paid from" bank or card account.
 * - `card_refund`: an expense with `Credit` true on the "Paid from" card account.
 * - `vendor_credit`: a vendor credit for an existing vendor.
 * - `statement`: a supplier's statement, compared with QuickBooks and never recorded.
 * - `employee`, `owner`: a journal entry — the cost to its category, the money owed to the
 *   employee on "Owed to team members", or invested by the owner on their equity account.
 * - `contractor`: a bill payable to the person who paid, found among vendors by find-vendor.
 */
export const ROUTES = [
  'bill',
  'company_receipt',
  'card_refund',
  'vendor_credit',
  'statement',
  'employee',
  'owner',
  'contractor',
] as const;
export type Route = (typeof ROUTES)[number];

/** The routes where someone paid with their own money: each always waits for approval (D16). */
export const PAID_PERSONALLY: ReadonlySet<Route> = new Set(['employee', 'owner', 'contractor']);

/** The answer's 27 fields, in the schema's order. */
export const ANSWER_FIELDS = [
  'documentType',
  'documentCount',
  'pagesMissing',
  'vendorName',
  'documentNumber',
  'documentDate',
  'dueDate',
  'paymentTermsDays',
  'currency',
  'subtotal',
  'tax',
  'shipping',
  'discount',
  'total',
  'amountDue',
  'tip',
  'cashBackPrinted',
  'paymentMethod',
  'cardLast4',
  'refundMethod',
  'originalInvoiceNumber',
  'spendType',
  'lineItems',
  'lineItemsComplete',
  'listedItems',
  'listedItemsComplete',
  'uncertainFields',
] as const;
