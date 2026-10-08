import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '../src/contract.js';
import { PlatformClient, unanswered } from '../src/platform.js';
import { CallbackRefusedError, ModelRefusedError } from '../src/refusals.js';
import { MAX_STEP_BACKOFF_MS, attempt, backoffWaits } from '../src/retry.js';
import { type AutomationDefinition, type Step, held, idempotencyKeyFor } from '../src/runner.js';
import { RecordingPlatform, refusalFixture } from '../src/testing.js';
import { define, extract, invoke, manifest, ok } from './runner-fixtures.js';
import { startStubPlatform } from './stub-platform.js';

/**
 * The step runner's bounded retry (platform BUILD-PLAN 25.5.1): only a step that
 * declares a policy is run again, only after a failure the platform did not
 * decide, with the same key on every attempt, within the SDK's ceilings and the
 * run's deadline — and it is reported once.
 */

/** An answer that never came, marked as the client marks fetch's own rejection. */
async function noAnswer(message = 'fetch failed'): Promise<TypeError> {
  const error = new TypeError(message);
  await unanswered(Promise.reject(error)).catch(() => undefined);
  return error;
}

const posting: Step = async ({ platform }) => {
  const answer = await platform.callProvider({
    providerId: 'example-provider',
    operation: 'records.create',
    input: { reference: 'INV-7' },
  });
  return { outcome: 'ok', summary: `Posted with ${answer.status}` };
};

function retrying(retry?: AutomationDefinition['retry'], post: Step = posting) {
  return define({
    steps: { receive: ok('Received'), validate: ok('Validated'), post },
    ...(retry ? { retry } : {}),
  });
}

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
    const platform = new RecordingPlatform();
    platform.provider = () =>
      platform.providerCalls.length === 1
        ? Promise.reject(failure)
        : Promise.resolve({ status: 201, body: {} });
    const request = invoke();
    const result = await retrying({ post: { attempts: 3, backoffMs: 1 } }).execute(
      request,
      platform,
    );
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
      retry: { post: { attempts: 3, backoffMs: 1 } },
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
    retrying({ post: { attempts: 2, backoffMs: 1 } }).execute(invoke(), platform),
    (thrown) => thrown === failure,
  );
  assert.equal(platform.providerCalls.length, 2);
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
    new Date(Date.now() + 200).toISOString(),
    new Date(Date.now() - 1_000).toISOString(),
    'not a date',
  ];
  for (const deadline of deadlines) {
    const failure = await noAnswer();
    const platform = new RecordingPlatform();
    platform.provider = () => Promise.reject(failure);
    await assert.rejects(
      retrying({ post: { attempts: 3, backoffMs: 1_000 } }).execute(invoke({ deadline }), platform),
      (thrown) => thrown === failure,
    );
    assert.equal(platform.providerCalls.length, 1, deadline);
    assert.equal(platform.steps.at(-1)?.summary, 'The post step failed');
  }
});

test('the ceilings clamp a policy that asks for more: three attempts, thirty seconds of waiting in all', async () => {
  const automation = define({
    steps: { receive: ok('r'), validate: ok('v'), post: posting },
    retry: {
      receive: { attempts: 3, backoffMs: 2_000 },
      validate: { attempts: 2, backoffMs: 45_000 },
      post: { attempts: 9, backoffMs: 60_000 },
    },
  });
  assert.deepEqual(automation.retry, {
    receive: { attempts: 3, backoffMs: 2_000 },
    validate: { attempts: 2, backoffMs: 30_000 },
    post: { attempts: 3, backoffMs: 10_000 },
  });

  // The waits the runner sleeps are the clamped ones.
  const policy = automation.retry.post;
  assert.ok(policy);
  const failure = await noAnswer();
  const slept: number[] = [];
  const attempted = await attempt(
    () => Promise.reject(failure),
    backoffWaits(policy),
    new Date(Date.now() + 900_000).toISOString(),
    (milliseconds) => {
      slept.push(milliseconds);
      return Promise.resolve();
    },
  );
  assert.deepEqual(slept, [10_000, 20_000]);
  assert.equal(
    slept.reduce((sum, wait) => sum + wait, 0),
    MAX_STEP_BACKOFF_MS,
  );
  assert.ok(attempted.threw && attempted.attempts === 3);

  // A step that asks for nine attempts makes three.
  const platform = new RecordingPlatform();
  platform.provider = () => Promise.reject(failure);
  await assert.rejects(
    retrying({ post: { attempts: 9, backoffMs: 1 } }).execute(invoke(), platform),
  );
  assert.equal(platform.providerCalls.length, 3);
  assert.equal(platform.steps.at(-1)?.summary, 'The post step failed (after 3 attempts)');
});

test('a step with no policy behaves exactly as before: one attempt, the same fixed text, the same error', async () => {
  const failure = await noAnswer();
  for (const automation of [retrying(), retrying({ validate: { attempts: 3, backoffMs: 1 } })]) {
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
      retry: { validate: { attempts: 3, backoffMs: 1 } },
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
    retry: { post: { attempts: 3, backoffMs: 1 } },
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
    const running = retrying({ post: { attempts: 2, backoffMs: 1 } }, step).execute(
      invoke(),
      platform,
    );
    if (expected === undefined) {
      await assert.rejects(running, /summary must be a non-empty line/u);
    } else {
      await running;
      assert.equal(platform.steps.at(-1)?.summary, expected);
    }
  }
});

test('a retry policy is refused at definition when it names a step with no code or counts nothing', () => {
  for (const [retry, refusal] of [
    [
      { audit: { attempts: 2, backoffMs: 1 } },
      /names step "audit", which the code does not implement/u,
    ],
    [{ constructor: { attempts: 2, backoffMs: 1 } }, /names step "constructor"/u],
    [{ post: { attempts: 0, backoffMs: 1 } }, /must count at least one attempt/u],
    [{ post: { attempts: 1.5, backoffMs: 1 } }, /must count at least one attempt/u],
    [{ post: { attempts: 2, backoffMs: -1 } }, /must wait a whole number of milliseconds/u],
    [{ post: { attempts: 2, backoffMs: Number.NaN } }, /must wait a whole number of milliseconds/u],
  ] as const) {
    assert.throws(() => retrying(retry), refusal);
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
      stub.delayMs = calls === 1 ? 500 : 0;
      if (calls === 2) return { status: 503 };
      return { status: 200, body: { provider: { status: 201, body: { id: 'r-1' } } } };
    };
    const client = new PlatformClient(stub.origin, 'run-token-under-test', { timeoutMs: 100 });
    const request = invoke();
    const result = await retrying({ post: { attempts: 3, backoffMs: 1 } }).execute(request, client);
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
    assert.equal(result.outcome, 'success');
  } finally {
    await stub.close();
  }
});
