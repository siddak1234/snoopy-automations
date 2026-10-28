import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModelCompletion, ModelRequest } from '../src/contract.js';
import { defineFlow, quotesIn, type FlowDefinition } from '../src/flow.js';
import { CallbackRefusedError } from '../src/refusals.js';
import { MIN_STEP_BACKOFF_MS } from '../src/retry.js';
import { failed, settle, type Settled } from '../src/settle.js';
import type { Step } from '../src/steps.js';
import { RecordingPlatform, refusalFixture } from '../src/testing.js';
import { FLOW_WORDS } from '../src/words.js';
import { recordedWaits } from './retry-fixtures.js';
import { TEMPLATE, invoke, manifest } from './runner-fixtures.js';
import { definePrompt } from '../src/prompt.js';

/**
 * `defineFlow` (Round 21, D2.1 and D2.4): a throw never reaches a person, a code reaches the log
 * only, Q2's re-ask then a hold, 5d's re-ask at the cap only below it, and no billed model call
 * made twice by the step retry once a model has answered.
 */

recordedWaits();

const classify = definePrompt({
  id: 'classify',
  version: 1,
  capability: 'classification',
  template: 'Which kind of document is this?',
  outputSchema: { type: 'object', properties: { kind: { enum: ['bill'] } }, required: ['kind'] },
});

const completion = (text: string, finishReason: ModelCompletion['finishReason'] = 'stop') => ({
  text,
  model: 'test-model',
  finishReason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

function flow(step: Step, overrides: Partial<FlowDefinition> = {}) {
  const logged: unknown[][] = [];
  const automation = defineFlow({
    templateId: TEMPLATE,
    manifests: [manifest(1, ['read'], ['classification'])],
    prompts: [classify],
    steps: { read: step },
    result: (state) => ({ output: state, summary: 'Done' }),
    log: (...line) => void logged.push(line),
    ...overrides,
  });
  return { automation, logged };
}

const reading: Step = async ({ platform }) => {
  const answer = await platform.callModel(classify, {}, { maxOutputTokens: 4_000 });
  return { outcome: 'ok', summary: 'Read', state: { kind: JSON.parse(answer.text).kind } };
};

test('defineFlow: no error.message reaches the failure reason; the log keeps its shape, not its text', async () => {
  const secret = 'ACCOUNT-9911 from the document';
  const { automation, logged } = flow(() => Promise.reject(new Error(secret)));
  const result = await automation.execute(invoke(), new RecordingPlatform());
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.other });
  assert.ok(!JSON.stringify(logged).includes(secret));
  assert.deepEqual(logged[0]?.slice(0, 2), ['error', 'step_threw']);
  // The flow's own sentence for that step, when it gives one.
  const own = flow(() => Promise.reject(new Error(secret)), {
    sentences: { read: 'Add it again.' },
  });
  assert.deepEqual(await own.automation.execute(invoke(), new RecordingPlatform()), {
    outcome: 'failed',
    failureReason: 'Add it again.',
  });
});

test('defineFlow: failed(sentence, code) ends with the sentence; the code reaches the log alone', async () => {
  const { automation, logged } = flow(() =>
    Promise.resolve(failed('No bill found.', 'none_found')),
  );
  const platform = new RecordingPlatform();
  assert.deepEqual(await automation.execute(invoke(), platform), {
    outcome: 'failed',
    failureReason: 'No bill found.',
  });
  assert.equal(platform.steps[0]?.summary, 'No bill found.');
  assert.deepEqual(logged, [
    ['info', 'step_failed', { runId: invoke().runId, stepId: 'read', reason: 'none_found' }],
  ]);
});

test('a refused report ends without "Try again" once a provider call answered, and with it before', async () => {
  const refusing = () => {
    const platform = new RecordingPlatform();
    platform.reportStep = () =>
      Promise.reject(refusalFixture('step', { status: 429, code: 'RATE_LIMITED', detail: 'x' }));
    return platform;
  };
  const nothingSent = flow(() => Promise.resolve({ outcome: 'ok', summary: 'Read' }));
  assert.deepEqual(await nothingSent.automation.execute(invoke(), refusing()), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.other,
  });
  const posted: Step = async ({ platform }) => {
    await platform.callProvider({ providerId: 'p', operation: 'records.create', input: {} });
    return { outcome: 'ok', summary: 'Posted' };
  };
  const { automation, logged } = flow(posted);
  const request = invoke();
  assert.deepEqual(await automation.execute(request, refusing()), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.after_write,
  });
  assert.doesNotMatch(FLOW_WORDS.after_write, /try again/iu);
  assert.deepEqual(logged.at(-1)?.slice(0, 2), ['error', 'run_failed_on_a_throw']);
  // Noted per run: the same request run again, with nothing sent, says "Try again" again.
  assert.deepEqual(await nothingSent.automation.execute(request, refusing()), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.other,
  });
  // A step that throws once a provider call has answered ends the same way.
  const thenThrows: Step = async (context) => {
    await posted(context);
    throw new Error('the raw text');
  };
  assert.deepEqual(await flow(thenThrows).automation.execute(invoke(), new RecordingPlatform()), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.after_write,
  });
});

test('a provider call nothing answered, thrown through, ends unconfirmed: never "Try again"', async () => {
  const posted: Step = async ({ platform }) => {
    await platform.callProvider({ providerId: 'p', operation: 'records.create', input: {} });
    return { outcome: 'ok', summary: 'Posted' };
  };
  const platform = new RecordingPlatform();
  platform.provider = () =>
    Promise.reject(Object.assign(new Error('the raw text'), { name: 'TimeoutError' }));
  assert.deepEqual(await flow(posted).automation.execute(invoke(), platform), {
    outcome: 'failed',
    failureReason: FLOW_WORDS.unconfirmed,
  });
});

test('Q2: an answer off its schema is asked once more with one fixed line, and a good answer ends ok', async () => {
  const { automation, logged } = flow(reading);
  const platform = new RecordingPlatform();
  platform.model = () =>
    Promise.resolve(
      completion(platform.modelCalls.length === 1 ? '{"kind":"memo"}' : '{"kind":"bill"}'),
    );
  const result = await automation.execute(invoke(), platform);
  assert.equal(result.outcome, 'success');
  assert.equal(platform.modelCalls.length, 2, 'one more paid call');
  assert.equal(
    platform.modelCalls[1]?.prompt,
    `${platform.modelCalls[0]?.prompt}\n\nYour last answer did not match the schema at $.kind (enum). Answer again with only the JSON object the schema describes.`,
  );
  assert.deepEqual(logged, [
    [
      'info',
      'model_reasked',
      {
        runId: invoke().runId,
        stepId: 'read',
        reason: 'output_schema_mismatch',
        path: '$.kind',
        rule: 'enum',
      },
    ],
  ]);
});

test('Q2: a second miss holds the run for a person, never "unreadable"', async () => {
  const { automation } = flow(reading);
  const platform = new RecordingPlatform();
  platform.model = () => Promise.resolve(completion('{"kind":"memo"}'));
  const result = await automation.execute(invoke(), platform);
  assert.ok(result.outcome === 'held');
  assert.equal(result.held.reason, FLOW_WORDS.ai_unmatched);
  assert.deepEqual(result.held.state, { unmatchedAnswer: 'read' });
  assert.equal(platform.modelCalls.length, 2, 'asked once more, never a third time');
});

test('5d: cut off at a lower first cap, asked once more at the owner’s cap; two calls', async () => {
  const { automation, logged } = flow(reading);
  const platform = new RecordingPlatform();
  platform.model = (call) =>
    Promise.resolve(
      call.maxOutputTokens === 4_000
        ? completion('{"kind":"bi', 'length')
        : completion('{"kind":"bill"}'),
    );
  const result = await automation.execute(invoke(), platform);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(
    platform.modelCalls.map((call) => call.maxOutputTokens),
    [4_000, 8_000],
  );
  assert.deepEqual(logged, [
    [
      'info',
      'model_reasked',
      { runId: invoke().runId, stepId: 'read', reason: 'truncated', path: null, rule: null },
    ],
  ]);
});

test('5d: cut off at the cap is not asked again, and fails with a plain reason', async () => {
  const atCap: Step = async ({ platform }) => {
    await platform.callModel(classify, {});
    return { outcome: 'ok', summary: 'Read' };
  };
  const { automation } = flow(atCap);
  const platform = new RecordingPlatform();
  platform.model = () => Promise.resolve(completion('{"kind":"bi', 'length'));
  const result = await automation.execute(invoke(), platform);
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.ai_too_long });
  assert.equal(platform.modelCalls.length, 1, 'the first ask was at the cap');
  assert.equal(
    'maxOutputTokens' in (platform.modelCalls[0] ?? {}),
    false,
    'no field: the platform sends its cap',
  );
});

test('retryLeft is false once a model has answered: a re-ask that gets no answer is unanswered, and no third call is made', async () => {
  const seen: Settled<unknown>[] = [];
  const settling: Step = async (context) => {
    const sent = await settle(context, () => context.platform.callModel(classify, {}));
    seen.push(sent);
    return sent.ok ? { outcome: 'ok', summary: 'Read' } : failed(sent.sentence, sent.kind);
  };
  const { automation } = flow(settling, {
    retry: { read: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS, when: 'unsent' } },
  });
  const platform = new RecordingPlatform();
  platform.model = () => Promise.resolve(completion('{"kind":"memo"}'));
  const calls: ModelRequest[] = [];
  const recorded = platform.callModel.bind(platform);
  platform.callModel = (request) => {
    calls.push(request);
    // The first is answered (off its schema, billed); the re-ask provably never left.
    return calls.length === 1
      ? recorded(request)
      : Promise.reject(new CallbackRefusedError('model', 503, 'Service Unavailable'));
  };
  const result = await automation.execute(invoke(), platform);
  assert.equal(calls.length, 2, 'the billed first call is never made again');
  assert.deepEqual(
    seen.map((entry) => !entry.ok && entry.kind),
    ['unanswered'],
  );
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.ai_busy });

  // Without settle, the runner itself does not repeat it either.
  const bare = flow(reading, {
    retry: { read: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS, when: 'unsent' } },
  });
  calls.length = 0;
  await bare.automation.execute(invoke(), platform);
  assert.equal(calls.length, 2);
});

test('an unsent first call, with no model answer yet, is still repeated by the step retry', async () => {
  const { automation } = flow(reading, {
    retry: { read: { attempts: 2, backoffMs: MIN_STEP_BACKOFF_MS, when: 'unsent' } },
  });
  const platform = new RecordingPlatform();
  platform.model = () => Promise.resolve(completion('{"kind":"bill"}'));
  const recorded = platform.callModel.bind(platform);
  let calls = 0;
  platform.callModel = (request) =>
    ++calls === 1 ? Promise.reject(new CallbackRefusedError('model', 503, '')) : recorded(request);
  assert.equal((await automation.execute(invoke(), platform)).outcome, 'success');
  assert.equal(calls, 2);
});

test('Q1 quotesIn: the values whose exact words are not in the document', () => {
  const document = 'Invoice from Contoso  Ltd\nTotal 120.50';
  assert.deepEqual(
    quotesIn(document, { vendor: 'Contoso Ltd', number: 'INV-9', total: 120.5, empty: ' ' }),
    ['number'],
  );
  assert.deepEqual(
    quotesIn(document, { vendor: 'contoso ltd' }),
    ['vendor'],
    'exact, case and all',
  );
});
