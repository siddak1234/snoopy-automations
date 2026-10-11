import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { FILE_LIMITS } from '../src/file.js';
import { extractWorld } from './extract-world.js';
import { completion, everythingSaid, lines, setUp } from './fixtures.js';
import { measure, referenceOf } from './measure.js';
import {
  SAMPLES,
  SAMPLES_DIRECTORY,
  expectedOf,
  expectedPath,
  sameAsCommitted,
  samplePath,
} from './sample-maker/samples.js';

/**
 * The made-up sample documents: each made again from its code, each with its `expected.json`
 * and a marker printed in a line's text or a notes box — never in the seller's name or the
 * document number, which the lines carry by design — each a file `receive` accepts, and each
 * expected answer passed on whole by `extract`, its marker never in a timeline line or a reason.
 */

test('the samples are the 25 decided cases, one directory each, nothing else', () => {
  assert.deepEqual(
    SAMPLES.map((sample) => sample.name),
    [
      'typed-text-pdf',
      'scanned-image-pdf',
      'phone-photo-jpeg',
      'png-screenshot',
      'handwritten-png',
      'long-300-lines',
      'receipt',
      'two-invoices',
      'missing-page',
      'injected-instructions',
      // The owner's plan of 2026-10-11, §4's new samples, in its order.
      'store-receipt',
      'restaurant-tip-written-total',
      'restaurant-tip-under-total',
      'card-slip-tip-only',
      'card-slip',
      'handwritten-cash-receipt',
      'long-thermal-receipt',
      'cash-back-receipt',
      'paid-invoice',
      'credit-memo',
      'card-refund',
      'utility-statement-balance',
      'utility-account-number',
      'supplier-statement',
      'bank-card-statement',
    ],
  );
  assert.deepEqual(
    readdirSync(SAMPLES_DIRECTORY).sort(),
    SAMPLES.map((sample) => sample.name).sort(),
  );
  for (const sample of SAMPLES) {
    assert.deepEqual(
      readdirSync(`${SAMPLES_DIRECTORY}/${sample.name}`).sort(),
      ['expected.json', sample.file].sort(),
    );
  }
  const markers = SAMPLES.map((sample) => sample.marker);
  assert.equal(new Set(markers).size, markers.length, 'a marker each');
});

test('each sample is made again from its code: the same bytes, or for a PNG the same pixels', () => {
  for (const sample of SAMPLES) {
    assert.ok(
      sameAsCommitted(sample, sample.make()),
      `${sample.name}: run scripts/make-samples.ts and commit what it writes`,
    );
  }
});

test("each expected.json is its sample's entry, and its answer never carries the marker: not in the seller's name, not in the document number", () => {
  for (const sample of SAMPLES) {
    const expected = JSON.parse(readFileSync(expectedPath(sample), 'utf8')) as JsonObject;
    assert.deepEqual(expected, expectedOf(sample), sample.name);
    assert.ok(!JSON.stringify(sample.answer).includes(sample.marker), sample.name);
    assert.ok(['line', 'notes'].includes(sample.markerIn), sample.name);
  }
  // The routes §4 asks for: every document type but a quote or an order, and both tip cases.
  const types = new Set(SAMPLES.map((sample) => sample.answer.documentType));
  for (const type of ['bill', 'receipt', 'credit_note', 'supplier_statement', 'bank_statement']) {
    assert.ok(types.has(type), type);
  }
  const tipped = SAMPLES.filter((sample) => sample.answer.tip !== null).map(
    (sample) => sample.name,
  );
  assert.deepEqual(tipped, [
    'restaurant-tip-written-total',
    'restaurant-tip-under-total',
    'card-slip-tip-only',
  ]);
});

test('each sample is a file receive accepts: its declared kind, within 3.5 MB, 10 pages and 8,000 px', async () => {
  for (const sample of SAMPLES) {
    const measured = measure(readFileSync(samplePath(sample)));
    const declared = { 'application/pdf': 'pdf', 'image/jpeg': 'jpeg', 'image/png': 'png' };
    assert.equal(measured.kind, declared[sample.contentType], sample.name);
    assert.ok(measured.sizeBytes <= FILE_LIMITS.maximumSizeBytes, sample.name);
    const world = setUp({ file: referenceOf(measured) });
    await world.run();
    assert.equal(
      lines(world.platform)[0]?.[1],
      'ok',
      `${sample.name}: ${lines(world.platform)[0]?.[2]}`,
    );
  }
  // The long thermal receipt at the long side the apps shrink a photo to.
  const thermal = SAMPLES.find((sample) => sample.name === 'long-thermal-receipt');
  const measured = measure(readFileSync(samplePath(thermal!)));
  assert.deepEqual([measured.width, measured.height], [600, 2_576]);
});

test('a text PDF prints every name, number and amount its answer gives, and its marker where the sample says', () => {
  // Every PDF but the scan, which holds a picture of its words and no text.
  const textPdfs = SAMPLES.filter(
    (sample) => sample.contentType === 'application/pdf' && sample.name !== 'scanned-image-pdf',
  );
  assert.equal(textPdfs.length, 13);
  const grouped = (value: number) => value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  for (const sample of textPdfs) {
    const text = readFileSync(samplePath(sample), 'latin1');
    const printed = (value: string) => text.includes(value.replace(/[\\()]/gu, (c) => `\\${c}`));
    const { answer } = sample;
    for (const field of [
      'vendorName',
      'documentNumber',
      'originalInvoiceNumber',
      'cardLast4',
    ] as const) {
      const value = answer[field];
      if (typeof value === 'string') assert.ok(printed(value), `${sample.name}: ${field}`);
    }
    for (const line of answer.lineItems as { amount: number }[]) {
      assert.ok(printed(grouped(line.amount)), `${sample.name}: ${line.amount}`);
    }
    for (const row of answer.listedItems as { reference: string; amount: number }[]) {
      assert.ok(printed(row.reference), `${sample.name}: ${row.reference}`);
      assert.ok(printed(grouped(row.amount)), `${sample.name}: ${row.amount}`);
    }
    for (const field of [
      'subtotal',
      'tax',
      'shipping',
      'discount',
      'total',
      'amountDue',
      'tip',
    ] as const) {
      const value = answer[field];
      if (typeof value === 'number') assert.ok(printed(grouped(value)), `${sample.name}: ${field}`);
    }
    // The marker on its own row of the page, beside a line's text or in the notes.
    const row = text.split('\n').find((each) => each.includes(sample.marker)) ?? '';
    assert.ok(row !== '', `${sample.name}: the marker is printed`);
    assert.ok(
      !row.includes(String(answer.documentNumber)),
      `${sample.name}: not beside its number`,
    );
  }
});

test("each sample's expected answer passes extract whole, and its marker never reaches a line or a reason", async () => {
  for (const sample of SAMPLES) {
    const world = extractWorld();
    world.platform.model = (_call, model) => Promise.resolve(completion(model, sample.answer));
    assert.deepEqual((await world.state())?.extraction, sample.answer, sample.name);

    // The whole run, on the sample's own measurements; then an unusable answer carrying it.
    const run = setUp({ file: referenceOf(measure(readFileSync(samplePath(sample)))) });
    run.platform.model = (_call, model) => Promise.resolve(completion(model, sample.answer));
    const result = await run.run();
    assert.equal(result.outcome, 'success', sample.name);
    assert.ok(!everythingSaid(run.platform, result).includes(sample.marker), sample.name);
    const unusable = setUp();
    unusable.platform.model = (_call, model) =>
      Promise.resolve(completion(model, { ...sample.answer, marker: sample.marker }));
    const failed = await unusable.run();
    assert.equal(failed.outcome, 'failed', sample.name);
    assert.ok(!everythingSaid(unusable.platform, failed).includes(sample.marker), sample.name);
  }
});

test('an answer stays well inside the 8,000-token cap: every expected one, and one of 40 lines and 40 listed rows', () => {
  // At 3 characters a token, the most an answer may take is 24,000 characters.
  const largest = Math.max(...SAMPLES.map((sample) => JSON.stringify(sample.answer).length));
  assert.ok(largest < 6_000, `the largest expected answer is ${largest} characters`);
  const statement = SAMPLES.find((sample) => sample.name === 'supplier-statement')!.answer;
  const full = {
    ...statement,
    lineItems: Array.from({ length: 40 }, () => ({ amount: 1_234_567.89 })),
    listedItems: Array.from({ length: 40 }, (_, index) => ({
      reference: `INV-${String(index).padStart(10, '0')}`,
      amount: -1_234_567.89,
      kind: 'balance_forward',
    })),
  };
  const size = JSON.stringify(full).length;
  assert.ok(size < 8_000, `40 lines and 40 listed rows: ${size} characters`);
});
