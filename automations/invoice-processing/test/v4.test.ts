import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  readManifest,
  readManifests,
  type JsonObject,
  type Manifest,
} from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define, servedManifests } from '../src/automation.js';
import {
  HARROWGATE,
  LOWES,
  THREE_RECEIPTS,
  TIDEWELL,
  approve,
  documentsRun,
  type DocumentsRun,
  type Run,
} from './documents-world.js';
import { NONE, QUICKBOOKS, isSecondRead, lines, manifests, manifestsRoot } from './fixtures.js';

/**
 * Invoice Processing v4 (Build 22, the session's spec of 2026-10-17, §3, V1): the image serves v4
 * alone, and v4 is v3's automation — the same 22 steps, run by the same code — shown in five steps.
 * Run on v4's manifest and on v3's, the same file gives the same steps reported, the same model
 * and QuickBooks calls and the same result; and every step a run reports falls in step 1, 3 or 4
 * of the five, in order, so the run page's five-step tracker fills in order — step 2 is the flow's
 * choice and step 5 the platform's email, neither a step this code reports.
 */

const v3 = readManifest(join(manifestsRoot, 'invoice-processing.v3.json'));
const [v4] = manifests as [Manifest];

/** v3's manifest, numbered as the run asks — what the runner reads of it is v3's alone. */
const V3_AS_RUN: readonly Manifest[] = [{ ...v3, version: v4.version }];

/** Receipt 2 with its total unreadable: it waits for approval while the others go on. */
const NO_TOTAL = { ...HARROWGATE, total: null, uncertainFields: ['total'] };

/** What a run did, to compare: each step reported, each model and QuickBooks call, the result. */
const record = (run: Run) => ({
  steps: lines(run.platform),
  modelCalls: run.platform.modelCalls,
  providerCalls: run.platform.providerCalls,
  mails: run.platform.mails,
  result: run.result,
});

/** The step of the five each reported step is drawn in, by v4's manifest. */
function stepsOfTheFive(stepIds: readonly string[]): string[] {
  const groupOf = new Map(v4.pipeline.map((step) => [step.id, step.group]));
  return stepIds.map((id) => groupOf.get(id) ?? `undeclared ${id}`);
}

/** In order, never back, only upload, process and record; upload first. */
function assertTrackerInOrder(stepIds: readonly string[], label: string): void {
  const order = (v4.groups ?? []).map((group) => group.id);
  const drawn = stepsOfTheFive(stepIds);
  assert.equal(drawn[0], 'upload', `${label}: the run starts in step 1`);
  for (const group of drawn) {
    assert.ok(['upload', 'process', 'record'].includes(group), `${label}: ${group}`);
  }
  const at = drawn.map((group) => order.indexOf(group));
  assert.deepEqual(
    at,
    [...at].sort((a, b) => a - b),
    `${label}: in order, ${drawn.join(' ')}`,
  );
}

test('the image serves v5 alone: of v1 to v5 it keeps v5, and refuses a run pinned to v3 before any step or call', async () => {
  const all = readManifests(manifestsRoot, TEMPLATE_ID);
  assert.deepEqual(
    all.map((each) => each.version),
    [1, 2, 3, 4, 5],
  );
  const automation = define(all, { log: () => undefined });
  assert.deepEqual(automation.versions, [5]);
  assert.throws(() => servedManifests([v3]), /serves v5, and no such manifest was given/u);

  const platform = new RecordingPlatform();
  const result = await automation.execute(
    invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 3, config: QUICKBOOKS }),
    platform,
  );
  assert.equal(result.outcome, 'failed', JSON.stringify(result));
  assert.deepEqual(
    [platform.steps, platform.modelCalls, platform.providerCalls, platform.mails],
    [[], [], [], []],
  );
});

const CASES: [string, DocumentsRun][] = [
  ['three receipts, QuickBooks', { documents: THREE_RECEIPTS, config: QUICKBOOKS }],
  ['three receipts, None', { documents: THREE_RECEIPTS, config: NONE }],
];

for (const [label, run] of CASES) {
  test(`v4 runs v3's steps as v3 does — ${label}: the same steps, the same model and QuickBooks calls, the same result; the tracker in order`, async () => {
    const onV4 = await documentsRun(run);
    const onV3 = await documentsRun({ ...run, manifests: V3_AS_RUN });
    assert.equal(onV4.result.outcome, 'success', JSON.stringify(onV4.result).slice(0, 300));
    assert.deepEqual(record(onV4), record(onV3));
    // One model call reads the photo of three receipts, as on v3: model calls per file unchanged.
    assert.equal(onV4.platform.modelCalls.length, 1);
    assertTrackerInOrder(
      onV4.platform.steps.map((step) => step.stepId),
      label,
    );
    assert.ok(stepsOfTheFive(onV4.platform.steps.map((step) => step.stepId)).includes('record'));
  });
}

test("v4 runs v3's steps as v3 does — a doubtful receipt: one second read, the same hold, the same approval's continuation; the tracker in order", async () => {
  const run: DocumentsRun = { documents: [TIDEWELL, NO_TOTAL, LOWES], config: QUICKBOOKS };
  const onV4 = await documentsRun(run);
  const onV3 = await documentsRun({ ...run, manifests: V3_AS_RUN });
  assert.equal(onV4.result.outcome, 'held', JSON.stringify(onV4.result).slice(0, 300));
  assert.deepEqual(record(onV4), record(onV3));
  assert.deepEqual(
    [onV4.platform.modelCalls.length, onV4.platform.modelCalls.filter(isSecondRead).length],
    [2, 1],
    'the first read and one second read, as on v3',
  );
  const held = onV4.platform.steps.map((step) => step.stepId);
  assertTrackerInOrder(held, 'held');
  assert.equal(held.at(-1), 'ask-approval');

  const approvedOnV4 = await approve(onV4);
  const approvedOnV3 = await approve(onV3);
  assert.equal(approvedOnV4.result.outcome, 'success');
  const continued = ({ result, steps, providerCalls }: typeof approvedOnV4) => ({
    result,
    steps,
    providerCalls,
  });
  assert.deepEqual(continued(approvedOnV4), continued(approvedOnV3));
  assert.deepEqual(
    [...new Set(stepsOfTheFive(approvedOnV4.steps.map(([stepId]) => stepId)))],
    ['record'],
    "after approval, every step is step 4's",
  );
});

test('the config v3 flows carry runs on v4 unchanged: the vendor and the approval limit under the same keys', async () => {
  const config: JsonObject = { vendor: 'quickbooks', holdAboveAmount: 750 };
  const onV4 = await documentsRun({ documents: THREE_RECEIPTS, config });
  const onV3 = await documentsRun({ documents: THREE_RECEIPTS, config, manifests: V3_AS_RUN });
  assert.deepEqual(record(onV4), record(onV3));
  assert.ok(onV4.platform.providerCalls.length > 0, 'QuickBooks chosen, QuickBooks called');
});
