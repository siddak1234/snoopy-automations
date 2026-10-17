import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunResult } from '../src/contract.js';
import { RUN_DOCUMENT_LIMITS, boundedDocuments, decimalOf } from '../src/documents.js';
import { RESULT_BODY_LIMIT_BYTES, boundedResult } from '../src/platform.js';
import { EXAMPLE } from './document-fixture.js';
import { assertValid, validator } from './published-schemas.js';

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
  assert.equal(decimalOf(0.12345), null, 'a fifth decimal is not a decimal string here');
  assert.equal(decimalOf(1e21), null);
  assert.equal(decimalOf(1234567890123), null, 'thirteen whole digits');
  assert.equal(decimalOf(Number.NaN), null);
  assert.equal(decimalOf('17.19'), null, 'only a number is converted');
  assert.equal(decimalOf(null), null);
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
  assert.equal(bounded.subtotal, null);
  assert.equal(bounded.tip, null);
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
