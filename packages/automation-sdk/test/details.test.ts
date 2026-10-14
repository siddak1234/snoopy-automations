import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunResult } from '../src/contract.js';
import { RUN_DETAIL_LIMITS, boundedDetails } from '../src/details.js';
import { boundedResult } from '../src/platform.js';
import { RecordingPlatform } from '../src/testing.js';
import { assertValid, validator } from './published-schemas.js';
import { define, invoke } from './runner-fixtures.js';

/**
 * A successful run's `details` (platform ADR-0037): label and value lines for people, held to the
 * published `automation-run-result.json` — each label 1–40 characters, each value 1–200, 1 to
 * 20 lines — and bounded by the client so a run whose work is done is never unreportable.
 */

test('details within the bounds validate on a success, and nowhere else', () => {
  const validate = validator('automation-run-result');
  const details = [
    { label: 'Seller', value: 'Harrowgate Office Supply' },
    { label: 'Total', value: '$461.53' },
  ];
  assertValid(
    validate,
    { outcome: 'success', summary: 'Saved.', details },
    'a success with details',
  );
  assertValid(
    validate,
    { runId: 'r', outcome: 'success', details },
    'with the runId the client adds',
  );
  assert.equal(validate({ outcome: 'failed', failureReason: 'x', details }), false);
  assert.equal(validate({ outcome: 'success', details: [{ label: 'Seller' }] }), false);
  assert.equal(validate({ outcome: 'success', details: [{ label: '', value: 'x' }] }), false);
  assert.equal(
    validate({ outcome: 'success', details: [{ label: 'x'.repeat(41), value: 'x' }] }),
    false,
  );
  assert.equal(
    validate({ outcome: 'success', details: [{ label: 'x', value: 'x'.repeat(201) }] }),
    false,
  );
  assert.equal(
    validate({ outcome: 'success', details: [{ label: 'x', value: 'y', more: 1 }] }),
    false,
  );
  const many = Array.from({ length: 21 }, (_, index) => ({ label: `L${index}`, value: 'v' }));
  assert.equal(validate({ outcome: 'success', details: many }), false);
  // At least one line when sent at all: the client leaves an empty list off.
  assert.equal(validate({ outcome: 'success', details: [] }), false);
});

test('the client bounds each line: one line, cut whole, empty ones left out, at most 20, none at all left off', () => {
  assert.equal(boundedDetails(undefined), undefined);
  assert.equal(boundedDetails([]), undefined);
  assert.equal(
    boundedDetails([
      { label: '  ', value: 'x' },
      { label: 'x', value: '\n' },
    ]),
    undefined,
  );
  assert.deepEqual(
    boundedDetails([{ label: ' Seller\n', value: 'Harrowgate\n  Office  Supply ' }]),
    [{ label: 'Seller', value: 'Harrowgate Office Supply' }],
  );
  const [cut] = boundedDetails([{ label: 'L'.repeat(60), value: `${'v'.repeat(199)}😀` }]) ?? [];
  assert.equal(cut?.label.length, RUN_DETAIL_LIMITS.label);
  assert.equal(cut?.value, 'v'.repeat(199), 'a character is never split');
  const many = Array.from({ length: 25 }, (_, index) => ({ label: `L${index}`, value: 'v' }));
  assert.deepEqual(
    boundedDetails(many)?.map((line) => line.label),
    many.slice(0, 20).map((line) => line.label),
  );
});

test('a result is reported with its details bounded, and validates', () => {
  const validate = validator('automation-run-result');
  const result: RunResult = {
    outcome: 'success',
    summary: 'Saved.',
    details: [
      { label: 'Seller', value: 'x'.repeat(300) },
      { label: '', value: 'dropped' },
    ],
  };
  const bounded = boundedResult(result);
  assert.deepEqual(bounded, {
    outcome: 'success',
    summary: 'Saved.',
    details: [{ label: 'Seller', value: 'x'.repeat(200) }],
  });
  assertValid(validate, bounded, 'the bounded result');
  assert.deepEqual(boundedResult({ outcome: 'success', details: [] }), { outcome: 'success' });
});

test("the definition's details reach the run's result, and the recording platform keeps them bounded", async () => {
  const automation = define({
    result: () => ({ summary: 'Saved.', details: [{ label: 'Total', value: '  $461.53 ' }] }),
  });
  const platform = new RecordingPlatform();
  const result = await automation.execute(invoke(), platform);
  assert.deepEqual(result, {
    outcome: 'success',
    summary: 'Saved.',
    details: [{ label: 'Total', value: '  $461.53 ' }],
  });
  await platform.reportResult('run', result);
  assert.deepEqual(platform.results.at(-1)?.result, {
    outcome: 'success',
    summary: 'Saved.',
    details: [{ label: 'Total', value: '$461.53' }],
  });
});
