import { truncateText, type RunDetail } from '@autom8x/automation-sdk';

import type { SavedState } from './decide/saved.js';
import type { StatementResult } from './decide/statement.js';
import type { KeptType, PaymentMethod } from './document.js';
import type { SpendType } from './spend-types.js';
import type { DocumentState } from './state.js';
import {
  RECORD_WORDS,
  SPEND_TYPE_WORDS,
  TYPE_WORDS,
  dayWords,
  money,
  paidWithWords,
} from './words.js';
import { nextStepOf, payeeNameOf } from './writes/lines.js';
import type { CreatedState, NewVendorState } from './writes/saved-state.js';

/**
 * A run's `details` (v2's §2.8; the platform's ADR-0037): label and value lines a person reads on
 * the run, which the platform keeps with it and shows to the team — the saved details, the record
 * made, or the statement compared. A line with no value is left out; dates read `Oct 2, 2026`,
 * money `$1,234.56`. notify mails the same lines (`src/writes/mail.ts`).
 */

/** The document as read and checked, as the saved details keep it: the `saved` output's fields. */
export interface SavedRead {
  readonly documentType: KeptType;
  /** As printed, cleaned: at most 500 characters. */
  readonly seller: string;
  /** At most 100 characters. */
  readonly number: string | null;
  readonly date: string | null;
  readonly dueDate: string | null;
  readonly currency: string | null;
  readonly totalCents: number | null;
  readonly taxCents: number | null;
  readonly spendType: SpendType;
  readonly paymentMethod: PaymentMethod;
  readonly cardLast4: string | null;
}

/** The saved output's bounds on the seller and the number (the manifest's `outputSchema`). */
const SELLER_LENGTH = 500;
const NUMBER_LENGTH = 100;

/** What check-document kept, as the saved details keep it. */
export function readOf(document: DocumentState): SavedRead {
  return {
    documentType: document.type,
    seller: truncateText(document.seller, SELLER_LENGTH),
    number: document.number === null ? null : truncateText(document.number, NUMBER_LENGTH),
    date: document.date,
    dueDate: document.dueDate,
    currency: document.currency,
    totalCents: document.totalCents,
    taxCents: document.arithmetic.taxCents,
    spendType: document.spendType,
    paymentMethod: document.paymentMethod,
    cardLast4: document.cardLast4,
  };
}

/** Why QuickBooks did not record it, as the saved details say it. */
export type QuickBooksLine =
  { readonly notRecorded: string } | { readonly unconfirmed: true } | null;

type Line = readonly [label: string, value: string | null];

/** The lines with a value. */
const kept = (lines: readonly Line[]): RunDetail[] =>
  lines.flatMap(([label, value]) => (value === null || value === '' ? [] : [{ label, value }]));

const day = (value: string | null) => (value === null ? null : dayWords(value));

/** The saved details (§2.8): what the document says, and why QuickBooks has none of it, when chosen. */
export function savedDetails(read: SavedRead, quickBooks: QuickBooksLine): RunDetail[] {
  const statement = read.documentType === 'supplier_statement';
  const amount = (cents: number | null) => (cents === null ? null : money(cents, read.currency));
  return kept([
    ['Type', TYPE_WORDS[read.documentType]],
    ['Seller', read.seller],
    ['Number', read.number],
    ['Date', day(read.date)],
    ['Due', day(read.dueDate)],
    ['Total', amount(read.totalCents)],
    ['Tax', amount(read.taxCents)],
    // A statement is no purchase: it has no category and was paid with nothing.
    ['Category', statement ? null : SPEND_TYPE_WORDS[read.spendType]],
    ['Paid with', statement ? null : paidWithWords(read.paymentMethod, read.cardLast4)],
    [
      'QuickBooks',
      quickBooks === null
        ? null
        : 'notRecorded' in quickBooks
          ? `Not recorded: ${quickBooks.notRecorded}`
          : "Didn't confirm",
    ],
  ]);
}

/** The record's details (§2.8): what QuickBooks now holds, and the next step. */
export function recordedDetails(
  saved: SavedState,
  created: CreatedState,
  newVendor: NewVendorState | null,
  decidedBy: 'automatically' | 'after approval',
): RunDetail[] {
  const { plan } = saved;
  return kept([
    ['Recorded as', RECORD_WORDS[plan.record].recordedAs],
    ['Vendor', payeeNameOf(saved, created, newVendor)],
    ['Number', saved.documentNumber],
    ['Date', dayWords(created.txnDate)],
    ['Due', day(created.dueDate)],
    ['Total', money(created.totalCents ?? plan.amountCents)],
    ['Category', plan.accounts.category.name],
    ['Paid from', plan.accounts.paidFrom?.name ?? null],
    ['Decided', decidedBy === 'automatically' ? 'Automatically' : 'After approval'],
    ['Next', nextStepOf(saved)],
  ]);
}

/** A statement's details (§2.8): what it says, against what QuickBooks shows open. */
export function comparedDetails(result: StatementResult): RunDetail[] {
  const missing = result.listedNotInQuickBooks.length;
  return kept([
    ['Vendor', result.vendor.displayName],
    ['Statement total', result.closingCents === null ? null : money(result.closingCents)],
    ['Not in QuickBooks', `${missing} ${missing === 1 ? 'invoice' : 'invoices'}`],
    [
      'Open in QuickBooks',
      result.quickBooksOpenCents === null ? null : money(result.quickBooksOpenCents),
    ],
  ]);
}
