import { isObject, type JsonObject } from '@autom8x/automation-sdk';

import {
  LISTED_KINDS,
  PAYMENT_METHODS,
  REFUND_METHODS,
  type DocumentType,
  type ListedKind,
  type PaymentMethod,
  type RefundMethod,
} from '../document.js';
import { SPEND_TYPES, type SpendType } from '../spend-types.js';

/**
 * The first read's answer as v3 asks for it (`prompts/extract-documents.v1.json`): one part of the
 * file — every document from where the part starts, each its own entry with its own seller and its
 * own details — and where the next part starts. The platform holds each answer to the prompt's
 * schema before a step sees it; these guards repeat the types only, never a value's meaning,
 * which the checks own, so a malformed answer is "unusable" rather than a throw.
 *
 * A text not printed is an empty string, and "no next part" is 0 — not null: Anthropic's
 * structured outputs take at most 16 fields typed with a union such as `["string", "null"]` in one
 * request (platform.claude.com, "Structured outputs", its limits table, read 2026-10-16; v2's
 * schema used all 16), and v3 reads more of each document. Only the amounts stay nullable: 11.
 */

/** What a document is, as v3 reads it: every financial document has a type, and a page that is none says so. */
export const READ_TYPES = [
  'bill',
  'invoice',
  'receipt',
  'credit_note',
  'supplier_statement',
  'bank_statement',
  'quote',
  'purchase_order',
  'other_financial',
  'not_financial',
] as const;
export type ReadType = (typeof READ_TYPES)[number];

/** One charged line, as printed. */
export interface LineAnswer {
  readonly description: string | null;
  readonly quantity: number | null;
  readonly unitPrice: number | null;
  readonly amount: number | null;
}

/** One document of a part: v2's fields, and the ones v3 adds. */
export interface DocumentAnswer {
  readonly documentType: ReadType;
  readonly pagesMissing: boolean;
  readonly vendorName: string | null;
  readonly vendorAddress: string | null;
  readonly vendorCity: string | null;
  readonly storeNumber: string | null;
  readonly documentNumber: string | null;
  readonly numberLabel: string | null;
  readonly references: readonly { readonly label: string; readonly value: string }[];
  readonly documentDate: string | null;
  readonly documentTime: string | null;
  readonly dueDate: string | null;
  readonly paymentTermsDays: number | null;
  readonly currency: string | null;
  readonly subtotal: number | null;
  readonly tax: number | null;
  readonly shipping: number | null;
  readonly discount: number | null;
  readonly total: number | null;
  readonly amountDue: number | null;
  readonly tip: number | null;
  readonly cashBackPrinted: boolean;
  readonly paymentMethod: PaymentMethod;
  readonly cardLast4: string | null;
  readonly refundMethod: RefundMethod;
  readonly originalInvoiceNumber: string | null;
  readonly spendType: SpendType;
  readonly lineItems: readonly LineAnswer[];
  readonly lineItemCount: number;
  readonly lineItemsComplete: boolean;
  readonly listedItems: readonly {
    readonly reference: string;
    readonly amount: number;
    readonly kind: ListedKind;
  }[];
  readonly listedItemsComplete: boolean;
  readonly uncertainFields: readonly string[];
}

/** One part's answer; where the next part starts is null once everything is read (0 on the wire). */
export interface PartAnswer {
  readonly documentCount: number;
  readonly documents: readonly DocumentAnswer[];
  readonly nextDocument: number | null;
  readonly nextLine: number | null;
}

const isText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const isAmount = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));
const isOneOf = (value: unknown, values: readonly string[]): boolean =>
  typeof value === 'string' && values.includes(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const TEXTS = [
  'vendorName',
  'vendorAddress',
  'vendorCity',
  'storeNumber',
  'documentNumber',
  'numberLabel',
  'documentDate',
  'documentTime',
  'dueDate',
  'currency',
  'cardLast4',
  'originalInvoiceNumber',
];
const AMOUNTS = [
  'subtotal',
  'tax',
  'shipping',
  'discount',
  'total',
  'amountDue',
  'tip',
  'paymentTermsDays',
];

function isLine(value: unknown): boolean {
  return (
    isObject(value) &&
    isText(value.description) &&
    isAmount(value.quantity) &&
    isAmount(value.unitPrice) &&
    isAmount(value.amount)
  );
}

function isDocument(value: unknown): value is DocumentAnswer {
  if (!isObject(value)) return false;
  const { references, lineItems, listedItems, uncertainFields } = value;
  return (
    isOneOf(value.documentType, READ_TYPES) &&
    typeof value.pagesMissing === 'boolean' &&
    TEXTS.every((field) => isText(value[field])) &&
    AMOUNTS.every((field) => isAmount(value[field])) &&
    typeof value.cashBackPrinted === 'boolean' &&
    isOneOf(value.paymentMethod, PAYMENT_METHODS) &&
    isOneOf(value.refundMethod, REFUND_METHODS) &&
    isOneOf(value.spendType, SPEND_TYPES) &&
    Array.isArray(references) &&
    references.every(
      (reference) =>
        isObject(reference) &&
        typeof reference.label === 'string' &&
        typeof reference.value === 'string',
    ) &&
    Array.isArray(lineItems) &&
    lineItems.every(isLine) &&
    isCount(value.lineItemCount) &&
    typeof value.lineItemsComplete === 'boolean' &&
    Array.isArray(listedItems) &&
    listedItems.every(
      (row) =>
        isObject(row) &&
        typeof row.reference === 'string' &&
        typeof row.amount === 'number' &&
        Number.isFinite(row.amount) &&
        isOneOf(row.kind, LISTED_KINDS),
    ) &&
    typeof value.listedItemsComplete === 'boolean' &&
    Array.isArray(uncertainFields) &&
    uncertainFields.every((field) => typeof field === 'string')
  );
}

/** One part's answer, typed; undefined when a field is missing or of another type. */
export function partAnswerOf(value: unknown): PartAnswer | undefined {
  if (!isObject(value)) return undefined;
  const { documentCount, documents, nextDocument, nextLine } = value;
  if (
    !isCount(documentCount) ||
    !Array.isArray(documents) ||
    !documents.every(isDocument) ||
    !isCount(nextDocument) ||
    !isCount(nextLine) ||
    (nextDocument === 0) !== (nextLine === 0)
  ) {
    return undefined;
  }
  return {
    documentCount,
    documents,
    nextDocument: nextDocument === 0 ? null : nextDocument,
    nextLine: nextLine === 0 ? null : nextLine,
  };
}

/** v3's types as v2's checks read them: an invoice is a bill; any other financial document is `other`. */
export const V2_TYPES: Readonly<Record<ReadType, DocumentType>> = {
  bill: 'bill',
  invoice: 'bill',
  receipt: 'receipt',
  credit_note: 'credit_note',
  supplier_statement: 'supplier_statement',
  bank_statement: 'bank_statement',
  quote: 'quote',
  purchase_order: 'purchase_order',
  other_financial: 'other',
  not_financial: 'other',
};

/** The fields v2's answer names as unclear; v3's own (the seller's place, the number's label) are not weighed. */
const V2_UNCERTAIN = new Set([
  'documentType',
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
  'listedItems',
]);

/** A text as v2's answer had it: null when nothing is printed — v3 reads that as an empty string. */
const printed = (value: string | null): string | null =>
  value === null || value.trim() === '' ? null : value;

/**
 * One document as v2's checks read an answer (`src/checks/answers.ts`, the 27 fields of v2's
 * prompt): the same values, the type as v2 names it, one document counted — the file's count is
 * the read's, never one document's — and each line by its amount, the list complete only when
 * every line the document has was read.
 */
export function v2AnswerOf(document: DocumentAnswer): JsonObject {
  return {
    documentType: V2_TYPES[document.documentType],
    documentCount: 1,
    pagesMissing: document.pagesMissing,
    vendorName: printed(document.vendorName),
    documentNumber: printed(document.documentNumber),
    documentDate: printed(document.documentDate),
    dueDate: printed(document.dueDate),
    paymentTermsDays: document.paymentTermsDays,
    currency: printed(document.currency),
    subtotal: document.subtotal,
    tax: document.tax,
    shipping: document.shipping,
    discount: document.discount,
    total: document.total,
    amountDue: document.amountDue,
    tip: document.tip,
    cashBackPrinted: document.cashBackPrinted,
    paymentMethod: document.paymentMethod,
    cardLast4: printed(document.cardLast4),
    refundMethod: document.refundMethod,
    originalInvoiceNumber: printed(document.originalInvoiceNumber),
    spendType: document.spendType,
    lineItems: document.lineItems.map((line) => ({ amount: line.amount })),
    // A line not read — past where the reading in parts stopped — leaves the list incomplete.
    lineItemsComplete:
      document.lineItemsComplete && document.lineItems.length >= document.lineItemCount,
    listedItems: document.listedItems.map((row) => ({ ...row })),
    listedItemsComplete: document.listedItemsComplete,
    uncertainFields: document.uncertainFields.filter((field) => V2_UNCERTAIN.has(field)),
  };
}
