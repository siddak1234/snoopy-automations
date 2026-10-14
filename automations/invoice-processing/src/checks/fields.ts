import type { Route } from '../document.js';
import type { ComparedField } from '../state.js';

/**
 * The answer's fields as a person reads them — in the unclear list and where the two reads part —
 * and which of them each route uses.
 */

/** Each field's words in a reason or a timeline line: "unclear: total, date". */
export const FIELD_WORDS: Readonly<Record<string, string>> = {
  total: 'total',
  vendorName: 'seller',
  documentNumber: 'number',
  documentDate: 'date',
  dueDate: 'due date',
  currency: 'currency',
  amountDue: 'amount due',
  tip: 'tip',
  cashBackPrinted: 'cash back',
  paymentMethod: 'payment method',
  cardLast4: 'card digits',
  refundMethod: 'refund method',
  originalInvoiceNumber: 'original invoice',
  subtotal: 'subtotal',
  tax: 'tax',
  shipping: 'shipping',
  discount: 'discount',
  paymentTermsDays: 'payment terms',
  lineItems: 'line items',
  listedItems: 'listed items',
  documentType: 'document type',
  documentCount: 'document count',
  pagesMissing: 'pages',
  spendType: 'spend type',
};

/**
 * The order the unclear fields are named in (ip-review design-checks-rules-and-approval.json,
 * steps[0].logic[6]): what decides the record first, the document's shape last.
 */
export const UNCLEAR_ORDER = [
  'total',
  'vendorName',
  'documentNumber',
  'documentDate',
  'dueDate',
  'currency',
  'amountDue',
  'tip',
  'cashBackPrinted',
  'paymentMethod',
  'cardLast4',
  'refundMethod',
  'originalInvoiceNumber',
  'subtotal',
  'tax',
  'shipping',
  'discount',
  'paymentTermsDays',
  'lineItems',
  'listedItems',
  'documentType',
  'documentCount',
  'pagesMissing',
] as const;

const BASE = [
  'documentType',
  'documentCount',
  'pagesMissing',
  'vendorName',
  'documentNumber',
  'documentDate',
  'currency',
  'total',
];
const PARTS = ['subtotal', 'tax', 'shipping', 'discount', 'lineItems'];

/**
 * The fields each route uses — an unclear field holds only where it can change the record. A
 * statement never holds, so no field of one does.
 */
export const RELEVANT_FIELDS: Readonly<Record<Route, ReadonlySet<string>>> = {
  bill: new Set([...BASE, ...PARTS, 'dueDate', 'paymentTermsDays', 'amountDue', 'listedItems']),
  company_receipt: new Set([
    ...BASE,
    ...PARTS,
    'amountDue',
    'tip',
    'cashBackPrinted',
    'paymentMethod',
    'cardLast4',
  ]),
  card_refund: new Set([...BASE, ...PARTS, 'refundMethod', 'originalInvoiceNumber', 'cardLast4']),
  vendor_credit: new Set([...BASE, ...PARTS, 'refundMethod', 'originalInvoiceNumber']),
  statement: new Set(),
};

const WRITTEN = [
  'documentType',
  'vendorName',
  'documentNumber',
  'documentDate',
  'currency',
  'total',
];

/**
 * What the second read compares on each route (the plan's §4 table): the type always, and for a
 * record that is written the fields that go into QuickBooks; a statement compares its type only.
 */
export const COMPARED_FIELDS: Readonly<Record<Route, readonly ComparedField[]>> = {
  bill: [...(WRITTEN as ComparedField[]), 'dueDate', 'amountDue', 'spendType'],
  company_receipt: [
    ...(WRITTEN as ComparedField[]),
    'amountDue',
    'paymentMethod',
    'cardLast4',
    'cashBackPrinted',
    'spendType',
  ],
  card_refund: [...(WRITTEN as ComparedField[]), 'cardLast4', 'refundMethod', 'spendType'],
  vendor_credit: [...(WRITTEN as ComparedField[]), 'refundMethod', 'spendType'],
  statement: ['documentType'],
};

/** Up to two field names, then "+N": "total, date +2". */
export function namedFields(fields: readonly string[]): string {
  const words = fields.map((field) => FIELD_WORDS[field] ?? field);
  const shown = words.slice(0, 2).join(', ');
  return words.length > 2 ? `${shown} +${words.length - 2}` : shown;
}
