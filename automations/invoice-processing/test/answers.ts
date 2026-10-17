import {
  isObject,
  type JsonObject,
  type ModelCompletion,
  type ModelRequest,
} from '@autom8x/automation-sdk';

import { SECOND_READ_FIELDS } from '../src/checks/answers.js';
import { VERIFY_DOCUMENTS_V1 } from '../src/prompts.js';

/**
 * The model's answers in the suite (`fixtures.ts`'s, in their own file for the line ceiling): one
 * document as v2's checks read it, `GOOD_ANSWER`; the same as v3's prompts answer it — a part of
 * documents, a second read by place — and a model that reads the file as the documents a test
 * gives and, asked the second read's prompt, gives each document's 14 fields again.
 */

/** One document as v2's prompt answered it: its 27 fields — the shape v2's checks read. */
export const GOOD_ANSWER: JsonObject = {
  documentType: 'bill',
  documentCount: 1,
  pagesMissing: false,
  vendorName: 'Harrowgate Office Supply',
  documentNumber: 'HOS-1042',
  documentDate: '2026-09-14',
  dueDate: '2026-10-14',
  paymentTermsDays: 30,
  currency: 'USD',
  subtotal: 412.5,
  tax: 34.03,
  shipping: 15,
  discount: null,
  total: 461.53,
  amountDue: null,
  tip: null,
  cashBackPrinted: false,
  paymentMethod: 'not_shown',
  cardLast4: null,
  refundMethod: 'not_applicable',
  originalInvoiceNumber: null,
  spendType: 'office_supplies',
  lineItems: [{ amount: 189.5 }, { amount: 223 }],
  lineItemsComplete: true,
  listedItems: [],
  listedItemsComplete: true,
  uncertainFields: [],
};

/** The texts v3's prompt reads as a string, empty when nothing is printed (`src/run/answer.ts`). */
const TEXTS = [
  'vendorName',
  'documentNumber',
  'documentDate',
  'dueDate',
  'currency',
  'cardLast4',
  'originalInvoiceNumber',
];

/** Each text of an answer as v3's prompts give it: an empty string for none. */
export function asTexts(answer: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(answer).map(([key, value]) => [
      key,
      TEXTS.includes(key) && value === null ? '' : value,
    ]),
  );
}

/**
 * One document as v3's prompt reads it, from a v2-shaped answer: the same values, a text not
 * printed an empty string, v2's `other` read as another financial document — v3's own fields
 * empty, each line its amount alone — then `extra`, which may set any of v3's fields.
 */
export function documentAnswer(
  answer: JsonObject = GOOD_ANSWER,
  extra: JsonObject = {},
): JsonObject {
  const { documentCount: _count, lineItems, uncertainFields, ...rest } = asTexts(answer);
  const lines = (Array.isArray(lineItems) ? lineItems : []).map((line) => ({
    description: '',
    quantity: null,
    unitPrice: null,
    amount: isObject(line) ? (line.amount ?? null) : null,
  }));
  return {
    ...rest,
    documentType: rest.documentType === 'other' ? 'other_financial' : rest.documentType,
    vendorAddress: '',
    vendorCity: '',
    storeNumber: '',
    numberLabel: '',
    references: [],
    documentTime: '',
    lineItems: lines,
    lineItemCount: lines.length,
    uncertainFields: (Array.isArray(uncertainFields) ? uncertainFields : []).filter(
      (field) => field !== 'documentCount',
    ),
    ...extra,
  };
}

/** One part's answer: the documents given, and where the next part starts (none by default). */
export function partAnswer(
  documents: readonly JsonObject[],
  next: { document: number; line: number } | null = null,
  documentCount = documents.length,
): JsonObject {
  return {
    documentCount,
    documents: [...documents],
    nextDocument: next?.document ?? 0,
    nextLine: next?.line ?? 0,
  };
}

/** The second read's answer of a reader who agrees with `answer`: its 14 fields, then `changes`. */
export function secondAnswer(answer: JsonObject, changes: JsonObject = {}): JsonObject {
  const fields = SECOND_READ_FIELDS as readonly string[];
  const picked = Object.fromEntries(fields.map((field) => [field, answer[field]]));
  const unclear = Array.isArray(answer.uncertainFields)
    ? answer.uncertainFields.filter((field) => fields.includes(String(field)))
    : [];
  const type = picked.documentType === 'other' ? 'other_financial' : picked.documentType;
  return asTexts({ ...picked, documentType: type, uncertainFields: unclear, ...changes });
}

/** The second read's answer for the documents a call names, each its own reader's, by place. */
export function verifyAnswer(
  documents: readonly (readonly [position: number, fields: JsonObject])[],
  documentCount: number,
): JsonObject {
  return {
    documentCount,
    documents: documents.map(([position, fields]) => ({ position, ...fields })),
  };
}

/** Whether a model call is the second read's: its prompt is `verify-documents`'s. */
export function isSecondRead(call: ModelRequest): boolean {
  return call.prompt.startsWith(VERIFY_DOCUMENTS_V1.template.slice(0, 60));
}

/** The places a second read's call names, from its input. */
export function positionsOf(call: ModelRequest): number[] {
  return String(call.input.positions ?? '')
    .split(',')
    .map((each) => Number(each.trim()))
    .filter((each) => Number.isInteger(each) && each > 0);
}

/**
 * A model that reads the file as `first` — one v2-shaped answer, a list of them (each a document),
 * or a whole part answer — and, asked the second read, answers each document it names as a reader
 * who agrees, or as `second` gives: one document's 14 fields, or a whole answer.
 */
export function reads(first: unknown = GOOD_ANSWER, second?: unknown) {
  const documents = Array.isArray(first)
    ? (first as JsonObject[])
    : isObject(first) && !Array.isArray(first.documents)
      ? [first]
      : undefined;
  return (call: ModelRequest, model: string) => {
    if (!isSecondRead(call)) {
      const part = documents ? partAnswer(documents.map((each) => documentAnswer(each))) : first;
      return Promise.resolve(completion(model, part));
    }
    if (isObject(second) && Array.isArray(second.documents)) {
      return Promise.resolve(completion(model, second));
    }
    const named = positionsOf(call);
    const each = (position: number): JsonObject =>
      isObject(second) ? second : secondAnswer(documents?.[position - 1] ?? GOOD_ANSWER);
    return Promise.resolve(
      completion(
        model,
        verifyAnswer(
          named.map((position) => [position, each(position)] as const),
          documents?.length ?? 1,
        ),
      ),
    );
  };
}

/** One attempt's answer, as the platform's model callback hands it over. */
export function completion(
  model: string,
  answer: unknown = partAnswer([documentAnswer()]),
  finishReason: ModelCompletion['finishReason'] = 'stop',
): ModelCompletion {
  return {
    text: typeof answer === 'string' ? answer : JSON.stringify(answer),
    model,
    finishReason,
    usage: { inputTokens: 1_900, outputTokens: 400, totalTokens: 2_300 },
  };
}
