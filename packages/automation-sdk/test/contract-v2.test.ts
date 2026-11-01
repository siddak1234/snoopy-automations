import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BATCH_LIMITS, batchUnitsProblem, boundedUnits, type BatchUnit } from '../src/batch.js';
import { isInvokeRequest } from '../src/contract.js';
import {
  RUN_INPUT_LIMITS,
  artifactIdsOf,
  chosenOptions,
  maxFilesOf,
  optionValues,
  type ManifestSetupField,
} from '../src/manifest.js';
import { MEMORY_LIMITS, memoryProblem } from '../src/memory.js';
import { modelRequestProblem } from '../src/model-request.js';
import { boundedResult } from '../src/result.js';
import { DECISION_LIMITS, boundedDecisions } from '../src/review.js';
import { invokeFixture, unitFixture } from '../src/testing.js';
import { assertValid, schemas, validator } from './published-schemas.js';

/**
 * The platform round 2 shapes (platform ADR-0048 amendments 3 and 4) against the PUBLISHED schemas
 * (`contract/schemas`, vendored at snoopy-backend d9f7fe2): a bigger dropdown's options, a
 * several-file run input, a review's `group` and 400 changes, the memory callbacks, a model
 * request's `pages`, a manifest's `batch`, a batch run's `units` and a child invoke's `unit` — and
 * the SDK's copies of their bounds held to the schema and the menu.
 */

const FILE = '33333333-3333-4333-8333-333333333333';
const menu = JSON.parse(readFileSync(join(schemas, 'platform-menu.json'), 'utf8')) as {
  limits: {
    batch: Record<string, number>;
    memory: Record<string, number>;
    runInput: Record<string, number>;
  };
};

test("the SDK's bounds are the menu's", () => {
  for (const [key, value] of Object.entries(BATCH_LIMITS)) {
    assert.equal(menu.limits.batch[key], value, `limits.batch.${key}`);
  }
  assert.deepEqual(menu.limits.memory, { ...MEMORY_LIMITS });
  assert.deepEqual(menu.limits.runInput, { ...RUN_INPUT_LIMITS });
});

test('a batch run, its units and a child invoke are what the platform sends and takes', () => {
  const unit: BatchUnit = {
    label: 'Jane Doe · Oct 12, 2026',
    artifacts: [{ artifactId: FILE, pages: { from: 1, to: 3 } }],
    data: { patient: 'Jane Doe' },
  };
  assertValid(
    validator('automation-run-result'),
    { runId: FILE, outcome: 'success', units: boundedUnits([unit]) },
    'a batch run answering units',
  );
  const child = invokeFixture({ unit: unitFixture(unit) });
  const batch = invokeFixture({ batch: true });
  for (const [what, invoke] of [
    ['a child', child],
    ['a batch run', batch],
  ] as const) {
    assertValid(validator('automation-invoke-request'), invoke, what);
    assert.ok(isInvokeRequest(invoke), what);
  }
  assert.equal(isInvokeRequest({ ...child, unit: { label: 'x' } }), false);
});

test("a batch's units the platform would refuse are refused before anything is sent", () => {
  const unit = (overrides: Partial<BatchUnit> = {}): BatchUnit => ({
    label: 'Visit 1',
    artifacts: [{ artifactId: FILE }],
    data: {},
    ...overrides,
  });
  assert.equal(batchUnitsProblem([unit()]), undefined);
  assert.match(batchUnitsProblem([])!, /1 to 500 units/u);
  assert.match(batchUnitsProblem(Array.from({ length: 501 }, () => unit()))!, /1 to 500/u);
  assert.match(batchUnitsProblem([unit({ artifacts: [] })])!, /1 to 50 files/u);
  assert.match(batchUnitsProblem([unit({ artifacts: [{ artifactId: 'x' }] })])!, /upload/u);
  const twice = [{ artifactId: FILE }, { artifactId: FILE.toUpperCase() }];
  assert.match(batchUnitsProblem([unit({ artifacts: twice })])!, /names a file twice/u);
  const pages = [{ artifactId: FILE, pages: { from: 1, to: 21 } }];
  assert.match(batchUnitsProblem([unit({ artifacts: pages })])!, /at most 20 pages/u);
  assert.match(batchUnitsProblem([unit({ data: { x: 'y'.repeat(8_200) } })])!, /8192 bytes/u);
  // A label is one line, cut whole; an empty one cannot be fixed.
  const [cut] = boundedUnits([unit({ label: `a\n${'b'.repeat(200)}` })])!;
  assert.equal(cut!.label.length, BATCH_LIMITS.unitLabelLength);
  assert.throws(() => boundedUnits([unit({ label: '  ' })]), /label must be 1 to 120/u);
  // Every result the client sends is held to them.
  assert.throws(() => boundedResult({ outcome: 'success', units: [] }), /1 to 500 units/u);
});

test("a model request's pages: a PDF's range of at most 20, only with a file, held to the schema", () => {
  const request = {
    capability: 'document-extraction' as const,
    prompt: 'p',
    input: {},
    outputSchema: {},
  };
  const validate = validator('automation-model-request');
  const withPages = { ...request, artifactId: FILE, pages: { from: 2, to: 21 } } as const;
  assertValid(validate, withPages, 'a page range');
  assert.equal(modelRequestProblem(withPages), undefined);
  assert.match(
    modelRequestProblem({ ...withPages, pages: { from: 1, to: 21 } })!,
    /at most 20 pages/u,
  );
  assert.match(
    modelRequestProblem({ ...withPages, pages: { from: 3, to: 2 } })!,
    /from must not be after/u,
  );
  assert.equal(
    modelRequestProblem({ ...request, pages: { from: 1, to: 2 } } as never),
    'pages needs an artifactId',
  );
});

test('a review groups its changes, up to 400, a group on every change or none', () => {
  const decisions = Array.from({ length: DECISION_LIMITS.decisions }, (_, at) => ({
    id: `v1-${at}`,
    label: `Add N18.${at}`,
    group: `Jane Doe · Oct 12, 2026${'\n'}`,
  }));
  const bounded = boundedDecisions(decisions)!;
  assert.equal(bounded[0]!.group, 'Jane Doe · Oct 12, 2026');
  assertValid(
    validator('automation-run-result'),
    {
      runId: FILE,
      outcome: 'held',
      held: { stepId: 'decide', reason: 'Review', state: {}, decisions: bounded },
    },
    'a held run of 400 grouped changes',
  );
  assert.throws(() => boundedDecisions([...decisions, { id: 'x-1', label: 'x' }]), /1 to 400/u);
  const mixed = [decisions[0]!, { id: 'v2-1', label: 'Add Z99.2' }];
  assert.throws(() => boundedDecisions(mixed), /every change or on none/u);
  assert.throws(() => boundedDecisions([{ ...decisions[0]!, group: ' ' }]), /group/u);
});

test('the memory callbacks: a key and a value the platform takes, held to the schemas', () => {
  assertValid(validator('automation-memory-get-request'), { key: 'accepted-codes' }, 'a get');
  assertValid(
    validator('automation-memory-put-request'),
    { key: 'accepted-codes', value: { N18: 3 } },
    'a put',
  );
  assert.equal(memoryProblem('accepted-codes', { N18: 3 }), undefined);
  for (const key of ['', 'Upper', 'a_b', 'k'.repeat(65)]) {
    assert.ok(memoryProblem(key), key);
    assert.equal(validator('automation-memory-get-request')({ key }), false, key);
  }
  assert.match(memoryProblem('big', 'x'.repeat(MEMORY_LIMITS.valueBytes))!, /65536 bytes/u);
});

test("a bigger dropdown's options: object values saved, labels shown, strings as before", () => {
  const field: ManifestSetupField = {
    key: 'specialties',
    control: 'select',
    multiple: true,
    options: [
      { value: '207RN0300X', label: 'Nephrology', group: 'Allopathic & Osteopathic Physicians' },
      {
        value: '207R00000X',
        label: 'Internal Medicine',
        group: 'Allopathic & Osteopathic Physicians',
      },
    ],
  };
  assert.deepEqual(optionValues(field), ['207RN0300X', '207R00000X']);
  assert.deepEqual(chosenOptions({ specialties: ['207R00000X', 'Nephrology'] }, field), [
    '207R00000X',
  ]);
  assert.deepEqual(
    chosenOptions({ s: 'b' }, { key: 's', control: 'select', options: ['a', 'b'] }),
    ['b'],
  );
});

test('a several-file run input: a list of upload ids into one run, at most maxFiles', () => {
  assert.deepEqual(artifactIdsOf({ notes: [FILE, 7, FILE] }, 'notes'), [FILE, FILE]);
  assert.deepEqual(artifactIdsOf({ notes: FILE }, 'notes'), [FILE]);
  assert.deepEqual(artifactIdsOf({}, 'notes'), []);
  assert.equal(maxFilesOf({ key: 'notes', control: 'artifact' }), 1);
  assert.equal(maxFilesOf({ key: 'notes', control: 'artifact', multiple: true }), 50);
  assert.equal(maxFilesOf({ key: 'n', control: 'artifact', multiple: true, maxFiles: 9 }), 9);
});
