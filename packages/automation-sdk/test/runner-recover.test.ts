import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MIN_STEP_BACKOFF_MS } from '../src/retry.js';
import type { StepResult } from '../src/steps.js';
import { RecordingPlatform } from '../src/testing.js';
import { noAnswer, posting, recordedWaits, retrying } from './retry-fixtures.js';
import { define, invoke, ok } from './runner-fixtures.js';

/**
 * `recover` (platform ADR-0037): a step that threw until its attempts were spent may be ended
 * with the automation's own result — reported under the step's id and acted on as if the step
 * had returned it — and only then; without one, or when it gives none, the throw ends the run as
 * before.
 */

const waited = recordedWaits();

function timeline(platform: RecordingPlatform): string[][] {
  return platform.steps.map((step) => [step.stepId, step.outcome, step.summary]);
}

const goesOn: StepResult = {
  outcome: 'failed',
  summary: 'Not posted; the run goes on',
  state: { posted: false },
};

test('a step whose attempts are spent on a throw ends with the recovered result, and the run goes on', async () => {
  const failure = await noAnswer();
  const platform = new RecordingPlatform();
  platform.provider = () => Promise.reject(failure);
  const seen: { stepId: string; error: unknown; attempts: number }[] = [];
  const automation = define({
    manifests: [
      {
        templateId: 'under-test',
        version: 1,
        requiredCapabilities: [],
        pipeline: [{ id: 'receive' }, { id: 'post' }, { id: 'finish' }],
      },
    ],
    steps: { receive: ok('Received'), post: posting, finish: ok('Finished') },
    retry: { post: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS } },
    recover: (stepId, error) => {
      seen.push({ stepId, error, attempts: platform.providerCalls.length });
      return goesOn;
    },
    result: (state) => ({ output: { ...state }, summary: 'Done' }),
  });
  const result = await automation.execute(invoke(), platform);
  assert.deepEqual(
    seen,
    [{ stepId: 'post', error: failure, attempts: 3 }],
    'asked once, after the third attempt',
  );
  assert.deepEqual(waited, [MIN_STEP_BACKOFF_MS, 2 * MIN_STEP_BACKOFF_MS]);
  assert.deepEqual(timeline(platform), [
    ['receive', 'ok', 'Received'],
    ['post', 'failed', 'Not posted; the run goes on (after 3 attempts)'],
    ['finish', 'ok', 'Finished'],
  ]);
  assert.deepEqual(result, { outcome: 'success', output: { posted: false }, summary: 'Done' });
});

test('a recovered result that ends the run, or skips the step, is acted on as a returned one would be', async () => {
  const failure = await noAnswer();
  for (const [recovered, expected] of [
    [
      { outcome: 'failed', summary: 'Stopped', failureReason: 'It stopped.' },
      { outcome: 'failed', failureReason: 'It stopped.' },
    ],
    [{ outcome: 'skipped' }, { outcome: 'success', output: { received: true }, summary: 'Done' }],
  ] as const) {
    const platform = new RecordingPlatform();
    platform.provider = () => Promise.reject(failure);
    const automation = define({
      steps: {
        receive: ok('Received', { received: true }),
        validate: ok('Validated'),
        post: posting,
      },
      recover: () => recovered as StepResult,
    });
    assert.deepEqual(await automation.execute(invoke(), platform), expected);
  }
});

test('without recover, or when it gives no result, the throw ends the run as before', async () => {
  const failure = await noAnswer();
  for (const automation of [
    retrying(),
    define({
      steps: { receive: ok('Received'), validate: ok('Validated'), post: posting },
      recover: () => undefined,
    }),
  ]) {
    const platform = new RecordingPlatform();
    platform.provider = () => Promise.reject(failure);
    await assert.rejects(automation.execute(invoke(), platform), (error) => error === failure);
    assert.deepEqual(timeline(platform).at(-1), ['post', 'failed', 'The post step failed']);
  }
});

test('recover is never asked about a step that returned, whatever it returned', async () => {
  let asked = 0;
  const automation = define({
    steps: {
      receive: ok('Received'),
      validate: () =>
        Promise.resolve({ outcome: 'failed', summary: 'Invalid', failureReason: 'Invalid.' }),
      post: ok('Posted'),
    },
    recover: () => {
      asked += 1;
      return goesOn;
    },
  });
  const result = await automation.execute(invoke(), new RecordingPlatform());
  assert.deepEqual(result, { outcome: 'failed', failureReason: 'Invalid.' });
  assert.equal(asked, 0);
});
