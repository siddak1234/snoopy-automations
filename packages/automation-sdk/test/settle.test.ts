import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineFlow } from '../src/flow.js';
import { CallbackRefusedError } from '../src/refusals.js';
import { MIN_STEP_BACKOFF_MS } from '../src/retry.js';
import { failed, optionalConnection, settle, type Settled } from '../src/settle.js';
import type { Step, StepContext } from '../src/steps.js';
import { RecordingPlatform, refusalFixture } from '../src/testing.js';
import { FLOW_WORDS, notSentLine } from '../src/words.js';
import { noAnswer, recordedWaits } from './retry-fixtures.js';
import { TEMPLATE, invoke, manifest } from './runner-fixtures.js';

/**
 * `settle` (Round 21, D2.2): one way for every risky call, a kind from a closed list and the
 * SDK's sentence — and, under `defineFlow`, the step retry first: a retryable error is rethrown
 * while an attempt remains, so a 502 is retried before it is `unconfirmed`: a provider call nothing
 * answered never says "Try again".
 */

const waited = recordedWaits();

const providerError = (status: number, code: string, reason?: string) =>
  refusalFixture('provider', {
    status,
    code,
    detail: 'the raw text',
    ...(reason === undefined ? {} : { details: { reason } }),
  });

/** A flow whose one step posts through `settle` and keeps what it settled to, under `policy`. */
function posting(attempts?: number) {
  const seen: Settled<unknown>[] = [];
  const logged: unknown[][] = [];
  const post: Step = async (context) => {
    const sent = await settle(context, () =>
      context.platform.callProvider({ providerId: 'p', operation: 'records.create', input: {} }),
    );
    seen.push(sent);
    return sent.ok ? { outcome: 'ok', summary: 'Posted' } : failed(sent.sentence, sent.kind);
  };
  const automation = defineFlow({
    templateId: TEMPLATE,
    manifests: [manifest(1, ['post'])],
    steps: { post },
    ...(attempts === undefined
      ? {}
      : { retry: { post: { attempts, backoffMs: MIN_STEP_BACKOFF_MS } } }),
    result: () => ({ summary: 'Done' }),
    log: (...line) => void logged.push(line),
  });
  return { automation, seen, logged };
}

test('settle: with { attempts: 2 }, a 502 then a 200 ends ok after two calls', async () => {
  const { automation, seen } = posting(2);
  const platform = new RecordingPlatform();
  platform.provider = () =>
    platform.providerCalls.length === 1
      ? Promise.reject(providerError(502, 'DEPENDENCY_FAILURE'))
      : Promise.resolve({ status: 201, body: {} });
  const result = await automation.execute(invoke(), platform);
  assert.equal(result.outcome, 'success');
  assert.equal(platform.providerCalls.length, 2);
  assert.deepEqual(waited.length, 1, 'one wait before the repeat');
  assert.deepEqual(
    seen,
    [{ ok: true, value: { status: 201, body: {} } }],
    'settled once, at the end',
  );
});

test('settle: a 502 twice ends unconfirmed after two calls, never after the first', async () => {
  const { automation, seen } = posting(2);
  const platform = new RecordingPlatform();
  platform.provider = () => Promise.reject(providerError(502, 'DEPENDENCY_FAILURE'));
  const result = await automation.execute(invoke(), platform);
  assert.equal(platform.providerCalls.length, 2);
  assert.deepEqual(
    seen.map((entry) => !entry.ok && entry.kind),
    ['unconfirmed'],
    'the first attempt rethrew',
  );
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.unconfirmed });
});

test('settle: a provider call nothing answered is unconfirmed, never "Try again"; one provably unsent is vendor_down', async () => {
  const cases: [string, () => Promise<unknown>, string][] = [
    ['no answer', async () => Promise.reject(await noAnswer('the raw text')), 'unconfirmed'],
    [
      'a timeout',
      () => Promise.reject(Object.assign(new Error('the raw text'), { name: 'TimeoutError' })),
      'unconfirmed',
    ],
    ['a 504', () => Promise.reject(providerError(504, 'DEPENDENCY_FAILURE')), 'unconfirmed'],
    [
      'a codeless 503, provably unsent',
      () => Promise.reject(new CallbackRefusedError('provider', 503, '')),
      'vendor_down',
    ],
    ['a 429', () => Promise.reject(providerError(429, 'RATE_LIMITED')), 'vendor_down'],
  ];
  for (const [name, call, kind] of cases) {
    const { automation, seen } = posting();
    const platform = new RecordingPlatform();
    platform.provider = () => call() as never;
    const result = await automation.execute(invoke(), platform);
    assert.deepEqual(
      seen.map((entry) => !entry.ok && entry.kind),
      [kind],
      name,
    );
    assert.ok(result.outcome === 'failed', name);
    assert.equal(result.failureReason, FLOW_WORDS[kind as 'unconfirmed' | 'vendor_down'], name);
    if (kind === 'unconfirmed') assert.doesNotMatch(result.failureReason, /try again/iu, name);
  }
});

test('settle logs settled with the kind and the error shape, never its text', async () => {
  const { automation, logged } = posting();
  const platform = new RecordingPlatform();
  platform.provider = () => Promise.reject(providerError(404, 'NOT_FOUND'));
  await automation.execute(invoke(), platform);
  assert.deepEqual(logged[0], [
    'info',
    'settled',
    {
      runId: invoke().runId,
      stepId: 'post',
      kind: 'not_connected',
      error: 'CallbackRefusedError',
      status: 404,
      code: 'NOT_FOUND',
      reason: null,
    },
  ]);
  assert.ok(!JSON.stringify(logged).includes('raw text'));
  // A vendor's own non-2xx inside a 200: the kind and the status.
  const inside = posting();
  const answering = new RecordingPlatform();
  answering.provider = () => Promise.resolve({ status: 409, body: { said: 'the raw text' } });
  await inside.automation.execute(invoke(), answering);
  assert.deepEqual(inside.logged[0]?.slice(1), [
    'settled',
    { runId: invoke().runId, stepId: 'post', kind: 'vendor_refused', status: 409 },
  ]);
});

test('settle: a 404 ends not_connected after one call', async () => {
  const { automation, seen } = posting(2);
  const platform = new RecordingPlatform();
  platform.provider = () => Promise.reject(providerError(404, 'NOT_FOUND'));
  const result = await automation.execute(invoke(), platform);
  assert.equal(platform.providerCalls.length, 1, 'a 4xx is never repeated');
  assert.deepEqual(
    seen.map((entry) => !entry.ok && entry.kind),
    ['not_connected'],
  );
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.not_connected });
});

test('settle: each kind, with the SDK’s sentence and never the raw text', async () => {
  const context: Pick<StepContext, 'retryLeft'> = {};
  const timeout = Object.assign(new Error('the raw text'), { name: 'TimeoutError' });
  const cases: [string, () => Promise<unknown>, string, string][] = [
    [
      '404',
      () => Promise.reject(providerError(404, 'NOT_FOUND')),
      'not_connected',
      'not_connected',
    ],
    [
      'provider_not_declared',
      () => Promise.reject(providerError(403, 'FORBIDDEN', 'provider_not_declared')),
      'not_declared',
      'not_declared',
    ],
    [
      'a 409',
      () => Promise.reject(providerError(409, 'CONFLICT')),
      'vendor_refused',
      'vendor_refused',
    ],
    [
      'a vendor 400 inside a 200',
      () => Promise.resolve({ status: 400, body: {} }),
      'vendor_refused',
      'vendor_refused',
    ],
    [
      'a vendor 503 inside a 200',
      () => Promise.resolve({ status: 503, body: {} }),
      'vendor_down',
      'vendor_down',
    ],
    [
      'a 502',
      () => Promise.reject(providerError(502, 'DEPENDENCY_FAILURE')),
      'unconfirmed',
      'unconfirmed',
    ],
    [
      'a codeless 503, provably unsent',
      () => Promise.reject(new CallbackRefusedError('provider', 503, '')),
      'vendor_down',
      'vendor_down',
    ],
    [
      'no answer',
      async () => Promise.reject(await noAnswer('the raw text')),
      'unanswered',
      'unanswered',
    ],
    [
      'a typed model refusal',
      () =>
        Promise.reject(
          refusalFixture('model', {
            status: 422,
            code: 'BAD_REQUEST',
            detail: 'the raw text',
            details: { reason: 'content_filtered' },
          }),
        ),
      'ai_refused',
      'ai_refused',
    ],
    [
      'a cut-off answer',
      () =>
        Promise.reject(
          refusalFixture('model', {
            status: 422,
            code: 'BAD_REQUEST',
            detail: 'the raw text',
            details: { reason: 'truncated' },
          }),
        ),
      'ai_refused',
      'ai_too_long',
    ],
    ['a timeout', () => Promise.reject(timeout), 'timeout', 'timeout'],
    // Each typed model refusal by what a person can do: the allowance, the setup, the file.
    ...(
      [
        ['over_plan_limit', 403, 'ai_allowance'],
        ['capability_not_in_plan', 403, 'ai_setup'],
        ['entitlements_not_configured', 403, 'ai_setup'],
        ['no_model_left', 422, 'ai_setup'],
        ['file_too_large', 422, 'ai_refused'],
      ] as const
    ).map(([reason, status, word]): [string, () => Promise<unknown>, string, string] => [
      reason,
      () =>
        Promise.reject(
          refusalFixture('model', {
            status,
            code: status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST',
            detail: 'the raw text',
            details: { reason },
          }),
        ),
      'ai_refused',
      word,
    ]),
  ];
  for (const [name, call, kind, word] of cases) {
    const sent = await settle(context, call);
    assert.deepEqual(
      sent,
      { ok: false, kind, sentence: FLOW_WORDS[word as keyof typeof FLOW_WORDS] },
      name,
    );
    assert.ok(!JSON.stringify(sent).includes('raw text'), name);
  }
  assert.deepEqual(await settle(context, () => Promise.resolve({ status: 200, body: {} })), {
    ok: true,
    value: { status: 200, body: {} },
  });
  // The step's own mistake is no kind: rethrown, for the runner's standard sentence.
  const own = new RangeError('the raw text');
  await assert.rejects(
    settle(context, () => Promise.reject(own)),
    (error) => error === own,
  );
  // While the runner would run the step again, settle rethrows.
  const retrying = { retryLeft: () => true };
  const busy = new CallbackRefusedError('provider', 503, '');
  await assert.rejects(
    settle(retrying, () => Promise.reject(busy)),
    (error) => error === busy,
  );
});

test('optionalConnection: not chosen is skipped by the step; chosen and not connected goes on with its line, logged', () => {
  const logged: unknown[][] = [];
  const chosen = optionalConnection(
    {
      request: invoke({ config: { vendor: 'quickbooks' } }),
      log: (...line) => void logged.push(line),
    },
    'vendor',
    'quickbooks',
  );
  assert.equal(chosen.chosen, true);
  assert.deepEqual(logged, [], 'nothing logged until it is not connected');
  assert.deepEqual(chosen.notConnected('QuickBooks', { a: 1 }), {
    outcome: 'failed',
    summary: "Not sent to QuickBooks: QuickBooks isn't connected",
    state: { a: 1 },
  });
  assert.deepEqual(logged, [['info', 'not_connected', { providerId: 'quickbooks' }]]);
  assert.equal(notSentLine('QuickBooks'), "Not sent to QuickBooks: QuickBooks isn't connected");
  assert.equal(
    optionalConnection({ request: invoke({ config: { vendor: 'none' } }) }, 'vendor', 'quickbooks')
      .chosen,
    false,
  );
  assert.equal(optionalConnection({ request: invoke() }, 'vendor', 'quickbooks').chosen, false);
});
