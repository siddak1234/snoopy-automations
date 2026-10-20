import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { RunResult } from '../src/contract.js';
import {
  RUN_DOCUMENT_DECIMAL_PATTERN,
  RUN_DOCUMENT_LIMITS,
  boundedDocuments,
  decimalOf,
} from '../src/documents.js';
import { RESULT_BODY_LIMIT_BYTES, boundedResult } from '../src/platform.js';
import { EXAMPLE } from './document-fixture.js';
import { assertValid, schemas, validator } from './published-schemas.js';

/**
 * A run's `documents` (platform ADR-0039; the session's spec of 2026-10-15, §1.1, as the owner's
 * AM1 and AM7 change it — "no limits other than size"): one object per document the run read, held
 * to the published `automation-run-result.json`, every one kept with every line, reference and
 * detail, nothing cut but a detail line at the platform's shared bound, every amount a decimal
 * string or null, never rounded (B-T8). The one size guard is the result's body (AM1).
 */

test('the example document validates on a success and on a held run, and never on a failed one', () => {
  const validate = validator('automation-run-result');
  assertValid(validate, { outcome: 'success', documents: [EXAMPLE] }, 'a success');
  assertValid(
    validate,
    {
      runId: 'r',
      outcome: 'held',
      held: { stepId: 'ask-approval', reason: 'Document 1: new vendor.', state: {} },
      documents: [EXAMPLE],
    },
    'a held run',
  );
  assert.equal(validate({ outcome: 'failed', failureReason: 'x', documents: [EXAMPLE] }), false);
  assert.equal(validate({ outcome: 'success', documents: [] }), false, 'at least one when sent');
  assert.equal(validate({ outcome: 'success', documents: [{ ...EXAMPLE, total: 17.19 }] }), false);
  assert.equal(
    validate({ outcome: 'success', documents: [{ ...EXAMPLE, total: '1,234.56' }] }),
    false,
  );
  assert.equal(validate({ outcome: 'success', documents: [{ ...EXAMPLE, time: '25:00' }] }), false);
  assert.equal(validate({ outcome: 'success', documents: [{ ...EXAMPLE, extra: 1 }] }), false);
  // AM7: nothing is skipped, and an invoice is a type of its own.
  assert.equal(
    validate({ outcome: 'success', documents: [{ ...EXAMPLE, status: 'skipped' }] }),
    false,
  );
  assertValid(
    validate,
    { outcome: 'success', documents: [{ ...EXAMPLE, type: 'invoice' }] },
    'an invoice',
  );
  const { numberLabel: _label, ...withoutLabel } = EXAMPLE;
  assert.equal(validate({ outcome: 'success', documents: [withoutLabel] }), false);
});

test('no count is bounded: a file of 40 documents, one with 300 lines, 30 references and 25 details, validates', () => {
  const many = Array.from({ length: 40 }, (_, at) => ({
    ...EXAMPLE,
    index: at + 1,
    lineItems: Array.from({ length: at === 0 ? 300 : 1 }, () => EXAMPLE.lineItems[0]!),
    references: Array.from({ length: 30 }, (_, n) => ({ label: `Ref ${n}`, value: `${n}` })),
    details: Array.from({ length: 25 }, (_, n) => ({ label: `L${n}`, value: 'v' })),
  }));
  assertValid(validator('automation-run-result'), { outcome: 'success', documents: many }, '40');
  const bounded = boundedDocuments(many)!;
  assert.equal(bounded.length, 40);
  assert.equal(bounded[0]?.lineItems.length, 300);
  assert.equal(bounded[0]?.references.length, 30);
  assert.equal(bounded[0]?.details.length, 25);
  assert.equal(bounded[0]?.lineItemsComplete, true);
});

test('a decimal string is the number as written — never rounded, never an exponent', () => {
  assert.equal(decimalOf(412.5), '412.5');
  assert.equal(decimalOf(3.98), '3.98');
  assert.equal(decimalOf(-25), '-25');
  assert.equal(decimalOf(-0), '0');
  assert.equal(decimalOf(0.1234), '0.1234');
  // P6 (the platform's Build 22; AM1, AM7 — no limit but size): any number of digits.
  assert.equal(decimalOf(0.12345), '0.12345', 'a fifth decimal');
  assert.equal(decimalOf(1234567890123), '1234567890123', 'thirteen whole digits');
  assert.equal(decimalOf(1e21), null, 'an exponent');
  assert.equal(decimalOf(1e-7), null, 'an exponent');
  assert.equal(decimalOf(Number.NaN), null);
  assert.equal(decimalOf('17.19'), null, 'only a number is converted');
  assert.equal(decimalOf(null), null);
});

test("the decimal pattern is the published schemas' own, every amount and quantity in both: no digit limit (P6)", () => {
  const amounts = new Set([
    'quantity',
    'unitPrice',
    'amount',
    'subtotal',
    'tax',
    'tip',
    'discount',
    'total',
  ]);
  const patterns: string[] = [];
  const walk = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) value.forEach((item) => walk(item));
    else if (typeof value === 'object' && value !== null) {
      const node = value as Record<string, unknown>;
      if (key !== undefined && amounts.has(key) && typeof node.pattern === 'string') {
        patterns.push(node.pattern);
      }
      for (const [child, inner] of Object.entries(node)) walk(inner, child);
    }
  };
  for (const name of ['automation-run-result', 'automation-mail-request']) {
    walk(JSON.parse(readFileSync(join(schemas, `${name}.json`), 'utf8')));
  }
  // 16 in the result (the success's and the held run's documents), 8 in the run-results mail.
  assert.equal(patterns.length, 24);
  for (const pattern of patterns) assert.equal(pattern, RUN_DOCUMENT_DECIMAL_PATTERN.source);
  const long = '1234567890123.12345';
  const [kept] = boundedDocuments([{ ...EXAMPLE, total: long, subtotal: `-${long}` }])!;
  assert.deepEqual([kept?.total, kept?.subtotal], [long, `-${long}`], 'kept whole');
  assertValid(validator('automation-run-result'), { outcome: 'success', documents: [kept] }, long);
});

test('the client keeps every text whole, on one line; cuts only a detail line; makes a bad value null', () => {
  const long = 'x'.repeat(300);
  const [bounded] = boundedDocuments([
    {
      ...EXAMPLE,
      statusText: `  ${long}\n`,
      vendor: { name: long, address: '  ', city: 'Fresno,\nCA', storeNumber: long },
      number: long,
      numberLabel: ' ',
      references: [
        { label: 'PO #', value: long },
        { label: ' ', value: '7' },
      ],
      date: '14/10/2026',
      time: '2:32 PM',
      currency: 'usd',
      lineItems: [{ description: long, quantity: '1,000', unitPrice: '3.98', amount: '3.98' }],
      subtotal: '15.923456',
      tip: '1e3',
      payment: { method: 'card', cardLast4: '441' },
      recordedIn: { providerId: 'QuickBooks', recordType: 'expense', recordId: '1' },
      details: [{ label: 'y'.repeat(50), value: long }],
    },
  ])!;
  assert.ok(bounded);
  assert.equal(bounded.statusText, long, 'one line, whole');
  assert.equal(bounded.vendor.name, long);
  assert.equal(bounded.vendor.address, null, 'nothing left is null');
  assert.equal(bounded.vendor.city, 'Fresno, CA');
  assert.equal(bounded.number, long);
  assert.equal(bounded.numberLabel, null);
  assert.deepEqual(bounded.references, [{ label: 'PO #', value: long }], 'an empty one left out');
  assert.equal(bounded.date, null);
  assert.equal(bounded.time, null);
  assert.equal(bounded.currency, null);
  assert.equal(bounded.lineItems[0]?.description, long);
  assert.equal(bounded.lineItems[0]?.quantity, null, 'a separator is not a decimal');
  assert.equal(bounded.lineItems[0]?.unitPrice, '3.98');
  assert.equal(bounded.subtotal, '15.923456', 'any number of decimals (P6)');
  assert.equal(bounded.tip, null, 'an exponent is not a decimal');
  assert.equal(bounded.payment.cardLast4, null);
  assert.equal(bounded.recordedIn, null, 'a provider id outside its pattern is no record');
  assert.deepEqual(
    bounded.details.map((line) => [line.label.length, line.value.length]),
    [[RUN_DOCUMENT_LIMITS.detailLabelLength, RUN_DOCUMENT_LIMITS.detailValueLength]],
  );
  assertValid(
    validator('automation-run-result'),
    { outcome: 'success', documents: [bounded] },
    'bounded',
  );
});

test('a NUL or half a surrogate pair never reaches the wire: the platform cannot store either and refuses the document (its #287)', () => {
  const [bounded] = boundedDocuments([
    {
      ...EXAMPLE,
      statusText: 'Saved\u0000',
      vendor: { ...EXAMPLE.vendor, name: 'Lo\u0000we\u0007s \ud83d' },
      references: [{ label: 'PO \udc00#', value: '7\u0000' }],
      lineItems: [
        {
          description: 'Stud \ud83d\ude00 \ud83d',
          quantity: '4',
          unitPrice: null,
          amount: '15.92',
        },
      ],
      details: [{ label: 'Category', value: 'Mate\u0000rials\udfff' }],
    },
  ])!;
  assert.ok(bounded);
  // The platform's own test (`snoopy-backend/packages/contracts/src/run-documents.ts`, `textCheck`).
  const unstorable = /[\u0000\ud800-\udfff]/u;
  const texts = [
    bounded.statusText,
    bounded.vendor.name,
    ...bounded.references.flatMap((reference) => [reference.label, reference.value]),
    bounded.lineItems[0]?.description,
    ...bounded.details.flatMap((line) => [line.label, line.value]),
  ];
  assert.ok(
    texts.every((text) => typeof text === 'string' && !unstorable.test(text)),
    texts.join('|'),
  );
  assert.equal(bounded.statusText, 'Saved');
  assert.equal(bounded.vendor.name, 'Lo we s \uFFFD');
  assert.deepEqual(bounded.references, [{ label: 'PO \uFFFD#', value: '7' }]);
  assert.equal(
    bounded.lineItems[0]?.description,
    'Stud \ud83d\ude00 \uFFFD',
    'a whole pair is kept',
  );
  assert.equal(bounded.details[0]?.value, 'Mate rials\uFFFD');
});

test('none is left off, and an empty status line is refused, as the platform refuses it', () => {
  assert.equal(boundedDocuments(undefined), undefined);
  assert.equal(boundedDocuments([]), undefined);
  assert.throws(
    () => boundedDocuments([{ ...EXAMPLE, statusText: ' \n ' }]),
    /statusText is empty/u,
  );
  assert.deepEqual(
    boundedDocuments([EXAMPLE]),
    [EXAMPLE],
    'a document within every bound is kept as it is',
  );
});

test('the client bounds the documents of a success and of a held result, and sends none when there are none', () => {
  const spaced = { ...EXAMPLE, statusText: ' Recorded\nin QuickBooks: expense ' };
  const success = boundedResult({ outcome: 'success', documents: [spaced] }) as Extract<
    RunResult,
    { outcome: 'success' }
  >;
  assert.equal(success.documents?.[0]?.statusText, 'Recorded in QuickBooks: expense');
  const held = boundedResult({
    outcome: 'held',
    held: { stepId: 'ask-approval', reason: 'Document 1: new vendor.', state: {} },
    documents: [spaced],
  }) as Extract<RunResult, { outcome: 'held' }>;
  assert.equal(held.documents?.[0]?.statusText, 'Recorded in QuickBooks: expense');
  assert.equal('documents' in boundedResult({ outcome: 'success', documents: [] }), false);
});

test("the one size guard: a success whose body would pass the platform's 256 KiB leaves out its unpublished output, never a document", () => {
  const big = { outcome: 'recorded', note: 'z'.repeat(RESULT_BODY_LIMIT_BYTES) };
  const result = boundedResult({
    outcome: 'success',
    summary: '1 receipt: 1 recorded in QuickBooks.',
    output: big,
    documents: [EXAMPLE],
  }) as Extract<RunResult, { outcome: 'success' }>;
  assert.equal(result.output, undefined, 'the output left out');
  assert.deepEqual(result.documents, [EXAMPLE], 'every document kept');
  assert.equal(result.summary, '1 receipt: 1 recorded in QuickBooks.');
  const small = boundedResult({ outcome: 'success', output: { outcome: 'documents' } });
  assert.deepEqual(
    small,
    { outcome: 'success', output: { outcome: 'documents' } },
    'kept when it fits',
  );
});

/**
 * Where a document is, and where it went (the platform's ADR-0045; Invoice Processing v6): an
 * optional `source` — the uploaded file's artifact id and, when the automation can tell, its
 * pages — and an optional `recordedIn.accountName`. Both validate as published; a value the
 * platform would refuse is left out, never sent, so the document itself still reports.
 */
test('a source and an account name validate as published, and a value the platform would refuse is left out', () => {
  const validate = validator('automation-run-result');
  const file = '5d0f3a8e-2c41-4b7a-9e15-0a6c3f2b7d94';
  const recordedIn = { ...EXAMPLE.recordedIn!, accountName: 'Northwind Trading LLC' };
  const placed = { ...EXAMPLE, recordedIn, source: { file, pages: [1, 2] } };
  assertValid(validate, { outcome: 'success', documents: [placed] }, 'a source with pages');
  assertValid(
    validate,
    { outcome: 'success', documents: [{ ...placed, source: { file } }] },
    'a source without pages (v6: one file, pages not told)',
  );
  assert.equal(
    validate({ outcome: 'success', documents: [{ ...placed, source: { pages: [1] } }] }),
    false,
    'a source names its file',
  );
  assert.deepEqual(boundedDocuments([placed]), [placed], 'kept whole within every bound');

  const [noPages, badFile, longName] = boundedDocuments([
    { ...placed, source: { file, pages: [2, 1] } },
    { ...placed, source: { file: 'not-an-id' } },
    { ...placed, recordedIn: { ...recordedIn, accountName: 'x'.repeat(201) } },
  ])!;
  assert.deepEqual(noPages!.source, { file }, 'pages out of order are left out; the file stays');
  assert.equal('source' in badFile!, false, 'a file id the platform would refuse: no source');
  assert.equal('accountName' in longName!.recordedIn!, false, 'past 200 characters: left out');
  assert.deepEqual(
    boundedDocuments([{ ...placed, source: { file, pages: [0] } }])![0]!.source,
    { file },
    'page 0 is not a page',
  );
  for (const document of [noPages, badFile, longName]) {
    assertValid(validate, { outcome: 'success', documents: [document] }, 'what is sent validates');
  }
});
