import { isObject } from '@autom8x/automation-sdk';

import {
  DOCUMENT_TYPES,
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
 * The two reads' answers as the code reads them. The platform holds each answer to its prompt's
 * schema before a step sees it; these guards repeat the types only — never a value's meaning,
 * which is the cleaning's — so a malformed answer ends as `answer_unusable` rather than as a
 * throw, and the rest of the code is typed.
 */

/** The 27 fields of `prompts/extract-document.v1.json`, typed. */
export interface FirstRead {
  readonly documentType: DocumentType;
  readonly documentCount: number;
  readonly pagesMissing: boolean;
  readonly vendorName: string | null;
  readonly documentNumber: string | null;
  readonly documentDate: string | null;
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
  readonly lineItems: readonly { readonly amount: number | null }[];
  readonly lineItemsComplete: boolean;
  readonly listedItems: readonly {
    readonly reference: string;
    readonly amount: number;
    readonly kind: ListedKind;
  }[];
  readonly listedItemsComplete: boolean;
  readonly uncertainFields: readonly string[];
}

/** The 14 fields of `prompts/verify-document.v1.json`: what read 2 re-reads (the plan's §4). */
export interface SecondRead {
  readonly documentType: DocumentType;
  readonly vendorName: string | null;
  readonly documentNumber: string | null;
  readonly documentDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string | null;
  readonly total: number | null;
  readonly amountDue: number | null;
  readonly cashBackPrinted: boolean;
  readonly paymentMethod: PaymentMethod;
  readonly cardLast4: string | null;
  readonly refundMethod: RefundMethod;
  readonly spendType: SpendType;
  readonly uncertainFields: readonly string[];
}

/** The second read's fields in its schema's order. */
export const SECOND_READ_FIELDS = [
  'documentType',
  'vendorName',
  'documentNumber',
  'documentDate',
  'dueDate',
  'currency',
  'total',
  'amountDue',
  'cashBackPrinted',
  'paymentMethod',
  'cardLast4',
  'refundMethod',
  'spendType',
  'uncertainFields',
] as const;

const isText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const isAmount = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));
const isOneOf = (value: unknown, values: readonly string[]): boolean =>
  typeof value === 'string' && values.includes(value);
const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const TEXTS = ['vendorName', 'documentNumber', 'documentDate', 'dueDate', 'currency', 'cardLast4'];
const AMOUNTS = ['total', 'amountDue'];
const PARTS = ['subtotal', 'tax', 'shipping', 'discount', 'tip', 'paymentTermsDays'];

/** The fields both reads share, each its type. */
function sharedProblem(answer: Record<string, unknown>): boolean {
  return (
    !isOneOf(answer.documentType, DOCUMENT_TYPES) ||
    !TEXTS.every((field) => isText(answer[field])) ||
    !AMOUNTS.every((field) => isAmount(answer[field])) ||
    typeof answer.cashBackPrinted !== 'boolean' ||
    !isOneOf(answer.paymentMethod, PAYMENT_METHODS) ||
    !isOneOf(answer.refundMethod, REFUND_METHODS) ||
    !isOneOf(answer.spendType, SPEND_TYPES) ||
    !isTextList(answer.uncertainFields)
  );
}

/** Read 1's answer, typed; undefined when a field is missing or of another type. */
export function firstReadOf(value: unknown): FirstRead | undefined {
  if (!isObject(value) || sharedProblem(value)) return undefined;
  const { documentCount, lineItems, listedItems } = value;
  if (
    typeof documentCount !== 'number' ||
    !Number.isInteger(documentCount) ||
    typeof value.pagesMissing !== 'boolean' ||
    !PARTS.every((field) => isAmount(value[field])) ||
    !isText(value.originalInvoiceNumber) ||
    typeof value.lineItemsComplete !== 'boolean' ||
    typeof value.listedItemsComplete !== 'boolean' ||
    !Array.isArray(lineItems) ||
    !lineItems.every((line) => isObject(line) && isAmount(line.amount)) ||
    !Array.isArray(listedItems) ||
    !listedItems.every(
      (row) =>
        isObject(row) &&
        typeof row.reference === 'string' &&
        typeof row.amount === 'number' &&
        Number.isFinite(row.amount) &&
        isOneOf(row.kind, LISTED_KINDS),
    )
  ) {
    return undefined;
  }
  return value as unknown as FirstRead;
}

/** Read 2's answer, typed; undefined when it is not exactly the 14 fields, each of its type. */
export function secondReadOf(value: unknown): SecondRead | undefined {
  if (!isObject(value) || sharedProblem(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.join() !== [...SECOND_READ_FIELDS].sort().join()) return undefined;
  return value as unknown as SecondRead;
}
