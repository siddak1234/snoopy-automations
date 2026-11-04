import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reaskingOnce } from '../src/flow.js';
import { ModelRefusedError } from '../src/refusals.js';
import { defineAutomation } from '../src/runner.js';
import type { Step } from '../src/steps.js';
import { RecordingPlatform } from '../src/testing.js';
import { FLOW_WORDS } from '../src/words.js';
import { classify, completion } from './flow-fixtures.js';
import { TEMPLATE, invoke, manifest } from './runner-fixtures.js';

/**
 * Q2 for a flow on `defineAutomation` (`reaskingOnce`; Invoice Processing v8, Resume Screening v3):
 * an answer off its schema is asked once more with `missLine`, and a second miss is thrown on for
 * the flow to end "The AI's answer couldn't be used. Try a clearer file." — never a third call,
 * never a hold. The other callbacks reach the platform unchanged.
 */

/** A step that reads, and ends the run with `FLOW_WORDS.ai_unusable` on an answer off its schema. */
const reading: Step = async ({ platform }) => {
  try {
    const answer = await platform.callModel(classify, {});
    return { outcome: 'ok', summary: 'Read', state: { kind: JSON.parse(answer.text).kind } };
  } catch (error) {
    if (error instanceof ModelRefusedError && error.reason === 'output_schema_mismatch') {
      return {
        outcome: 'failed',
        summary: FLOW_WORDS.ai_unusable,
        failureReason: FLOW_WORDS.ai_unusable,
      };
    }
    throw error;
  }
};

const automation = defineAutomation({
  templateId: TEMPLATE,
  manifests: [manifest(1, ['read'], ['classification'])],
  prompts: [classify],
  steps: { read: reading },
  result: (state) => ({ output: state, summary: 'Done' }),
});

test('Q2 on defineAutomation: an answer off its schema is asked once more with the fixed line; a good one ends ok', async () => {
  const platform = new RecordingPlatform();
  platform.model = () =>
    Promise.resolve(
      completion(platform.modelCalls.length === 1 ? '{"kind":"memo"}' : '{"kind":"bill"}'),
    );
  const logged: unknown[][] = [];
  const result = await automation.execute(
    invoke(),
    reaskingOnce(platform, (...line) => void logged.push(line)),
  );
  assert.equal(result.outcome, 'success');
  assert.equal(platform.modelCalls.length, 2, 'one more paid call');
  assert.equal(
    platform.modelCalls[1]?.prompt,
    `${platform.modelCalls[0]?.prompt}\n\nYour last answer did not match the schema at $.kind (enum). Answer again with only the JSON object the schema describes.`,
  );
  assert.deepEqual(logged, [
    ['info', 'model_reasked', { reason: 'output_schema_mismatch', path: '$.kind', rule: 'enum' }],
  ]);
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome]),
    [['read', 'ok']],
    'the reports reach the platform',
  );
});

test('Q2 on defineAutomation: a second miss ends the run "The AI\'s answer couldn\'t be used", after two calls and no hold', async () => {
  const platform = new RecordingPlatform();
  platform.model = () => Promise.resolve(completion('{"kind":"memo"}'));
  const result = await automation.execute(invoke(), reaskingOnce(platform));
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.ai_unusable });
  assert.equal(platform.modelCalls.length, 2, 'asked once more, never a third time');
});

test('without it, defineAutomation asks once: the re-ask is the wrapper’s alone', async () => {
  const platform = new RecordingPlatform();
  platform.model = () => Promise.resolve(completion('{"kind":"memo"}'));
  const result = await automation.execute(invoke(), platform);
  assert.equal(result.outcome, 'failed');
  assert.equal(platform.modelCalls.length, 1);
});

test('the other callbacks and the memory reach the platform as they are', async () => {
  const platform = new RecordingPlatform();
  const wrapped = reaskingOnce(platform);
  await wrapped.memory.put('a-key', { n: 1 });
  assert.deepEqual(await platform.memory.get('a-key'), { n: 1 });
  await wrapped.reportResult('r', { outcome: 'failed', failureReason: 'x' });
  assert.equal(platform.results.length, 1);
});
