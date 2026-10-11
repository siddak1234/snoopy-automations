import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { loadPrompts } from '@autom8x/automation-sdk';

import {
  ANSWER_FIELDS,
  DOCUMENT_TYPES,
  LISTED_KINDS,
  PAYMENT_METHODS,
  REFUND_METHODS,
} from '../src/document.js';
import { EXTRACT_DOCUMENT_V1 } from '../src/prompts.js';
import { SPEND_TYPES } from '../src/spend-types.js';

/**
 * `prompts/extract-document.v1.json` as the owner's plan of 2026-10-11 words it (§4): the
 * opening line, 17 rules, the 27 fields of its table, 16 that may be empty, and the value
 * lists the code holds an answer to.
 */

const PROMPTS = resolve(import.meta.dirname, '..', 'prompts');

/** The 27 fields of the owner's plan of 2026-10-11 (§4's table), in the schema's order. */
const FIELDS = [
  'documentType',
  'documentCount',
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
  'lineItemsComplete',
  'listedItems',
  'listedItemsComplete',
  'uncertainFields',
];

/** The fields that may be empty: 16, the most Anthropic's strict mode allows in one request. */
const NULLABLE = [
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
  'cardLast4',
  'originalInvoiceNumber',
  'lineItems[].amount',
];

test("the prompt file loads, passes the platform's keyword check, names no model, has no placeholder, and holds the 27 decided fields", () => {
  // `loadPrompts` holds each file to `definePrompt`: the platform's keyword set, no model.
  const [loaded, ...others] = loadPrompts(PROMPTS);
  assert.deepEqual(others, [], 'one prompt file');
  assert.deepEqual(loaded, EXTRACT_DOCUMENT_V1);
  assert.deepEqual(
    [loaded?.id, loaded?.version, loaded?.capability],
    ['extract-document', 1, 'document-extraction'],
  );
  const raw = JSON.parse(readFileSync(join(PROMPTS, 'extract-document.v1.json'), 'utf8')) as object;
  assert.deepEqual(Object.keys(raw), ['id', 'version', 'capability', 'template', 'outputSchema']);
  const template = loaded?.template ?? '';
  assert.ok(!template.includes('{{'), 'no placeholder: nothing typed reaches the prompt');
  assert.ok(
    template.startsWith(
      'You extract the fields of one business document a company received: a bill, a receipt, a credit note or a statement.',
    ),
  );
  assert.ok(!/supplier invoice|invoiceNumber|invoiceCount/u.test(template), 'neutral words');
  assert.deepEqual(
    template
      .split('\n')
      .filter((line) => /^\d+\. /u.test(line))
      .map((line) => Number.parseInt(line, 10)),
    Array.from({ length: 17 }, (_, index) => index + 1),
    'the 17 rules, in order',
  );
  assert.deepEqual(ANSWER_FIELDS, FIELDS);
  const schema = loaded?.outputSchema as Schema;
  assert.deepEqual(Object.keys(schema.properties ?? {}), FIELDS);
  assert.deepEqual(schema.required, FIELDS, 'every field required');
  assert.equal(schema.additionalProperties, false);
  const field = (name: string) => schema.properties?.[name] ?? {};
  for (const list of ['lineItems', 'listedItems']) {
    const row = field(list).items ?? {};
    assert.equal(row.additionalProperties, false, list);
    assert.deepEqual(row.required, Object.keys(row.properties ?? {}), list);
  }
  assert.deepEqual(Object.keys(field('lineItems').items?.properties ?? {}), ['amount']);
  assert.deepEqual(Object.keys(field('listedItems').items?.properties ?? {}), [
    'reference',
    'amount',
    'kind',
  ]);
  assert.deepEqual(
    field('uncertainFields').items?.enum,
    FIELDS.filter(
      (name) => !['lineItemsComplete', 'listedItemsComplete', 'uncertainFields'].includes(name),
    ),
  );
  assert.deepEqual(nullableOf(schema), NULLABLE, '16 fields may be empty, 15 without cardLast4');
});

interface Schema {
  type?: unknown;
  enum?: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  additionalProperties?: unknown;
}

/** Every field whose type admits null, by path. */
function nullableOf(schema: Schema, at = ''): string[] {
  const found = Array.isArray(schema.type) && schema.type.includes('null') ? [at] : [];
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    found.push(...nullableOf(sub, at === '' ? name : `${at}.${name}`));
  }
  if (schema.items) found.push(...nullableOf(schema.items, `${at}[]`));
  return found;
}

test("the prompt's value lists are the code's: the 8 document types, the payment and refund methods, the 12 spend types, the listed rows' kinds", () => {
  const schema = EXTRACT_DOCUMENT_V1.outputSchema as unknown as Schema;
  const field = (name: string) => schema.properties?.[name] ?? {};
  assert.deepEqual(field('documentType').enum, DOCUMENT_TYPES);
  assert.deepEqual(DOCUMENT_TYPES, [
    'bill',
    'receipt',
    'credit_note',
    'supplier_statement',
    'bank_statement',
    'quote',
    'purchase_order',
    'other',
  ]);
  assert.deepEqual(field('paymentMethod').enum, PAYMENT_METHODS);
  assert.deepEqual(PAYMENT_METHODS, [
    'card',
    'cash',
    'check',
    'bank_transfer',
    'other',
    'not_shown',
  ]);
  assert.deepEqual(field('refundMethod').enum, REFUND_METHODS);
  assert.deepEqual(REFUND_METHODS, [
    'credit_on_account',
    'refund_to_card',
    'refund_by_check_or_cash',
    'not_shown',
    'not_applicable',
  ]);
  assert.deepEqual(field('spendType').enum, SPEND_TYPES);
  assert.equal(SPEND_TYPES.at(-1), 'other');
  assert.deepEqual(field('listedItems').items?.properties?.kind?.enum, LISTED_KINDS);
  assert.deepEqual(LISTED_KINDS, ['invoice', 'payment', 'credit', 'balance_forward']);
  // The rule that defines each list names every value in it.
  for (const values of [
    DOCUMENT_TYPES,
    PAYMENT_METHODS,
    REFUND_METHODS,
    SPEND_TYPES,
    LISTED_KINDS,
  ]) {
    for (const value of values) assert.ok(EXTRACT_DOCUMENT_V1.template.includes(value), value);
  }
});
