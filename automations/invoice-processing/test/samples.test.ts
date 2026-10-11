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
 * The made-up sample invoices: each made again from its code, each with its `expected.json`
 * and its marker, each a file `receive` accepts, and each expected answer passed on whole by
 * `extract` — its marker never in a timeline line or a reason.
 */

test('the samples are the ten decided cases, one directory each, nothing else', () => {
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

test("each expected.json is its sample's entry, and its answer carries the marker in the invoice number", () => {
  for (const sample of SAMPLES) {
    const expected = JSON.parse(readFileSync(expectedPath(sample), 'utf8')) as JsonObject;
    assert.deepEqual(expected, expectedOf(sample), sample.name);
    assert.ok(String(sample.answer.invoiceNumber).includes(sample.marker), sample.name);
  }
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
});

test('a text PDF prints every name, number and amount its answer gives', () => {
  // Every PDF but the scan, which holds a picture of its words and no text.
  const textPdfs = SAMPLES.filter(
    (sample) => sample.contentType === 'application/pdf' && sample.name !== 'scanned-image-pdf',
  );
  assert.equal(textPdfs.length, 6);
  for (const sample of textPdfs) {
    const text = readFileSync(samplePath(sample), 'latin1');
    const printed = (value: string) => text.includes(value.replace(/[\\()]/gu, (c) => `\\${c}`));
    const { answer } = sample;
    for (const field of ['vendorName', 'invoiceNumber'] as const) {
      const value = answer[field];
      if (typeof value === 'string') assert.ok(printed(value), `${sample.name}: ${field}`);
    }
    for (const line of answer.lineItems as { description: string; amount: number }[]) {
      assert.ok(printed(line.description), `${sample.name}: ${line.description}`);
      assert.ok(printed(line.amount.toFixed(2)), `${sample.name}: ${line.amount}`);
    }
    for (const field of ['subtotal', 'tax', 'shipping', 'total'] as const) {
      const value = answer[field];
      if (typeof value === 'number') {
        const grouped = value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
        assert.ok(printed(grouped), `${sample.name}: ${field}`);
      }
    }
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
