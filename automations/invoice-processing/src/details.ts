import { truncateText } from '@autom8x/automation-sdk';

import type { KeptType, PaymentMethod } from './document.js';
import type { SpendType } from './spend-types.js';
import type { DocumentState } from './state.js';

/**
 * The document as decide keeps it in its saved data (v2's §2.8): what check-documents read and
 * cleaned. What a person reads beside each document is `src/run/documents.ts`'s.
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
