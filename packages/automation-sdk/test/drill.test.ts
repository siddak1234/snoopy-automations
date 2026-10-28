import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DRILL_MARKER, failureDrill } from '../src/drill.js';
import { defineFlow } from '../src/flow.js';
import { definePrompt } from '../src/prompt.js';
import { defineAutomation } from '../src/runner.js';
import { failed, settle } from '../src/settle.js';
import type { AutomationDefinition, Step } from '../src/steps.js';
import { RecordingPlatform } from '../src/testing.js';
import { FLOW_WORDS } from '../src/words.js';
import { TEMPLATE, invoke, manifest } from './runner-fixtures.js';

/**
 * The shared failure drill (Round 21, D2.5): a `defineFlow` flow ends every case in a typed
 * result in the SDK's or its own words, and a malformed answer twice ends held; a flow that
 * lets a raw message through fails it.
 */

const classify = definePrompt({
  id: 'classify',
  version: 1,
  capability: 'classification',
  template: 'Which kind?',
  outputSchema: { type: 'object', properties: { kind: { enum: ['bill'] } }, required: ['kind'] },
});

const read: Step = async ({ platform }) => {
  const answer = await platform.callModel(classify, {});
  return { outcome: 'ok', summary: 'Read', state: { kind: JSON.parse(answer.text).kind } };
};

const record: Step = async (context) => {
  const sent = await settle(context, () =>
    context.platform.callProvider({ providerId: 'p', operation: 'records.create', input: {} }),
  );
  return sent.ok ? { outcome: 'ok', summary: 'Recorded' } : failed(sent.sentence, sent.kind);
};

const definition: AutomationDefinition = {
  templateId: TEMPLATE,
  manifests: [manifest(1, ['read', 'record'], ['classification'])],
  prompts: [classify],
  steps: { read, record },
  retry: { record: { attempts: 2, backoffMs: 10_000 } },
  result: () => ({ summary: 'Done' }),
};

const fixture = {
  request: invoke(),
  platform: () => {
    const platform = new RecordingPlatform();
    platform.model = (_call, model) =>
      Promise.resolve({
        text: '{"kind":"bill"}',
        model,
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
    return platform;
  },
  words: '',
};

test('drill: a defineFlow flow passes every case, and a malformed answer twice ends held', async () => {
  const cases = await failureDrill(defineFlow({ ...definition, log: () => undefined }), fixture);
  assert.deepEqual(
    cases.map((entry) => [entry.name, entry.reached, entry.result?.outcome]),
    [
      ['a: not connected (404)', true, 'failed'],
      ['a: provider_not_declared (403)', true, 'failed'],
      ['b: vendor down (502)', true, 'failed'],
      ['b: no answer', true, 'failed'],
      ['c: malformed AI answer, twice', true, 'held'],
      ['d: timeout', true, 'failed'],
    ],
  );
  const reasons = cases.map((entry) =>
    entry.result?.outcome === 'failed' ? entry.result.failureReason : undefined,
  );
  assert.deepEqual(reasons, [
    FLOW_WORDS.not_connected,
    FLOW_WORDS.not_declared,
    FLOW_WORDS.ai_busy,
    FLOW_WORDS.unanswered,
    undefined,
    FLOW_WORDS.timeout,
  ]);
});

test('drill: a flow that throws raw text fails it, naming the case', async () => {
  await assert.rejects(
    failureDrill(defineAutomation(definition), fixture),
    (error: unknown) =>
      error instanceof Error &&
      /the failure drill failed: b: vendor down \(502\) threw/u.test(error.message) &&
      /c: malformed AI answer, twice threw/u.test(error.message),
  );
  // Words in neither the SDK's nor the flow's fail it too.
  const own = defineFlow({
    ...definition,
    steps: { read, record: () => Promise.resolve(failed(`Not saved: ${DRILL_MARKER}`)) },
    log: () => undefined,
  });
  await assert.rejects(failureDrill(own, fixture), /shows a raw message/u);
  const unlisted = defineFlow({
    ...definition,
    steps: { read, record: () => Promise.resolve(failed('Not saved.')) },
    log: () => undefined,
  });
  await assert.rejects(failureDrill(unlisted, fixture), /ends with words in neither/u);
  assert.ok(await failureDrill(unlisted, { ...fixture, words: '| Not saved. |' }));
});
