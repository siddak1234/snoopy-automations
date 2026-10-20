import { truncateText } from './contract.js';
import { RUN_DETAIL_LIMITS } from './details.js';

/**
 * A run's `documents` (the platform's BUILD-PLAN 25.4.27, its ADR-0039; the session's spec of
 * 2026-10-15, §1.1 as the owner's AM1 and AM7 amend it): ONE object per document a run read from
 * its file, the same at every hop — the result, the run's row, the one-run read, the JSON file and
 * both clients. Copied from the vendored `automation-run-result.json` (`contract/schemas`), never
 * imported: the boundary is the wire. Amounts and quantities are decimal strings, never JSON
 * numbers, so nothing is rounded on the way.
 *
 * **No limit but size** (the owner, 2026-10-15: "no limits other than size"): no count of
 * documents, line items, references or details and no length of any text the document carries is
 * bounded here or on the wire. The one bound left is a detail line's — the platform's shared
 * `RunDetailLine`, 40 and 200 characters — which the automation writes, not the document.
 */

/** What became of a document (the platform's `RunDocument.status`); nothing is ever skipped. */
export const RUN_DOCUMENT_STATUSES = [
  'recorded',
  'saved',
  'not_recorded',
  'unconfirmed',
  'compared',
  'waiting',
] as const;
export type RunDocumentStatus = (typeof RUN_DOCUMENT_STATUSES)[number];

/** What a document is. */
export const RUN_DOCUMENT_TYPES = [
  'bill',
  'invoice',
  'receipt',
  'credit_note',
  'statement',
  'bank_statement',
  'quote',
  'purchase_order',
  'other',
] as const;
export type RunDocumentType = (typeof RUN_DOCUMENT_TYPES)[number];

/** How it was paid; `not_shown` when nothing printed says. */
export const RUN_DOCUMENT_PAYMENT_METHODS = [
  'card',
  'cash',
  'check',
  'bank_transfer',
  'other',
  'not_shown',
] as const;
export type RunDocumentPaymentMethod = (typeof RUN_DOCUMENT_PAYMENT_METHODS)[number];

/** The only bounds left on a document: its detail lines are the platform's `RunDetailLine`. */
export const RUN_DOCUMENT_LIMITS = {
  detailLabelLength: RUN_DETAIL_LIMITS.label,
  detailValueLength: RUN_DETAIL_LIMITS.value,
} as const;

/**
 * An amount or a quantity: a decimal string of any number of whole digits and decimals — the
 * vendored `automation-run-result.json`'s `RunDocumentAmount` (the platform's P6 of Build 22, AM1
 * and AM7: no limit but size), which `packages/automation-sdk/test/documents.test.ts` holds this to.
 */
export const RUN_DOCUMENT_DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/u;
/** A time as printed: `HH:MM`, 24-hour, no zone. */
export const RUN_DOCUMENT_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const CARD_PATTERN = /^[0-9]{4}$/u;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/u;
/** An uploaded file's artifact id, as the platform writes one: a UUID. */
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The platform's bounds on `RunDocumentRecord.accountName` and `RunDocumentSource.pages`. */
const ACCOUNT_NAME_MAX = 200;
const SOURCE_PAGES_MAX = 500;

export interface RunDocumentVendor {
  readonly name: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly storeNumber: string | null;
}

/** Another identifier printed on the document, with its printed label: a PO number, a terminal. */
export interface RunDocumentReference {
  readonly label: string;
  readonly value: string;
}

export interface RunDocumentLineItem {
  readonly description: string | null;
  readonly quantity: string | null;
  readonly unitPrice: string | null;
  readonly amount: string | null;
}

export interface RunDocumentPayment {
  readonly method: RunDocumentPaymentMethod;
  readonly cardLast4: string | null;
}

/** Where a recorded document went; non-null only when `status` is `recorded`. */
export interface RunDocumentRecord {
  readonly providerId: string;
  readonly recordType: string;
  readonly recordId: string;
  /** The account it went to, as the provider names it — a QuickBooks company's name. Optional. */
  readonly accountName?: string;
}

/**
 * Where a document is in the files uploaded for its run: the file's artifact id and, when the
 * automation can tell, its pages from 1, strictly ascending (an image is page 1). Optional.
 */
export interface RunDocumentSource {
  readonly file: string;
  readonly pages?: readonly number[];
}

export interface RunDocument {
  /** From 1, unique and strictly ascending in a list; no maximum. */
  readonly index: number;
  readonly status: RunDocumentStatus;
  /** One line, the automation's words. */
  readonly statusText: string;
  readonly type: RunDocumentType;
  readonly vendor: RunDocumentVendor;
  /** The document's own number as printed: how it is matched to its record. */
  readonly number: string | null;
  /** The label printed beside `number`: "Invoice #", "Bill No.", "Receipt". */
  readonly numberLabel: string | null;
  /** Every other identifier printed on it. */
  readonly references: readonly RunDocumentReference[];
  /** `YYYY-MM-DD`. */
  readonly date: string | null;
  /** `HH:MM`, as printed. */
  readonly time: string | null;
  /** ISO 4217. */
  readonly currency: string | null;
  readonly lineItems: readonly RunDocumentLineItem[];
  readonly lineItemsComplete: boolean;
  readonly subtotal: string | null;
  readonly tax: string | null;
  readonly tip: string | null;
  readonly discount: string | null;
  readonly total: string | null;
  readonly payment: RunDocumentPayment;
  readonly recordedIn: RunDocumentRecord | null;
  readonly details: readonly { readonly label: string; readonly value: string }[];
  readonly source?: RunDocumentSource;
}

/**
 * A number as a decimal string, exactly as its shortest form writes it — `412.5` is `"412.5"`,
 * `-0` is `"0"` — or null when it is not a finite number, or its shortest form does not fit the
 * pattern (an exponent: from 1e21, or below 1e-6): never rounded.
 */
export function decimalOf(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const text = Object.is(value, -0) ? '0' : String(value);
  return RUN_DOCUMENT_DECIMAL_PATTERN.test(text) ? text : null;
}

/**
 * One line of text the platform can store: every run of white space and control characters (a NUL
 * among them) one space; half a surrogate pair the replacement character U+FFFD — the run's row is
 * `jsonb`, which holds neither, and the platform refuses a document carrying one (its §12.1 #287),
 * which would leave a run whose work is done unreportable; trimmed.
 */
const oneLineText = (value: string) =>
  value
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .replace(/[\ud800-\udfff]/gu, '\uFFFD')
    .trim();

/** Text on one line, whole — never cut, as AM7 has it; null when nothing is left. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const line = oneLineText(value);
  return line === '' ? null : line;
}

/** A detail line's text, cut at the platform's `RunDetailLine` bound, whole characters only. */
function detailText(value: unknown, maximum: number): string | null {
  const line = text(value);
  if (line === null) return null;
  const cut = truncateText(line, maximum).trimEnd();
  return cut === '' ? null : cut;
}

const matching = (value: unknown, pattern: RegExp): string | null =>
  typeof value === 'string' && pattern.test(value) ? value : null;

const decimal = (value: unknown): string | null => matching(value, RUN_DOCUMENT_DECIMAL_PATTERN);

function boundedRecord(value: RunDocumentRecord | null): RunDocumentRecord | null {
  if (value === null || !PROVIDER_ID_PATTERN.test(value.providerId)) return null;
  const recordType = text(value.recordType);
  const recordId = text(value.recordId);
  if (recordType === null || recordId === null) return null;
  // An account name past the platform's bound is left out, never cut: the record still stands.
  const accountName = text(value.accountName);
  return accountName !== null && [...accountName].length <= ACCOUNT_NAME_MAX
    ? { providerId: value.providerId, recordType, recordId, accountName }
    : { providerId: value.providerId, recordType, recordId };
}

/**
 * The source as the wire accepts it: none without a file id the platform reads as one; its pages
 * only when every one is a whole number from 1, strictly ascending, within the platform's bound.
 */
function boundedSource(value: RunDocumentSource | undefined): RunDocumentSource | undefined {
  if (value === undefined || !FILE_ID_PATTERN.test(value.file)) return undefined;
  const pages = value.pages;
  const ordered =
    pages !== undefined &&
    pages.length >= 1 &&
    pages.length <= SOURCE_PAGES_MAX &&
    pages.every(
      (page, at) => Number.isInteger(page) && page >= 1 && (at === 0 || page > pages[at - 1]!),
    );
  return ordered ? { file: value.file, pages: [...pages] } : { file: value.file };
}

/** One document as the wire accepts it. Its `statusText` must not be empty: the platform refuses that too. */
function boundedDocument(document: RunDocument): RunDocument {
  const source = boundedSource(document.source);
  const statusText = text(document.statusText);
  if (statusText === null) throw new Error(`documents[${document.index}].statusText is empty`);
  const references: RunDocumentReference[] = [];
  for (const reference of document.references) {
    const label = text(reference.label);
    const value = text(reference.value);
    if (label !== null && value !== null) references.push({ label, value });
  }
  const details: { label: string; value: string }[] = [];
  for (const line of document.details) {
    const label = detailText(line.label, RUN_DOCUMENT_LIMITS.detailLabelLength);
    const value = detailText(line.value, RUN_DOCUMENT_LIMITS.detailValueLength);
    if (label !== null && value !== null) details.push({ label, value });
  }
  return {
    index: document.index,
    status: document.status,
    statusText,
    type: document.type,
    vendor: {
      name: text(document.vendor.name),
      address: text(document.vendor.address),
      city: text(document.vendor.city),
      storeNumber: text(document.vendor.storeNumber),
    },
    number: text(document.number),
    numberLabel: text(document.numberLabel),
    references,
    date: matching(document.date, DATE_PATTERN),
    time: matching(document.time, RUN_DOCUMENT_TIME_PATTERN),
    currency: matching(document.currency, CURRENCY_PATTERN),
    lineItems: document.lineItems.map((line) => ({
      description: text(line.description),
      quantity: decimal(line.quantity),
      unitPrice: decimal(line.unitPrice),
      amount: decimal(line.amount),
    })),
    lineItemsComplete: document.lineItemsComplete,
    subtotal: decimal(document.subtotal),
    tax: decimal(document.tax),
    tip: decimal(document.tip),
    discount: decimal(document.discount),
    total: decimal(document.total),
    payment: {
      method: document.payment.method,
      cardLast4: matching(document.payment.cardLast4, CARD_PATTERN),
    },
    recordedIn: boundedRecord(document.recordedIn),
    details,
    ...(source === undefined ? {} : { source }),
  };
}

/**
 * The documents as the wire accepts them (`automation-run-result.json`): every one kept, with
 * every line, reference and detail; each text made one line and null when nothing is left — never
 * cut, but for a detail line's label and value, cut at the platform's shared bound; a decimal, a
 * date, a time, a currency or card digits that do not fit their pattern made null. `undefined` for
 * none, so a result never carries an empty list — a run whose work is done must not become
 * unreportable because a value was malformed, as `boundedDetails` holds a detail line.
 */
export function boundedDocuments(
  documents: readonly RunDocument[] | undefined,
): RunDocument[] | undefined {
  const kept = (documents ?? []).map(boundedDocument);
  return kept.length === 0 ? undefined : kept;
}
