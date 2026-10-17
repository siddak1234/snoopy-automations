import {
  MAXIMUM_NAME_LENGTH,
  MAXIMUM_NUMBER_LENGTH,
  addDays,
  sameName,
} from '@autom8x/automation-kit/values';

import type { NotRecordedReason } from '../quickbooks-path.js';
import { dueBelowCharges, overMaximum, type Amounts } from './arithmetic.js';
import type { Cleaned } from './clean.js';

/**
 * The checks' rules (the plan's §2.3, C1–C28 as v2 kept them — C7, C18, C20 and C27 left with the
 * settings and "I paid with my own money"), in two kinds (v2's §2.6, as v3 changes it):
 *
 * - **the document cannot be used as read** — C6, C8, C11, C21, C22, C26 — which in v2 failed the
 *   run, and in v3 hold only this document for a second read, then for review (the session's spec,
 *   B4): one document never fails the others. C1–C5 are gone: a bank statement, a quote, an order
 *   or any other financial document is kept with all its data (the owner's AM8, 2026-10-15), and a
 *   file holds as many documents as it holds (AM1) — C5's "Add one document per file." failed the
 *   owner's photo of three receipts (run 793eef82, 2026-10-15);
 * - **QuickBooks cannot record it** — every other rule — which applies on the QuickBooks path
 *   alone: the document is not recorded, its details are saved, and its result says why (v2's S2).
 *   With the vendor "None" nothing is recorded, so none of them is weighed.
 *
 * The first of each kind that applies, in the plan's order, wins. Nothing here carries text from
 * the document.
 */

/** The rules a document cannot be used under as read, on either path: each holds it (B4). */
export const DOCUMENT_RULES = ['C6', 'C8', 'C11', 'C21', 'C22', 'C26'] as const;

export type DocumentRule = (typeof DOCUMENT_RULES)[number];

/** The rules QuickBooks cannot record a document under, each with its reason (§3.F). */
export const RECORDING_RULES = {
  C9: 'vendor_name_too_long',
  C10: 'own_company',
  C12: 'total_zero',
  C13: 'total_too_large',
  C14: 'number_too_long',
  C15: 'part_paid',
  C16: 'cash_back',
  C17: 'still_owed',
  C19: 'refunded_by_check',
  C23: 'future_date',
  C24: 'due_date_unreadable',
  C25: 'due_before_date',
  C28: 'tip_unclear',
} as const satisfies Readonly<Record<string, NotRecordedReason>>;

export type RecordingRule = keyof typeof RECORDING_RULES;
export type CheckRule = DocumentRule | RecordingRule;

/** What the rules weigh besides the cleaned read. */
export interface RuleContext {
  readonly cleaned: Cleaned;
  /** The QuickBooks company's names, for C10; null with the vendor "None", where it is not weighed. */
  readonly companyName: string | null;
  readonly legalName: string | null;
  /** The run's UTC date. */
  readonly today: string;
  /** The arithmetic of a record's total, once it is in whole cents; null before, and on a statement. */
  readonly amounts: Amounts | null;
}

const RECORDS = new Set(['bill', 'receipt', 'credit_note']);

/** Every rule, each its condition, in the plan's order. */
const RULES: readonly (readonly [CheckRule, (context: RuleContext) => boolean])[] = [
  ['C6', ({ cleaned }) => cleaned.read.pagesMissing],
  ['C8', ({ cleaned }) => cleaned.seller === null],
  ['C9', ({ cleaned }) => (cleaned.seller?.length ?? 0) > MAXIMUM_NAME_LENGTH],
  [
    'C10',
    ({ cleaned, companyName, legalName }) =>
      (companyName !== null && sameName(cleaned.seller, companyName)) ||
      (legalName !== null && sameName(cleaned.seller, legalName)),
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
    'C19',
    ({ cleaned }) => isCredit(cleaned) && cleaned.read.refundMethod === 'refund_by_check_or_cash',
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

const DOCUMENT: ReadonlySet<string> = new Set(DOCUMENT_RULES);

/** The first rule the document cannot be used under, in the plan's order; undefined when none applies. */
export function failedRule(context: RuleContext): DocumentRule | undefined {
  return RULES.find(([rule, applies]) => DOCUMENT.has(rule) && applies(context))?.[0] as
    DocumentRule | undefined;
}

/** The first rule QuickBooks cannot record the document under; undefined when none applies. */
export function recordingRule(context: RuleContext): RecordingRule | undefined {
  return RULES.find(([rule, applies]) => !DOCUMENT.has(rule) && applies(context))?.[0] as
    RecordingRule | undefined;
}

/** Every rule in its order: the list a test holds to the plan. */
export const CHECK_RULE_ORDER: readonly CheckRule[] = RULES.map(([rule]) => rule);
