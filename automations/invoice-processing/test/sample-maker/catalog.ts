import type { JsonObject } from '@autom8x/automation-sdk';

/**
 * What a sample is: a made-up invoice file — every name, address, number and domain invented
 * for this public repository (`.example` domains, 555-01xx telephone numbers) — the marker
 * printed on it, and the answer a careful reader of the prompt's 13 rules gives, which becomes
 * its `expected.json`.
 */

export type ContentType = 'application/pdf' | 'image/jpeg' | 'image/png';

export interface Sample {
  /** Its directory under `test/samples/`. */
  readonly name: string;
  readonly file: string;
  readonly contentType: ContentType;
  /** Printed on it, inside the invoice number: never to appear in a timeline line or a reason. */
  readonly marker: string;
  /** How the file was made, in one sentence. */
  readonly made: string;
  /** The fields the next step's decision turns on, for whoever reviews a recording. */
  readonly decisive: readonly string[];
  /** What the owner's decided rules do with it once `extract` has passed it on. */
  readonly next: string;
  /** The 18 fields as a careful reader answers them. */
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
  documentType?: string;
  invoiceCount?: number;
  pagesMissing?: boolean;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate?: string | null;
  paymentTermsDays?: number | null;
  currency?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  shipping?: number | null;
  discount?: number | null;
  total: number | null;
  amountDue?: number | null;
  lineItems: readonly (readonly [string, number])[];
  lineItemsComplete?: boolean;
  uncertainFields?: readonly string[];
};

/** The 18 fields in the schema's order, anything not given as an invoice has it: null. */
export function answer(fields: Fields): JsonObject {
  return {
    documentType: fields.documentType ?? 'invoice',
    invoiceCount: fields.invoiceCount ?? 1,
    pagesMissing: fields.pagesMissing ?? false,
    vendorName: fields.vendorName,
    invoiceNumber: fields.invoiceNumber,
    invoiceDate: fields.invoiceDate,
    dueDate: fields.dueDate ?? null,
    paymentTermsDays: fields.paymentTermsDays ?? null,
    currency: fields.currency ?? null,
    subtotal: fields.subtotal ?? null,
    tax: fields.tax ?? null,
    shipping: fields.shipping ?? null,
    discount: fields.discount ?? null,
    total: fields.total,
    amountDue: fields.amountDue ?? null,
    lineItems: fields.lineItems.map(([description, cents]) => ({
      description,
      amount: amount(cents),
    })),
    lineItemsComplete: fields.lineItemsComplete ?? true,
    uncertainFields: [...(fields.uncertainFields ?? [])],
  };
}
