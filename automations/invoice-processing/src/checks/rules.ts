import {
  MAXIMUM_NAME_LENGTH,
  MAXIMUM_NUMBER_LENGTH,
  addDays,
  sameName,
} from '@autom8x/automation-kit/values';

import type { AccountRef } from '../state.js';
import { dueBelowCharges, overMaximum, type Amounts } from './arithmetic.js';
import type { Cleaned } from './clean.js';

/**
 * `check-document`'s fail rules (the plan's §2.3, C1–C28): the first match wins and nothing is
 * created. Each sentence is the plan's, ends "Nothing was created.", is at most 200 characters and
 * never carries text from the document.
 */

export const CHECK_DOCUMENT_SENTENCES = {
  C1: 'This looks like a bank or card statement. Upload each receipt or bill on its own, and use the statement to reconcile in QuickBooks. Nothing was created.',
  C2: 'This looks like a quote, not a bill or a receipt. Nothing was created.',
  C3: 'This looks like a purchase order, not a bill or a receipt. Nothing was created.',
  C4: "This doesn't look like a bill, receipt, credit note or statement. Nothing was created.",
  C5: 'This file holds no document or more than one. Upload one bill, receipt, credit note or statement per run. Nothing was created.',
  C6: 'Pages of this document are missing. Upload the whole document as one file. Nothing was created.',
  C7: "A credit note can't be marked as paid with your own money. Run it again with that switched off. Nothing was created.",
  C8: "The seller's name could not be read. Try a clearer photo or the PDF. Nothing was created.",
  C9: "The seller's name is longer than QuickBooks allows. Enter this by hand. Nothing was created.",
  C10: 'This document was issued by your own company, so there is nothing to record. Nothing was created.',
  C11: 'The total could not be read. Try a clearer photo or the PDF. Nothing was created.',
  C12: 'The total is zero or less, so there is nothing to record. Nothing was created.',
  C13: 'The total is larger than QuickBooks accepts. Nothing was created.',
  C14: 'The document number could not be read cleanly. Try a clearer photo or the PDF. Nothing was created.',
  C15: "The amount due is less than this bill's charges, so some or all of it may already be paid or credited. Enter it by hand. Nothing was created.",
  C16: "This receipt includes cash back, which isn't an expense. Enter it by hand in QuickBooks. Nothing was created.",
  C17: "This receipt shows an amount still owed, so it isn't fully paid. Enter it by hand. Nothing was created.",
  C18: "Set 'Paid from' in this flow's settings before recording a receipt the company paid, then run it again. Nothing was created.",
  C19: 'This credit was refunded by check or cash. Enter it by hand: a bank deposit for an expense, or for a paid bill a vendor credit plus a deposit to A/P, linked in Pay bills. Nothing was created.',
  C20: "This is a refund to a card, but 'Paid from' isn't a credit card account. Enter it by hand in QuickBooks. Nothing was created.",
  C21: "The document's date could not be read. Try a clearer photo or the PDF. Nothing was created.",
  C22: "The document's date is not a valid date. Try a clearer photo or the PDF. Nothing was created.",
  C23: 'The document is dated in the future. Nothing was created.',
  C24: 'The due date is not a valid date. Try a clearer photo or the PDF. Nothing was created.',
  C25: "The due date is before the bill's date. Nothing was created.",
  C26: 'Nothing on this statement could be read. Try a clearer photo or the PDF. Nothing was created.',
  C27: "The name in 'Who paid' is the seller on this document. Type the name of the person who paid, then run it again. Nothing was created.",
  C28: 'A tip is written on this receipt, and nothing on it shows whether the total includes it. Write the final total on it, then upload it again. Nothing was created.',
} as const;

export type CheckRule = keyof typeof CHECK_DOCUMENT_SENTENCES;

/** Each rule's word for the timeline. */
export const CHECK_DOCUMENT_REASONS: Readonly<Record<CheckRule, string>> = {
  C1: 'bank_statement',
  C2: 'quote',
  C3: 'purchase_order',
  C4: 'not_a_document',
  C5: 'document_count_not_one',
  C6: 'pages_missing',
  C7: 'credit_note_paid_personally',
  C8: 'seller_missing',
  C9: 'seller_name_too_long',
  C10: 'own_company_document',
  C11: 'total_missing',
  C12: 'total_not_positive',
  C13: 'total_too_large',
  C14: 'document_number_too_long',
  C15: 'amount_due_below_charges',
  C16: 'cash_back',
  C17: 'balance_still_owed',
  C18: 'paid_from_missing',
  C19: 'refund_by_check_or_cash',
  C20: 'refund_card_not_paid_from',
  C21: 'date_missing',
  C22: 'date_invalid',
  C23: 'date_in_future',
  C24: 'due_date_invalid',
  C25: 'due_date_before_date',
  C26: 'statement_unreadable',
  C27: 'payer_is_seller',
  C28: 'tip_unclear',
};

/** What the rules weigh besides the cleaned read. */
export interface RuleContext {
  readonly cleaned: Cleaned;
  /** "I paid for this with my own money". */
  readonly switchOn: boolean;
  /** Who paid, as find-payer kept the name; null when the company paid. */
  readonly payerName: string | null;
  readonly paidFrom: AccountRef | null;
  readonly companyName: string;
  readonly legalName: string | null;
  /** The run's UTC date. */
  readonly today: string;
  /** The arithmetic of a record's total, once it is in whole cents; null before, and on a statement. */
  readonly amounts: Amounts | null;
}

const RECORDS = new Set(['bill', 'receipt', 'credit_note']);

/** C1–C28, each its condition, in the plan's order. */
const RULES: readonly (readonly [CheckRule, (context: RuleContext) => boolean])[] = [
  ['C1', ({ cleaned }) => cleaned.read.documentType === 'bank_statement'],
  ['C2', ({ cleaned }) => cleaned.read.documentType === 'quote'],
  ['C3', ({ cleaned }) => cleaned.read.documentType === 'purchase_order'],
  ['C4', ({ cleaned }) => cleaned.read.documentType === 'other'],
  ['C5', ({ cleaned }) => cleaned.read.documentCount !== 1],
  ['C6', ({ cleaned }) => cleaned.read.pagesMissing],
  ['C7', ({ cleaned, switchOn }) => cleaned.read.documentType === 'credit_note' && switchOn],
  ['C8', ({ cleaned }) => cleaned.seller === null],
  ['C9', ({ cleaned }) => (cleaned.seller?.length ?? 0) > MAXIMUM_NAME_LENGTH],
  [
    'C10',
    ({ cleaned, companyName, legalName }) =>
      sameName(cleaned.seller, companyName) || sameName(cleaned.seller, legalName),
  ],
  ['C11', ({ cleaned }) => records(cleaned) && cleaned.total.kind === 'none'],
  [
    'C12',
    ({ cleaned }) =>
      records(cleaned) &&
      ((cleaned.total.kind === 'out_of_range' && cleaned.total.negative) ||
        (cleaned.total.kind === 'cents' && cleaned.total.cents <= 0)),
  ],
  [
    'C13',
    ({ cleaned, amounts }) =>
      records(cleaned) &&
      (cleaned.total.kind === 'out_of_range' ||
        (cleaned.total.kind === 'cents' &&
          amounts !== null &&
          overMaximum(cleaned.total.cents, amounts))),
  ],
  [
    'C14',
    ({ cleaned }) => records(cleaned) && (cleaned.number?.length ?? 0) > MAXIMUM_NUMBER_LENGTH,
  ],
  [
    'C15',
    ({ cleaned }) =>
      isBill(cleaned) &&
      cleaned.total.kind === 'cents' &&
      dueBelowCharges('bill', cleaned.total.cents, cleaned.amountDueCents),
  ],
  ['C16', ({ cleaned }) => isReceipt(cleaned) && cleaned.read.cashBackPrinted],
  ['C17', ({ cleaned }) => isReceipt(cleaned) && (cleaned.amountDueCents ?? 0) > 0],
  [
    'C18',
    ({ cleaned, switchOn, paidFrom }) => isReceipt(cleaned) && !switchOn && paidFrom === null,
  ],
  [
    'C19',
    ({ cleaned }) => isCredit(cleaned) && cleaned.read.refundMethod === 'refund_by_check_or_cash',
  ],
  [
    'C20',
    ({ cleaned, paidFrom }) =>
      isCredit(cleaned) &&
      cleaned.read.refundMethod === 'refund_to_card' &&
      paidFrom?.accountType !== 'Credit Card',
  ],
  ['C21', ({ cleaned }) => records(cleaned) && cleaned.date.kind === 'none'],
  ['C22', ({ cleaned }) => records(cleaned) && cleaned.date.kind === 'invalid'],
  [
    'C23',
    ({ cleaned, today }) =>
      records(cleaned) && cleaned.date.kind === 'date' && cleaned.date.date > addDays(today, 1),
  ],
  ['C24', ({ cleaned }) => isBill(cleaned) && cleaned.dueDate.kind === 'invalid'],
  [
    'C25',
    ({ cleaned }) =>
      isBill(cleaned) &&
      cleaned.dueDate.kind === 'date' &&
      cleaned.date.kind === 'date' &&
      cleaned.dueDate.date < cleaned.date.date,
  ],
  [
    'C26',
    ({ cleaned }) =>
      cleaned.statement !== null &&
      cleaned.statement.rows.length === 0 &&
      cleaned.total.kind === 'none',
  ],
  [
    'C27',
    ({ cleaned, switchOn, payerName }) =>
      switchOn && (isBill(cleaned) || isReceipt(cleaned)) && sameName(payerName, cleaned.seller),
  ],
  ['C28', ({ cleaned, amounts }) => isReceipt(cleaned) && amounts?.tip === 'unknown'],
];

function records(cleaned: Cleaned): boolean {
  return RECORDS.has(cleaned.read.documentType);
}
function isBill(cleaned: Cleaned): boolean {
  return cleaned.read.documentType === 'bill';
}
function isReceipt(cleaned: Cleaned): boolean {
  return cleaned.read.documentType === 'receipt';
}
function isCredit(cleaned: Cleaned): boolean {
  return cleaned.read.documentType === 'credit_note';
}

/** The first fail rule that applies, in the plan's order; undefined when none does. */
export function failedRule(context: RuleContext): CheckRule | undefined {
  return RULES.find(([, applies]) => applies(context))?.[0];
}

/** Every rule in its order: the list a test holds to the plan. */
export const CHECK_RULE_ORDER: readonly CheckRule[] = RULES.map(([rule]) => rule);
