import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '../src/contract.js';
import { PlatformClient } from '../src/platform.js';
import { CallbackRefusedError, ModelRefusedError } from '../src/refusals.js';
import { MIN_STEP_BACKOFF_MS } from '../src/retry.js';
import { type Step, held, idempotencyKeyFor } from '../src/steps.js';
import { RecordingPlatform, refusalFixture } from '../src/testing.js';
import { noAnswer, recordedWaits, retrying } from './retry-fixtures.js';
import { define, extract, invoke, manifest, ok } from './runner-fixtures.js';
import { startStubPlatform } from './stub-platform.js';

/**
 * The step runner's bounded retry (platform BUILD-PLAN 25.5.1): only a step that
 * declares a policy is run again, only after a failure the platform did not
 * decide, with the same key on every attempt, within the SDK's ceilings and the
 * run's deadline — and it is reported once. How a policy is refused or clamped at
 * definition is `runner-retry-policy.test.ts`.
 */

const waited = recordedWaits();

function timeline(platform: RecordingPlatform): string[][] {
  return platform.steps.map((step) => [step.stepId, step.outcome, step.summary]);
}

test('a transient failure then success: one report, ok, the attempts noted, the same key on every attempt', async () => {
  const failures = [
    await noAnswer(),
    // The Edge could not reach Runs (its `http-gateway.ts`), and the proxy's own page.
    refusalFixture('provider', {
      status: 502,
      code: 'DEPENDENCY_FAILURE',
      detail: 'Runs service is unreachable',
    }),
    new CallbackRefusedError('provider', 503, ''),
  ];
  for (const failure of failures) {
    waited.length = 0;
    const platform = new RecordingPlatform();
    platform.provider = () =>
      platform.providerCalls.length === 1
        ? Promise.reject(failure)
        : Promise.resolve({ status: 201, body: {} });
    const request = invoke();
    const result = await retrying({
      post: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS },
    }).execute(request, platform);
    assert.deepEqual(timeline(platform), [
      ['receive', 'ok', 'Received'],
      ['validate', 'ok', 'Validated'],
      ['post', 'ok', 'Posted with 201 (after 2 attempts)'],
    ]);
    const key = idempotencyKeyFor(request.runId, 'post');
    assert.deepEqual(
      platform.providerCalls.map((call) => call.idempotencyKey),
      [key, key],
      'the repeat carries the key the first attempt did',
    );
    assert.deepEqual(waited, [MIN_STEP_BACKOFF_MS], 'one wait, the floor, before the repeat');
    assert.equal(result.outcome, 'success');
  }
});

test('only a failure the platform did not decide is re-attempted: no 4xx, no typed refusal, no NOT_CONFIGURED, no malformed answer, never the step’s own error', async () => {
  const transient = await noAnswer();
  // Each as the platform answers it: the reason, where it names one, is the word it decided on.
  const refused = (callback: string, status: number, code: string, details: JsonObject) =>
    refusalFixture(callback, { status, code, detail: 'The platform decided', details });
  const cases: [string, 'provider' | 'mail' | 'model' | 'own', Error][] = [
    ['a 4xx that names nothing', 'provider', new CallbackRefusedError('provider', 409, '')],
    [
      'the mail allowance',
      'mail',
      refused('mail', 429, 'TOO_MANY_REQUESTS', { reason: 'per_run_cap' }),
    ],
    [
      'a typed model refusal',
      'model',
      refused('model', 422, 'BAD_REQUEST', { reason: 'truncated' }),
    ],
    [
      'a 5xx the platform typed',
      'mail',
      refused('mail', 502, 'DEPENDENCY_FAILURE', { reason: 'workspace_membership_truncated' }),
    ],
    [
      'a deployment without the component',
      'model',
      refused('model', 503, 'NOT_CONFIGURED', { component: 'model gateway' }),
    ],
    [
      'a malformed answer',
      'provider',
      new Error('the provider callback did not answer with a status'),
    ],
    ['the step’s own TypeError', 'own', new TypeError('Cannot read properties of undefined')],
    ['an error the step built from a transient one', 'own', new Error('no', { cause: transient })],
  ];
  for (const [label, callback, error] of cases) {
    let attempts = 0;
    const step: Step = async ({ platform }) => {
      attempts += 1;
      if (callback === 'provider') {
        await platform.callProvider({ providerId: 'p', operation: 'records.create', input: {} });
      } else if (callback === 'mail') {
        await platform.sendMail({ to: 'vendor@example.com', subject: 's', body: 'b' });
      } else if (callback === 'model') {
        await platform.callModel(extract, { reference: 'INV-7' });
      } else {
        throw error;
      }
      return { outcome: 'ok', summary: 'never' };
    };
    const platform = new RecordingPlatform();
    platform.provider = () => Promise.reject(error);
    platform.mail = () => Promise.reject(error);
    platform.model = () => Promise.reject(error);
    const automation = define({
      manifests: [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])],
      prompts: [extract],
      steps: { receive: ok('r'), validate: ok('v'), post: step },
      retry: { post: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS } },
    });
    await assert.rejects(automation.execute(invoke(), platform), (thrown) => thrown === error);
    assert.equal(attempts, 1, `${label}: attempted once`);
    assert.equal(
      platform.steps.at(-1)?.summary,
      error instanceof ModelRefusedError
        ? 'The post step failed: the model call was refused (truncated)'
        : 'The post step failed',
      label,
    );
  }
});

test('attempts exhausted: reported failed once, with fixed text and the count, and the last error reaches the shell', async () => {
  const marker = 'ACCOUNT-9911-ROUTING-2200';
  const failure = await noAnswer(`fetch failed for ${marker}`);
  const platform = new RecordingPlatform();
  platform.provider = () => Promise.reject(failure);
  await assert.rejects(
    retrying({ post: { attempts: 2, backoffMs: MIN_STEP_BACKOFF_MS } }).execute(invoke(), platform),
    (thrown) => thrown === failure,
  );
  assert.equal(platform.providerCalls.length, 2);
  assert.deepEqual(waited, [MIN_STEP_BACKOFF_MS]);
  assert.deepEqual(timeline(platform), [
    ['receive', 'ok', 'Received'],
    ['validate', 'ok', 'Validated'],
    ['post', 'failed', 'The post step failed (after 2 attempts)'],
  ]);
  assert.ok(
    !JSON.stringify(platform.steps).includes(marker),
    'the error never reaches the timeline',
  );
});

test('the deadline stops the retries: none starts at or after it, and a deadline that does not parse allows none', async () => {
  const deadlines = [
    // Inside the floor: the first wait would end past it.
    new Date(Date.now() + 5_000).toISOString(),
    new Date(Date.now() - 1_000).toISOString(),
    'not a date',
  ];
  for (const deadline of deadlines) {
    const failure = await noAnswer();
    const platform = new RecordingPlatform();
    platform.provider = () => Promise.reject(failure);
    await assert.rejects(
      retrying({ post: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS } }).execute(
        invoke({ deadline }),
        platform,
      ),
      (thrown) => thrown === failure,
    );
    assert.equal(platform.providerCalls.length, 1, deadline);
    assert.deepEqual(waited, [], deadline);
    assert.equal(platform.steps.at(-1)?.summary, 'The post step failed');
  }

  // Room for the first wait (10 s) and not the second (20 s): one repeat, then the failure.
  const failure = await noAnswer();
  const platform = new RecordingPlatform();
  platform.provider = () => Promise.reject(failure);
  await assert.rejects(
    retrying({ post: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS } }).execute(
      invoke({ deadline: new Date(Date.now() + 15_000).toISOString() }),
      platform,
    ),
    (thrown) => thrown === failure,
  );
  assert.equal(platform.providerCalls.length, 2);
  assert.deepEqual(waited, [MIN_STEP_BACKOFF_MS]);
  assert.equal(platform.steps.at(-1)?.summary, 'The post step failed (after 2 attempts)');
});

test('a step with no policy behaves exactly as before: one attempt, the same fixed text, the same error', async () => {
  const failure = await noAnswer();
  for (const automation of [
    retrying(),
    retrying({ validate: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS } }),
  ]) {
    const platform = new RecordingPlatform();
    platform.provider = () => Promise.reject(failure);
    await assert.rejects(automation.execute(invoke(), platform), (thrown) => thrown === failure);
    assert.equal(platform.providerCalls.length, 1);
    assert.deepEqual(timeline(platform), [
      ['receive', 'ok', 'Received'],
      ['validate', 'ok', 'Validated'],
      ['post', 'failed', 'The post step failed'],
    ]);
  }
  assert.deepEqual(retrying().retry, {});
});

test('a result the step returns is final: a held step is never run again, and neither is a failed one', async () => {
  const failure = await noAnswer();
  for (const failFirst of [false, true]) {
    let runs = 0;
    const holding: Step = async ({ state, platform }) => {
      runs += 1;
      if (failFirst && runs === 1)
        await platform.callProvider({ providerId: 'p', operation: 'o', input: {} });
      return held({
        summary: 'Above the threshold',
        heldReason: 'Someone should approve this',
        state,
      });
    };
    const platform = new RecordingPlatform();
    platform.provider = () => Promise.reject(failure);
    const result = await define({
      steps: { receive: ok('r'), validate: holding, post: ok('p') },
      retry: { validate: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS } },
    }).execute(invoke(), platform);
    assert.equal(result.outcome, 'held');
    assert.equal(runs, failFirst ? 2 : 1, 'held ends the attempts as it ends the run');
    assert.deepEqual(timeline(platform), [
      ['receive', 'ok', 'r'],
      [
        'validate',
        'held',
        failFirst ? 'Above the threshold (after 2 attempts)' : 'Above the threshold',
      ],
    ]);
  }

  let runs = 0;
  const failing: Step = () => {
    runs += 1;
    return Promise.resolve({ outcome: 'failed', summary: 'Refused', failureReason: 'refused' });
  };
  const platform = new RecordingPlatform();
  const result = await define({
    steps: { receive: ok('r'), validate: ok('v'), post: failing },
    retry: { post: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS } },
  }).execute(invoke(), platform);
  assert.deepEqual(result, { outcome: 'failed', failureReason: 'refused' });
  assert.equal(runs, 1);
});

test('the count always fits the line: the step’s words are cut to make room, and an empty line is still refused', async () => {
  const failure = await noAnswer();
  for (const [summary, expected] of [
    ['x'.repeat(199), `${'x'.repeat(181)} (after 2 attempts)`],
    ['   ', undefined],
  ] as const) {
    let runs = 0;
    const step: Step = async ({ platform }) => {
      runs += 1;
      if (runs === 1) await platform.callProvider({ providerId: 'p', operation: 'o', input: {} });
      return { outcome: 'ok', summary };
    };
    const platform = new RecordingPlatform();
    platform.provider = () => Promise.reject(failure);
    const running = retrying(
      { post: { attempts: 2, backoffMs: MIN_STEP_BACKOFF_MS } },
      step,
    ).execute(invoke(), platform);
    if (expected === undefined) {
      await assert.rejects(running, /summary must be a non-empty line/u);
    } else {
      await running;
      assert.equal(platform.steps.at(-1)?.summary, expected);
    }
  }
});

test('on the wire: an answer that never came and a 503 are re-attempted with the same key, and the step is reported once', async () => {
  const stub = await startStubPlatform();
  try {
    let calls = 0;
    stub.answers.provider = () => {
      calls += 1;
      // The first is held past the client's timeout; the second is a proxy's bare
      // 503; the third is answered.
      stub.delayMs = calls === 1 ? 1_500 : 0;
      if (calls === 2) return { status: 503 };
      return { status: 200, body: { provider: { status: 201, body: { id: 'r-1' } } } };
    };
    const client = new PlatformClient(stub.origin, 'run-token-under-test', { timeoutMs: 1_000 });
    const request = invoke();
    const result = await retrying({
      post: { attempts: 3, backoffMs: MIN_STEP_BACKOFF_MS },
    }).execute(request, client);
    const bodies = (path: string) =>
      stub.calls.filter((call) => call.path.endsWith(path)).map((call) => call.body as JsonObject);
    const key = idempotencyKeyFor(request.runId, 'post');
    assert.deepEqual(
      bodies('/provider').map((body) => body.idempotencyKey),
      [key, key, key],
    );
    assert.deepEqual(
      bodies('/step').map((body) => [body.stepId, body.outcome, body.summary]),
      [
        ['receive', 'ok', 'Received'],
        ['validate', 'ok', 'Validated'],
        ['post', 'ok', 'Posted with 201 (after 3 attempts)'],
      ],
    );
    assert.deepEqual(waited, [10_000, 20_000]);
    assert.equal(result.outcome, 'success');
  } finally {
    await stub.close();
  }
});
