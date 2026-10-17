import { cardDigits, cleanCurrency, cleanText, parseDate } from '@autom8x/automation-kit/values';
import { RUN_DOCUMENT_TIME_PATTERN, decimalOf } from '@autom8x/automation-sdk';

import type { DocumentAnswer } from './answer.js';
import type { DocumentRead } from './state.js';

/**
 * What a document's result carries of its read (`RunDocument`, the platform's ADR-0039; the
 * owner's "cu price, location, and more should be there", ~04:05Z, and AM7's "no limits other
 * than size"): every value the first read gave, each cleaned the one way — text as the kit cleans
 * it, never cut; a date only when it is a real day; a time only as 24-hour HH:MM; a currency only
 * when ISO 4217 knows it; card digits only when they are four; amounts and quantities as decimal
 * strings exactly as the model wrote the number, never rounded — and every line, in its order.
 */

const day = (value: unknown): string | null => {
  const reading = parseDate(value);
  return reading.kind === 'date' ? reading.date : null;
};

function time(value: unknown): string | null {
  const text = cleanText(value);
  return text !== null && RUN_DOCUMENT_TIME_PATTERN.test(text) ? text : null;
}

/**
 * A supplier's statement's rows are its lines: the invoices, payments and credits it lists, each
 * by its reference and amount — so the result holds the whole statement, as it holds a receipt.
 */
function linesOf(answer: DocumentAnswer): DocumentRead['lineItems'] {
  if (answer.documentType === 'supplier_statement' && answer.listedItems.length > 0) {
    return answer.listedItems.map((row) => ({
      description: cleanText(row.reference),
      quantity: null,
      unitPrice: null,
      amount: decimalOf(row.amount),
    }));
  }
  return answer.lineItems.map((line) => ({
    description: cleanText(line.description),
    quantity: decimalOf(line.quantity),
    unitPrice: decimalOf(line.unitPrice),
    amount: decimalOf(line.amount),
  }));
}

/** Whether every line the document has was read. */
function linesComplete(answer: DocumentAnswer): boolean {
  if (answer.documentType === 'supplier_statement' && answer.listedItems.length > 0) {
    return answer.listedItemsComplete;
  }
  return answer.lineItemsComplete && answer.lineItems.length >= answer.lineItemCount;
}

export function documentReadOf(answer: DocumentAnswer): DocumentRead {
  const currency = cleanCurrency(answer.currency);
  const card = cardDigits(answer.cardLast4);
  const references = answer.references.flatMap((reference) => {
    const label = cleanText(reference.label);
    const value = cleanText(reference.value);
    return label === null || value === null ? [] : [{ label, value }];
  });
  return {
    type: answer.documentType,
    vendor: {
      name: cleanText(answer.vendorName),
      address: cleanText(answer.vendorAddress),
      city: cleanText(answer.vendorCity),
      storeNumber: cleanText(answer.storeNumber),
    },
    number: cleanText(answer.documentNumber),
    numberLabel: cleanText(answer.numberLabel),
    references,
    date: day(answer.documentDate),
    time: time(answer.documentTime),
    currency: currency.kind === 'code' ? currency.code : null,
    lineItems: linesOf(answer),
    lineItemsComplete: linesComplete(answer),
    subtotal: decimalOf(answer.subtotal),
    tax: decimalOf(answer.tax),
    tip: decimalOf(answer.tip),
    discount: decimalOf(answer.discount),
    total: decimalOf(answer.total),
    shipping: decimalOf(answer.shipping),
    amountDue: decimalOf(answer.amountDue),
    dueDate: day(answer.dueDate),
    payment: {
      method: answer.paymentMethod,
      cardLast4: card.kind === 'digits' ? card.digits : null,
    },
    spendType: answer.spendType,
  };
}

/**
 * A document read in two parts, one: the first part's fields, the lines of both in order, complete
 * only when both are — the continuing part repeats the fields and lists the lines from where the
 * first stopped (`prompts/extract-documents.v1.json`, rule 1).
 */
export function joinedAnswer(first: DocumentAnswer, rest: DocumentAnswer): DocumentAnswer {
  return {
    ...first,
    lineItems: [...first.lineItems, ...rest.lineItems],
    lineItemsComplete: first.lineItemsComplete && rest.lineItemsComplete,
    lineItemCount: Math.max(first.lineItemCount, rest.lineItemCount),
  };
}
