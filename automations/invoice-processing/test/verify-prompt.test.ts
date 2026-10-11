import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { SECOND_READ_FIELDS } from '../src/checks/answers.js';
import { DOCUMENT_TYPES, PAYMENT_METHODS, REFUND_METHODS } from '../src/document.js';
import { EXTRACT_DOCUMENT_V1, VERIFY_DOCUMENT_V1 } from '../src/prompts.js';
import { SPEND_TYPES } from '../src/spend-types.js';

/**
 * `prompts/verify-document.v1.json` (the plan's §4, verify-read): read 2 uses read 1's own
 * definitions — the same opening, the same rule for each field it asks for, the same schema for
 * each field — for the 13 fields that go into QuickBooks and the type, plus `uncertainFields`:
 * 14 fields, 8 of which may be empty.
 */

interface Schema {
  type?: unknown;
  enum?: unknown;
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  additionalProperties?: unknown;
}

const PROMPTS = resolve(import.meta.dirname, '..', 'prompts');

function rulesOf(template: string): Map<number, string> {
  return new Map(
    template
      .split('\n')
      .filter((line) => /^\d+\. /u.test(line))
      .map((line) => {
        const [number, ...rest] = line.split('. ');
        return [Number(number), rest.join('. ')];
      }),
  );
}

test("the file: verify-document v1, document extraction, no model, no placeholder, read 1's opening", () => {
  const raw = JSON.parse(readFileSync(join(PROMPTS, 'verify-document.v1.json'), 'utf8')) as object;
  assert.deepEqual(Object.keys(raw), ['id', 'version', 'capability', 'template', 'outputSchema']);
  assert.deepEqual(
    [VERIFY_DOCUMENT_V1.id, VERIFY_DOCUMENT_V1.version, VERIFY_DOCUMENT_V1.capability],
    ['verify-document', 1, 'document-extraction'],
  );
  const { template } = VERIFY_DOCUMENT_V1;
  assert.ok(!template.includes('{{'), 'no placeholder: nothing of read 1, nothing typed');
  const opening = (text: string) => text.split('\n\nRules:\n')[0];
  assert.equal(opening(template), opening(EXTRACT_DOCUMENT_V1.template));
});

test("its 14 rules are read 1's, word for word, but where read 1 names a field read 2 does not ask for", () => {
  const first = rulesOf(EXTRACT_DOCUMENT_V1.template);
  const second = rulesOf(VERIFY_DOCUMENT_V1.template);
  assert.deepEqual(
    [...second.keys()],
    Array.from({ length: 14 }, (_, index) => index + 1),
  );
  // Read 1's rules, in order, that read 2 keeps: 10 (lines), 11 (count and pages) and 16
  // (listed rows) name only fields it does not ask for.
  const kept = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 17];
  const adapted = new Set([6, 7, 14, 15]);
  for (const [index, rule] of kept.entries()) {
    const own = second.get(index + 1) ?? '';
    if (adapted.has(rule)) assert.notEqual(own, first.get(rule), `rule ${rule} adapted`);
    else assert.equal(own, first.get(rule), `rule ${rule} word for word`);
  }
  assert.equal(
    second.get(6),
    'dueDate is for a bill only; use null on any other document. Give dueDate only when a due date is printed.',
  );
  // What read 1 alone asks for is never named.
  for (const field of [
    'paymentTermsDays',
    'originalInvoiceNumber',
    'lineItems',
    'listedItems',
    'documentCount',
    'pagesMissing',
    'subtotal',
    'discount',
    'tip is the tip',
  ]) {
    assert.ok(!VERIFY_DOCUMENT_V1.template.includes(field), field);
  }
});

test("its schema: the 14 fields, each exactly read 1's, every one required, 8 of them nullable", () => {
  const schema = VERIFY_DOCUMENT_V1.outputSchema as unknown as Schema;
  const firstSchema = EXTRACT_DOCUMENT_V1.outputSchema as unknown as Schema;
  assert.deepEqual(Object.keys(schema.properties ?? {}), [...SECOND_READ_FIELDS]);
  assert.deepEqual(schema.required, [...SECOND_READ_FIELDS]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.description, firstSchema.description);
  for (const field of SECOND_READ_FIELDS.filter((name) => name !== 'uncertainFields')) {
    assert.deepEqual(schema.properties?.[field], firstSchema.properties?.[field], field);
  }
  const unclear = schema.properties?.uncertainFields;
  assert.equal(unclear?.description, firstSchema.properties?.uncertainFields?.description);
  assert.deepEqual(unclear?.items?.enum, SECOND_READ_FIELDS.slice(0, -1));
  const nullable = Object.entries(schema.properties ?? {})
    .filter(([, sub]) => Array.isArray(sub.type) && sub.type.includes('null'))
    .map(([name]) => name);
  assert.deepEqual(nullable, [
    'vendorName',
    'documentNumber',
    'documentDate',
    'dueDate',
    'currency',
    'total',
    'amountDue',
    'cardLast4',
  ]);
  const field = (name: string) => schema.properties?.[name] ?? {};
  assert.deepEqual(field('documentType').enum, DOCUMENT_TYPES);
  assert.deepEqual(field('paymentMethod').enum, PAYMENT_METHODS);
  assert.deepEqual(field('refundMethod').enum, REFUND_METHODS);
  assert.deepEqual(field('spendType').enum, SPEND_TYPES);
});
