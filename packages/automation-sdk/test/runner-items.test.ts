import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { isInvokeRequest } from '../src/contract.js';
import { isInvokeItem } from '../src/item.js';
import { isManifest, type Manifest } from '../src/manifest.js';
import {
  RecordingPlatform,
  declaredItemSteps,
  declaredSteps,
  invokeFixture,
  itemFixture,
} from '../src/testing.js';
import { assertValid, validator } from './published-schemas.js';
import { TEMPLATE, define, invoke, manifest, ok } from './runner-fixtures.js';

/**
 * A flow's items (platform ADR-0046, Round 19): the invoke's `item` and `readsItem`, and the
 * runner running a version's `items.pipeline` on an item run — the run that reads a new item's
 * file — and only there; every other run runs its `pipeline`.
 */

const withItems = (version = 1): Manifest => ({
  ...manifest(version, ['receive', 'score']),
  items: { file: { key: 'jobFile' }, pipeline: [{ id: 'job-received' }, { id: 'read-job' }] },
});

const steps = {
  receive: ok('Received', { candidate: true }),
  score: ok('Scored'),
  'job-received': ok('Job received', { job: true }),
  'read-job': ok('Job read'),
};

const reading = { title: 'Senior Accountant', mustHaves: ['CPA'] };

test('an invoke carrying an item, or reading one, validates and passes the guard', () => {
  const validate = validator('automation-invoke-request');
  const run = invokeFixture({ item: itemFixture({ fields: { role: 'Accountant' }, reading }) });
  const itemRun = invokeFixture({ item: itemFixture(), readsItem: true });
  for (const [what, value] of [
    ['a run of an item', run],
    ['an item run', itemRun],
  ] as const) {
    assertValid(validate, value, what);
    assert.ok(isInvokeRequest(value), what);
  }
});

test('an item the published schema refuses is refused by the guard', () => {
  const validate = validator('automation-invoke-request');
  const refused: [string, Record<string, unknown>][] = [
    ['a field that is no string', { ...itemFixture(), fields: { role: 3 } }],
    ['a reading that is a list', { ...itemFixture(), reading: [] }],
    ['no reading at all', { id: 'i', fields: {} }],
    ['no id', { fields: {}, reading: null }],
    ['fields that are a list', { ...itemFixture(), fields: ['HR'] }],
  ];
  for (const [what, item] of refused) {
    const value = { ...invokeFixture(), item };
    assert.equal(validate(value), false, `${what}: the schema`);
    assert.equal(isInvokeItem(item), false, what);
    assert.equal(isInvokeRequest(value), false, what);
  }
  const readsItemFalse = { ...invokeFixture(), readsItem: false };
  assert.equal(validate(readsItemFalse), false, 'readsItem false: the schema');
  assert.equal(isInvokeRequest(readsItemFalse), false, 'readsItem is true or absent');
});

test('an item run runs the items pipeline alone, and a run of the item the pipeline alone', async () => {
  const automation = define({ manifests: [withItems()], steps });
  const itemRun = new RecordingPlatform();
  const read = await automation.execute(invoke({ item: itemFixture(), readsItem: true }), itemRun);
  assert.deepEqual(
    itemRun.steps.map((step) => step.stepId),
    ['job-received', 'read-job'],
  );
  assert.deepEqual(read, { outcome: 'success', output: { job: true }, summary: 'Done' });

  const run = new RecordingPlatform();
  const scored = await automation.execute(invoke({ item: itemFixture({ reading }) }), run);
  assert.deepEqual(
    run.steps.map((step) => step.stepId),
    ['receive', 'score'],
  );
  assert.deepEqual(scored, { outcome: 'success', output: { candidate: true }, summary: 'Done' });
});

test('a version without items has no item run: the run fails, saying so, and runs nothing', async () => {
  const automation = define({
    manifests: [manifest(1, ['receive', 'score'])],
    steps: { receive: steps.receive, score: steps.score },
  });
  const platform = new RecordingPlatform();
  const result = await automation.execute(invoke({ readsItem: true }), platform);
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason: `${TEMPLATE} v1 declares no items, so it has no item run to run`,
  });
  assert.deepEqual(platform.steps, []);
});

test('the runner refuses at startup an item step it cannot run, or an id the two pipelines share', () => {
  const { 'read-job': _read, ...withoutReadJob } = steps;
  assert.throws(
    () => define({ manifests: [withItems()], steps: withoutReadJob }),
    new RegExp(`${TEMPLATE} v1 declares step "read-job", which the code does not implement`, 'u'),
  );
  const shared: Manifest = {
    ...withItems(),
    items: { file: { key: 'jobFile' }, pipeline: [{ id: 'receive' }] },
  };
  assert.throws(
    () => define({ manifests: [shared], steps }),
    new RegExp(`${TEMPLATE} v1 declares step "receive" twice`, 'u'),
  );
  // An item step is a declared step: the code may implement it beside the run's.
  assert.deepEqual([...define({ manifests: [withItems()], steps }).steps].sort(), [
    'job-received',
    'read-job',
    'receive',
    'score',
  ]);
});

test("a run's title, score, verdict and sections reach the result, bounded by the client", async () => {
  const automation = define({
    manifests: [withItems()],
    steps,
    result: () => ({
      summary: 'Strong match · meets 3 of 3 must-haves',
      title: '  Jane   Doe ',
      score: 82,
      verdict: 'positive',
      sections: [{ title: 'Skills', entries: [{ title: 'Reconciliations' }] }],
    }),
  });
  const platform = new RecordingPlatform();
  const run = invoke({ item: itemFixture({ reading }) });
  const result = await automation.execute(run, platform);
  assert.equal((result as { score?: number }).score, 82);
  await platform.reportResult(run.runId, result);
  const [{ result: sent }] = platform.results as unknown as [{ result: Record<string, unknown> }];
  assert.equal(sent.title, 'Jane Doe');
  assert.equal(sent.verdict, 'positive');
  assert.deepEqual(sent.sections, [{ title: 'Skills', entries: [{ title: 'Reconciliations' }] }]);
  assertValid(validator('automation-run-result'), { runId: run.runId, ...sent }, 'what is sent');
});

test('a manifest declaring items is read with its file key and its item steps, or refused', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-items-'));
  try {
    const path = join(directory, `${TEMPLATE}.v1.json`);
    writeFileSync(path, JSON.stringify(withItems()));
    assert.deepEqual([...declaredSteps(path)], ['receive', 'score']);
    assert.deepEqual([...declaredItemSteps(path)], ['job-received', 'read-job']);
    writeFileSync(path, JSON.stringify(manifest(1, ['receive'])));
    assert.deepEqual([...declaredItemSteps(path)], [], 'none without items');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const items = withItems().items!;
  assert.ok(isManifest(withItems()));
  assert.equal(isManifest({ ...withItems(), items: { ...items, pipeline: [] } }), false);
  assert.equal(isManifest({ ...withItems(), items: { pipeline: items.pipeline } }), false);
  assert.equal(isManifest({ ...withItems(), items: { ...items, pipeline: [{}] } }), false);
});
