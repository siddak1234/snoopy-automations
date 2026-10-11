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

/** How a credit note gives the credit back (D25); `not_applicable` on any other document. */
export const REFUND_METHODS = [
  'credit_on_account',
  'refund_to_card',
  'refund_by_check_or_cash',
  'not_shown',
  'not_applicable',
] as const;

/** What a row a document lists is: a statement's rows, or the earlier invoices a bill lists. */
export const LISTED_KINDS = ['invoice', 'payment', 'credit', 'balance_forward'] as const;

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
