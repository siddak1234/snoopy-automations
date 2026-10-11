import type { JsonObject } from '@autom8x/automation-sdk';

import type {
  DOCUMENT_TYPES,
  LISTED_KINDS,
  PAYMENT_METHODS,
  REFUND_METHODS,
} from '../../src/document.js';
import type { SpendType } from '../../src/spend-types.js';

/**
 * What a sample is: a made-up document file — every name, address, number and domain
 * invented for this public repository (`.example` domains, 555-01xx telephone numbers) — the
 * marker printed on it, and the answer a careful reader of the prompt's 17 rules gives,
 * which becomes its `expected.json`.
 */

export type ContentType = 'application/pdf' | 'image/jpeg' | 'image/png';

export interface Sample {
  /** Its directory under `test/samples/`. */
  readonly name: string;
  readonly file: string;
  readonly contentType: ContentType;
  /**
   * Printed where the automation must never pass it on — in a line's text or a notes box,
   * never in the seller's name or the document number, which the lines carry by design — so
   * it is in no answer, and never in a timeline line, a reason, saved data or a request.
   */
  readonly marker: string;
  /** Where the marker is printed. */
  readonly markerIn: 'line' | 'notes';
  /** How the file was made, in one sentence. */
  readonly made: string;
  /** The fields the next step's decision turns on, for whoever reviews a recording. */
  readonly decisive: readonly string[];
  /** The route the owner's plan gives it once `extract` has passed it on. */
  readonly next: string;
  /** The 27 fields as a careful reader answers them. */
  readonly answer: JsonObject;
  /** The file's bytes, the same on every machine (a PNG's pixels, at least). */
  make(): Uint8Array;
}

/** The workspace's own company, as the kit's QuickBooks simulator names it. */
export const BILL_TO = ['Sample Bakery LLC', '12 Example Lane', 'Springfield, IL 62701'];

/** Cents as printed: thousands grouped, two decimals, a sign and a prefix such as `$`. */
export function money(cents: number, prefix = ''): string {
  const whole = Math.floor(Math.abs(cents) / 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${cents < 0 ? '-' : ''}${prefix}${grouped}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
}

/** Cents as the answer gives them: a plain number. */
export function amount(cents: number): number {
  return cents / 100;
}

/** A rate in basis points of `cents`, rounded half up to the cent. */
export function percentOf(cents: number, basisPoints: number): number {
  return Math.floor((cents * basisPoints + 5_000) / 10_000);
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

type Fields = {
  documentType?: (typeof DOCUMENT_TYPES)[number];
  documentCount?: number;
  pagesMissing?: boolean;
  vendorName: string | null;
  documentNumber: string | null;
  documentDate: string | null;
  dueDate?: string | null;
  paymentTermsDays?: number | null;
  currency?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  shipping?: number | null;
  discount?: number | null;
  total: number | null;
  amountDue?: number | null;
  tip?: number | null;
  cashBackPrinted?: boolean;
  paymentMethod?: (typeof PAYMENT_METHODS)[number];
  cardLast4?: string | null;
  refundMethod?: (typeof REFUND_METHODS)[number];
  originalInvoiceNumber?: string | null;
  spendType: SpendType;
  /** Each charged line as printed — its text and its cents; the answer keeps the amount alone. */
  lineItems: readonly (readonly [string, number])[];
  lineItemsComplete?: boolean;
  /** Each row the document lists: its reference, its cents, its kind. */
  listedItems?: readonly (readonly [string, number, (typeof LISTED_KINDS)[number]])[];
  listedItemsComplete?: boolean;
  uncertainFields?: readonly string[];
};

/** The 27 fields in the schema's order; anything not given is what a bill has: none. */
export function answer(fields: Fields): JsonObject {
  return {
    documentType: fields.documentType ?? 'bill',
    documentCount: fields.documentCount ?? 1,
    pagesMissing: fields.pagesMissing ?? false,
    vendorName: fields.vendorName,
    documentNumber: fields.documentNumber,
    documentDate: fields.documentDate,
    dueDate: fields.dueDate ?? null,
    paymentTermsDays: fields.paymentTermsDays ?? null,
    currency: fields.currency ?? null,
    subtotal: fields.subtotal ?? null,
    tax: fields.tax ?? null,
    shipping: fields.shipping ?? null,
    discount: fields.discount ?? null,
    total: fields.total,
    amountDue: fields.amountDue ?? null,
    tip: fields.tip ?? null,
    cashBackPrinted: fields.cashBackPrinted ?? false,
    paymentMethod: fields.paymentMethod ?? 'not_shown',
    cardLast4: fields.cardLast4 ?? null,
    refundMethod: fields.refundMethod ?? 'not_applicable',
    originalInvoiceNumber: fields.originalInvoiceNumber ?? null,
    spendType: fields.spendType,
    lineItems: fields.lineItems.map(([, cents]) => ({ amount: amount(cents) })),
    lineItemsComplete: fields.lineItemsComplete ?? true,
    listedItems: (fields.listedItems ?? []).map(([reference, cents, kind]) => ({
      reference,
      amount: amount(cents),
      kind,
    })),
    listedItemsComplete: fields.listedItemsComplete ?? true,
    uncertainFields: [...(fields.uncertainFields ?? [])],
  };
}
