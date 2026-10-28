import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DRILL_MARKER, failureDrill } from '../src/drill.js';
import { defineFlow } from '../src/flow.js';
import { definePrompt } from '../src/prompt.js';
import { defineAutomation } from '../src/runner.js';
import { failed, settle } from '../src/settle.js';
import type { Automation, AutomationDefinition, Step } from '../src/steps.js';
import { RecordingPlatform } from '../src/testing.js';
import { FLOW_WORDS } from '../src/words.js';
import { TEMPLATE, invoke, manifest } from './runner-fixtures.js';

/**
 * The shared failure drill (Round 21, D2.5): a `defineFlow` flow ends every case in a typed
 * result in the SDK's or its own words, and a malformed answer twice ends held where the flow
 * holds it, else "couldn't be used"; a flow that lets a raw message through fails it.
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
  const cases = await failureDrill(
    defineFlow({ ...definition, holdUnmatched: ['read'], log: () => undefined }),
    fixture,
  );
  assert.deepEqual(
    cases.map((entry) => [entry.name, entry.reached, entry.result?.outcome]),
    [
      ['a: not connected (404)', true, 'failed'],
      ['a: provider_not_declared (403)', true, 'failed'],
      ['b: vendor down (502)', true, 'failed'],
      ['b: no answer', true, 'failed'],
      ['b: no answer from the app', true, 'failed'],
      ['c: malformed AI answer, twice', true, 'held'],
      ['d: timeout', true, 'failed'],
      ['e: a refused report after the app answered', true, 'failed'],
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
    FLOW_WORDS.unconfirmed,
    undefined,
    FLOW_WORDS.timeout,
    FLOW_WORDS.after_write,
  ]);
});

test('drill: without holdUnmatched a malformed answer twice ends "couldn\'t be used"; any other end fails it', async () => {
  const cases = await failureDrill(defineFlow({ ...definition, log: () => undefined }), fixture);
  const c = cases.find((entry) => entry.name.startsWith('c'));
  assert.deepEqual(c?.result, { outcome: 'failed', failureReason: FLOW_WORDS.ai_unusable });
  // A step that words the miss itself, as the old "unreadable" did, fails the drill.
  const unreadable = defineFlow({
    ...definition,
    steps: {
      read: (context) => read(context).catch(() => failed(FLOW_WORDS.ai_refused)),
      record,
    },
    log: () => undefined,
  });
  await assert.rejects(
    failureDrill(unreadable, fixture),
    /c: malformed AI answer, twice ends failed, neither held for a person nor/u,
  );
});

test('drill: "Try again" once an app may have done it fails it, naming the case', async () => {
  const retrySaying = defineFlow({
    ...definition,
    steps: {
      read,
      record: async (context) => {
        const sent = await settle(context, () =>
          context.platform.callProvider({
            providerId: 'p',
            operation: 'records.create',
            input: {},
          }),
        );
        return sent.ok ? { outcome: 'ok', summary: 'Recorded' } : failed(FLOW_WORDS.vendor_down);
      },
    },
    log: () => undefined,
  });
  await assert.rejects(
    failureDrill(retrySaying, fixture),
    /b: no answer from the app says "Try again" after an app may have done it/u,
  );
  const inner = defineFlow({ ...definition, log: () => undefined });
  const reportSaying: Automation = {
    ...inner,
    async execute(request, platform) {
      const result = await inner.execute(request, platform);
      return result.outcome === 'failed' && result.failureReason === FLOW_WORDS.after_write
        ? { ...result, failureReason: FLOW_WORDS.other }
        : result;
    },
  };
  await assert.rejects(
    failureDrill(reportSaying, fixture),
    /e: a refused report after the app answered says "Try again"/u,
  );
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
