import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineFlow } from '../src/flow.js';
import { CallbackRefusedError } from '../src/refusals.js';
import { MIN_STEP_BACKOFF_MS } from '../src/retry.js';
import { defineAutomation } from '../src/runner.js';
import { failed, settle, type Settled } from '../src/settle.js';
import { held, type Step } from '../src/steps.js';
import { RecordingPlatform, refusalFixture } from '../src/testing.js';
import { FLOW_WORDS } from '../src/words.js';
import { classify, completion, flow, reading } from './flow-fixtures.js';
import { recordedWaits } from './retry-fixtures.js';
import { TEMPLATE, invoke, manifest } from './runner-fixtures.js';

/**
 * What `defineFlow` keeps per run and per attempt (Round 21, the second review): a Q2 hold only
 * where the flow names the step, the billed first call never made twice, the waits spread, and no
 * "run it again" once a provider call in the run may have written.
 */

const waited = recordedWaits();

test('Q2: the hold is offered only where the flow says the next step can use it; the approval resumes there', async () => {
  // No hold at a step the flow does not name: the approval would carry no fields to go on with.
  const unheld = flow(reading);
  const missing = new RecordingPlatform();
  missing.model = () => Promise.resolve(completion('{"kind":"memo"}'));
  assert.deepEqual(await unheld.automation.execute(invoke(), missing), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.ai_unusable,
  });
  assert.equal(missing.modelCalls.length, 2);
  // Named: the step after it reads `unmatchedAnswer` and goes on without the AI's fields.
  const seen: unknown[] = [];
  const automation = defineFlow({
    templateId: TEMPLATE,
    manifests: [manifest(1, ['read', 'route'], ['classification'])],
    prompts: [classify],
    steps: {
      read: reading,
      route: async ({ state }) => {
        seen.push(state.unmatchedAnswer);
        return state.unmatchedAnswer === 'read'
          ? { outcome: 'ok', summary: 'Sent to a person', state: { kind: 'by hand' } }
          : { outcome: 'ok', summary: 'Routed' };
      },
    },
    holdUnmatched: ['read'],
    result: (state) => ({ output: state, summary: 'Done' }),
    log: () => undefined,
  });
  const first = await automation.execute(invoke(), missing);
  assert.ok(first.outcome === 'held');
  const resumed = new RecordingPlatform();
  const result = await automation.execute(
    invoke({
      input: {},
      continuation: {
        ofRunId: invoke().runId,
        kind: 'approval',
        stepId: first.held.stepId,
        decision: 'approved',
        state: first.held.state,
      },
    }),
    resumed,
  );
  assert.deepEqual(seen, ['read']);
  assert.deepEqual(result, {
    outcome: 'success',
    output: { kind: 'by hand' },
    summary: 'Done',
  });
  assert.equal(resumed.modelCalls.length, 0, 'no paid call is made again');
  assert.throws(
    () => flow(reading, { holdUnmatched: ['nowhere'] }),
    /holdUnmatched names "nowhere"/u,
  );
});

test('decision 1: a good model answer, then an unsent 503 on the next call, ends unanswered; the paid first call is made once', async () => {
  const seen: Settled<unknown>[] = [];
  const twoCalls: Step = async (context) => {
    await context.platform.callModel(classify, {});
    const sent = await settle(context, () => context.platform.callModel(classify, {}));
    seen.push(sent);
    return sent.ok ? { outcome: 'ok', summary: 'Read' } : failed(sent.sentence, sent.kind);
  };
  const { automation } = flow(twoCalls, {
    retry: { read: { attempts: 2, backoffMs: MIN_STEP_BACKOFF_MS, when: 'unsent' } },
  });
  const platform = new RecordingPlatform();
  platform.model = () => Promise.resolve(completion('{"kind":"bill"}'));
  const recorded = platform.callModel.bind(platform);
  let calls = 0;
  platform.callModel = (request) =>
    ++calls === 1 ? recorded(request) : Promise.reject(new CallbackRefusedError('model', 503, ''));
  const result = await automation.execute(invoke(), platform);
  assert.equal(calls, 2, 'one first call, and the step is not run again');
  assert.deepEqual(
    seen.map((entry) => !entry.ok && entry.kind),
    ['unanswered'],
  );
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.ai_busy });
});

test('5a: defineFlow spreads the waits upward (spreadWaits); defineAutomation keeps them as written', async (t) => {
  t.mock.method(Math, 'random', () => 0.99);
  const busy: Step = () => Promise.reject(new CallbackRefusedError('provider', 503, ''));
  const retry = { read: { attempts: 2, backoffMs: MIN_STEP_BACKOFF_MS } };
  await flow(busy, { retry }).automation.execute(invoke(), new RecordingPlatform());
  assert.equal(waited.length, 1);
  assert.ok((waited[0] ?? 0) > MIN_STEP_BACKOFF_MS, `spread: ${waited[0]}`);
  waited.length = 0;
  // defineAutomation lets the spent throw reach the server; only its waits are asked here.
  await assert.rejects(
    defineAutomation({
      templateId: TEMPLATE,
      manifests: [manifest(1, ['read'])],
      steps: { read: busy },
      retry,
      result: () => ({ summary: 'Done' }),
    }).execute(invoke(), new RecordingPlatform()),
    CallbackRefusedError,
  );
  assert.deepEqual(waited, [MIN_STEP_BACKOFF_MS]);
});

test('once a provider call wrote, a later failure never says to run it again: settled or thrown', async () => {
  const write: Step = async (context) => {
    const sent = await settle(context, () =>
      context.platform.callProvider({ providerId: 'p', operation: 'records.create', input: {} }),
    );
    return sent.ok ? { outcome: 'ok', summary: 'Posted' } : failed(sent.sentence, sent.kind);
  };
  const two = (second: Step, sentences?: Record<string, string>) =>
    defineFlow({
      templateId: TEMPLATE,
      manifests: [manifest(1, ['post', 'tell'])],
      steps: { post: write, tell: second },
      ...(sentences === undefined ? {} : { sentences }),
      result: () => ({ summary: 'Done' }),
      log: () => undefined,
    });
  const platform = () => {
    const recording = new RecordingPlatform();
    recording.provider = () =>
      recording.providerCalls.length === 1
        ? Promise.resolve({ status: 201, body: {} })
        : Promise.reject(
            refusalFixture('provider', { status: 404, code: 'NOT_FOUND', detail: 'x' }),
          );
    return recording;
  };
  const settled = await two(write).execute(invoke(), platform());
  assert.deepEqual(settled, { outcome: 'failed', failureReason: FLOW_WORDS.after_write });
  assert.ok(settled.outcome === 'failed');
  assert.doesNotMatch(settled.failureReason, /run it again|try again/iu);
  // A vendor's own non-2xx inside a 200, after the write: the same.
  const inside = new RecordingPlatform();
  inside.provider = () =>
    Promise.resolve(
      inside.providerCalls.length === 1 ? { status: 201, body: {} } : { status: 409, body: {} },
    );
  assert.deepEqual(await two(write).execute(invoke(), inside), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.after_write,
  });
  // Thrown at a step with its own sentence: the note comes first.
  const throws: Step = () => Promise.reject(new Error('the raw text'));
  assert.deepEqual(await two(throws, { tell: 'Add it again.' }).execute(invoke(), platform()), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.after_write,
  });
  // Before any write, the kind's own sentence.
  const first = new RecordingPlatform();
  first.provider = () =>
    Promise.reject(refusalFixture('provider', { status: 404, code: 'NOT_FOUND', detail: 'x' }));
  assert.deepEqual(await two(write).execute(invoke(), first), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.not_connected,
  });
});

test('the note that a provider call wrote survives an approval: a settled failure after it never says to run it again', async () => {
  const post: Step = async (context) => {
    const sent = await settle(context, () =>
      context.platform.callProvider({ providerId: 'p', operation: 'records.create', input: {} }),
    );
    return sent.ok ? { outcome: 'ok', summary: 'Posted' } : failed(sent.sentence, sent.kind);
  };
  const seen: unknown[] = [];
  const automation = defineFlow({
    templateId: TEMPLATE,
    manifests: [manifest(1, ['post', 'check', 'again'])],
    steps: {
      post,
      check: async ({ state }) =>
        held({ summary: 'A person checks it', heldReason: 'Check it', state }),
      again: async (context) => {
        seen.push(Object.keys(context.state));
        return post(context);
      },
    },
    result: () => ({ summary: 'Done' }),
    log: () => undefined,
  });
  const writes = new RecordingPlatform();
  writes.provider = () => Promise.resolve({ status: 201, body: {} });
  const first = await automation.execute(invoke(), writes);
  assert.ok(first.outcome === 'held');
  const after = new RecordingPlatform();
  after.provider = () =>
    Promise.reject(refusalFixture('provider', { status: 404, code: 'NOT_FOUND', detail: 'x' }));
  const result = await automation.execute(
    invoke({
      input: {},
      continuation: {
        ofRunId: invoke().runId,
        kind: 'approval',
        stepId: first.held.stepId,
        decision: 'approved',
        state: first.held.state,
      },
    }),
    after,
  );
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.after_write });
  assert.deepEqual(seen, [[]], 'the steps never see the reserved key');
});
