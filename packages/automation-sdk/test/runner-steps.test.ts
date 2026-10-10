import assert from 'node:assert/strict';
import { test } from 'node:test';

import { definePrompt } from '../src/prompt.js';
import { ModelRefusedError } from '../src/refusals.js';
import { type Step, held } from '../src/steps.js';
import { RecordingPlatform, refusalFixture } from '../src/testing.js';
import { define, extract, invoke, manifest, ok } from './runner-fixtures.js';

/**
 * The step runner against a recording platform, part two: a held run that ends
 * and resumes from its state, a continuation refused before any step runs, a
 * failed step that is visible or fatal, a skipped step, a throwing step, and
 * prompts rendered by capability and refused before the wire.
 */

test('a held step ends the run with its state, and an approval resumes at the next step from that state', async () => {
  const automation = define({
    steps: {
      receive: ok('Received', { invoice: { reference: 'INV-1', amount: 900 } }),
      validate: (context) =>
        Promise.resolve(
          held({
            summary: 'Above the threshold',
            heldReason: 'Someone should approve this',
            reason: 'INV-1 — above the threshold',
            state: { ...context.state, threshold: 500 },
          }),
        ),
      post: (context) =>
        Promise.resolve({
          outcome: 'ok',
          summary: 'Posted',
          state: { ...context.state, posted: true },
        }),
    },
  });

  const first = new RecordingPlatform();
  const heldResult = await automation.execute(invoke(), first);
  assert.deepEqual(heldResult, {
    outcome: 'held',
    held: {
      stepId: 'validate',
      reason: 'INV-1 — above the threshold',
      state: { invoice: { reference: 'INV-1', amount: 900 }, threshold: 500 },
    },
  });
  assert.deepEqual(
    first.steps.map((step) => [step.stepId, step.outcome, step.heldReason]),
    [
      ['receive', 'ok', undefined],
      ['validate', 'held', 'Someone should approve this'],
    ],
    'the run ENDS at the step that held; post never ran',
  );

  assert.ok(heldResult.outcome === 'held');
  const resumed = new RecordingPlatform();
  const result = await automation.execute(
    invoke({
      runId: 'aaaaaaaa-0000-4000-8000-000000000009',
      input: {},
      continuation: {
        ofRunId: invoke().runId,
        kind: 'approval',
        stepId: 'validate',
        decision: 'approved',
        state: heldResult.held.state,
      },
    }),
    resumed,
  );
  assert.deepEqual(
    resumed.steps.map((step) => step.stepId),
    ['post'],
    'only the work that remains',
  );
  assert.deepEqual(result, {
    outcome: 'success',
    output: { invoice: { reference: 'INV-1', amount: 900 }, threshold: 500, posted: true },
    summary: 'Done',
  });
});

test('a continuation that names an undeclared step, no step, or no approval is refused before any step runs', async () => {
  const automation = define();
  const base = {
    ofRunId: invoke().runId,
    kind: 'approval' as const,
    decision: 'approved' as const,
    state: { n: 1 },
  };
  for (const [continuation, reason] of [
    [
      { ...base, stepId: 'audit' },
      'the continuation resumes at "audit", which under-test v1 does not declare',
    ],
    [{ ...base }, 'the continuation names no step to resume from'],
    [
      { ...base, stepId: 'validate', decision: 'rejected' as const },
      'the approval continuation was not approved',
    ],
  ] as const) {
    const platform = new RecordingPlatform();
    const result = await automation.execute(invoke({ input: {}, continuation }), platform);
    assert.deepEqual(result, { outcome: 'failed', failureReason: reason });
    assert.equal(platform.steps.length, 0);
  }
});

test('held defaults the result line to the timeline reason', () => {
  assert.deepEqual(held({ summary: 's', heldReason: 'why', state: {} }), {
    outcome: 'held',
    summary: 's',
    heldReason: 'why',
    reason: 'why',
    state: {},
  });
});

test('a failed step without a failure reason is visible and the run goes on; with one, the run fails there', async () => {
  const visible = define({
    steps: {
      receive: ok('r'),
      validate: () =>
        Promise.resolve({
          outcome: 'failed',
          summary: 'Notice not sent',
          state: { notified: false },
        }),
      post: ok('p'),
    },
  });
  const platform = new RecordingPlatform();
  const result = await visible.execute(invoke(), platform);
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome]),
    [
      ['receive', 'ok'],
      ['validate', 'failed'],
      ['post', 'ok'],
    ],
  );
  assert.deepEqual(result, { outcome: 'success', output: { notified: false }, summary: 'Done' });

  const fatal = define({
    steps: {
      receive: () =>
        Promise.resolve({
          outcome: 'failed',
          summary: 'Not an invoice',
          failureReason: 'input must carry an invoice',
        }),
      validate: ok('v'),
      post: ok('p'),
    },
  });
  const failed = new RecordingPlatform();
  assert.deepEqual(await fatal.execute(invoke(), failed), {
    outcome: 'failed',
    failureReason: 'input must carry an invoice',
  });
  assert.deepEqual(
    failed.steps.map((step) => step.stepId),
    ['receive'],
  );
});

test('a skipped step reports nothing and the pipeline continues', async () => {
  const platform = new RecordingPlatform();
  await define({
    steps: {
      receive: ok('r'),
      validate: () => Promise.resolve({ outcome: 'skipped' }),
      post: ok('p'),
    },
  }).execute(invoke(), platform);
  assert.deepEqual(
    platform.steps.map((step) => step.stepId),
    ['receive', 'post'],
  );
});

test('a step that throws is reported failed under its id with fixed text, and the error reaches the shell', async () => {
  const platform = new RecordingPlatform();
  const marker = 'ACCOUNT-9911-ROUTING-2200';
  const automation = define({
    steps: {
      receive: ok('r'),
      validate: () => Promise.reject(new Error(`could not parse ${marker}`)),
      post: ok('p'),
    },
  });
  await assert.rejects(automation.execute(invoke(), platform), /could not parse/u);
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome, step.summary]),
    [
      ['receive', 'ok', 'r'],
      ['validate', 'failed', 'The validate step failed'],
    ],
  );
  assert.ok(
    !JSON.stringify(platform.steps).includes(marker),
    'the message never reaches the timeline',
  );
});

test('a registered prompt is rendered from the input and sent by capability; an unregistered or undeclared one is refused before the wire', async () => {
  const automation = define({
    manifests: [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])],
    prompts: [extract],
    steps: {
      receive: async (context) => {
        const completion = await context.platform.callModel(extract, {
          reference: 'INV-7',
          text: '...',
        });
        return { outcome: 'ok', summary: 'Extracted', state: { model: completion.model } };
      },
      validate: ok('v'),
      post: ok('p'),
    },
  });
  const platform = new RecordingPlatform();
  await automation.execute(invoke(), platform);
  assert.deepEqual(platform.modelCalls, [
    {
      capability: 'document-extraction',
      prompt: 'Extract the invoice fields from INV-7.',
      input: { reference: 'INV-7', text: '...' },
      outputSchema: { type: 'object' },
    },
  ]);
  assert.ok(!('model' in (platform.modelCalls[0] ?? {})), 'no model is ever named');

  const unregistered = definePrompt({ ...extract, id: 'other-prompt' });
  const refusing = define({
    manifests: [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])],
    prompts: [extract],
    steps: {
      receive: async (context) => {
        await context.platform.callModel(unregistered, {});
        return { outcome: 'ok', summary: 'never' };
      },
      validate: ok('v'),
      post: ok('p'),
    },
  });
  const refused = new RecordingPlatform();
  await assert.rejects(
    refusing.execute(invoke(), refused),
    /prompt other-prompt v1 is not registered with this automation/u,
  );
  assert.equal(refused.modelCalls.length, 0, 'nothing was sent');
});

test('a prompt whose capability a served manifest does not declare is refused at definition', () => {
  assert.throws(
    () =>
      define({
        manifests: [manifest(1, ['receive', 'validate', 'post'], ['summarization'])],
        prompts: [extract],
      }),
    /prompt extract-invoice v1 uses document-extraction, which under-test v1 does not declare in requiredCapabilities/u,
  );
  // Declared by one served version and not another is refused too: one container
  // serves both and any of its runs may reach the step that sends the prompt.
  assert.throws(
    () =>
      define({
        manifests: [
          manifest(1, ['receive', 'validate', 'post']),
          manifest(2, ['receive', 'validate', 'post'], ['document-extraction']),
        ],
        prompts: [extract],
      }),
    /which under-test v1 does not declare/u,
  );
});

test('a typed model refusal reaches the step as a ModelRefusedError to branch on, and names its reason in the timeline when uncaught', async () => {
  const truncated = refusalFixture('model', {
    status: 422,
    code: 'BAD_REQUEST',
    detail: 'The model completion was truncated at the output budget',
    details: { reason: 'truncated', finishReason: 'length' },
  });
  const declaring = [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])];

  // Uncaught: the run dies at the step, and the timeline says why — a word from
  // the platform's closed list, never the completion, which the platform never sent.
  const uncaught = define({
    manifests: declaring,
    prompts: [extract],
    steps: {
      receive: async (context) => {
        await context.platform.callModel(extract, { reference: 'INV-7' });
        return { outcome: 'ok', summary: 'never' };
      },
      validate: ok('v'),
      post: ok('p'),
    },
  });
  const platform = new RecordingPlatform();
  platform.model = () => Promise.reject(truncated);
  await assert.rejects(
    uncaught.execute(invoke(), platform),
    (error: unknown) => error instanceof ModelRefusedError && error.reason === 'truncated',
  );
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome, step.summary]),
    [['receive', 'failed', 'The receive step failed: the model call was refused (truncated)']],
  );

  // Caught: the author branches on the reason and decides what the run does.
  const branching = define({
    manifests: declaring,
    prompts: [extract],
    steps: {
      receive: async (context) => {
        try {
          await context.platform.callModel(extract, { reference: 'INV-7' });
        } catch (error) {
          if (error instanceof ModelRefusedError && error.reason === 'truncated') {
            return {
              outcome: 'failed',
              summary: 'The document was too long for one extraction',
              failureReason: `the extraction was cut short (${error.finishReason})`,
            };
          }
          throw error;
        }
        return { outcome: 'ok', summary: 'never' };
      },
      validate: ok('v'),
      post: ok('p'),
    },
  });
  const branched = new RecordingPlatform();
  branched.model = () => Promise.reject(truncated);
  assert.deepEqual(await branching.execute(invoke(), branched), {
    outcome: 'failed',
    failureReason: 'the extraction was cut short (length)',
  });
  assert.deepEqual(
    branched.steps.map((step) => [step.stepId, step.outcome, step.summary]),
    [['receive', 'failed', 'The document was too long for one extraction']],
  );
});
