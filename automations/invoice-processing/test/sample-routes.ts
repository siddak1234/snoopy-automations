/**
 * Each made-up sample's route through check-document — or the rule that stops it — and what it
 * hands decide, as its expected.json's `next` says: the expected answers are held to it, and so
 * is every recorded answer.
 */

/** Each sample's route, or the rule that stops it, and what it hands decide (the samples' `next`). */
export const SAMPLE_ROUTES: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  'typed-text-pdf': ['bill', []],
  'scanned-image-pdf': ['bill', []],
  'phone-photo-jpeg': ['bill', []],
  'png-screenshot': ['bill', []],
  'handwritten-png': ['bill', []],
  'long-300-lines': ['bill', []],
  receipt: ['company_receipt', []],
  'two-invoices': ['C5', []],
  'missing-page': ['C6', []],
  'injected-instructions': ['bill', []],
  'store-receipt': ['company_receipt', []],
  'restaurant-tip-written-total': ['company_receipt', []],
  'restaurant-tip-under-total': ['company_receipt', ['tip_added']],
  'card-slip-tip-only': ['C28', []],
  'card-slip': ['company_receipt', []],
  'handwritten-cash-receipt': ['company_receipt', ['not_cross_checked']],
  'long-thermal-receipt': ['company_receipt', []],
  'cash-back-receipt': ['C16', []],
  'paid-invoice': ['company_receipt', []],
  'credit-memo': ['vendor_credit', []],
  'card-refund': ['card_refund', []],
  'utility-statement-balance': ['bill', ['earlier_balance']],
  'utility-account-number': ['bill', []],
  'supplier-statement': ['statement', []],
  'bank-card-statement': ['C1', []],
};
