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
 * while an attempt remains, so a 502 is retried before it is `vendor_down`.
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
    log: () => undefined,
  });
  return { automation, seen };
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

test('settle: a 502 twice ends vendor_down after two calls, never after the first', async () => {
  const { automation, seen } = posting(2);
  const platform = new RecordingPlatform();
  platform.provider = () => Promise.reject(providerError(502, 'DEPENDENCY_FAILURE'));
  const result = await automation.execute(invoke(), platform);
  assert.equal(platform.providerCalls.length, 2);
  assert.deepEqual(
    seen.map((entry) => !entry.ok && entry.kind),
    ['vendor_down'],
    'the first attempt rethrew',
  );
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.vendor_down });
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

test('optionalConnection: not chosen is skipped by the step; chosen and not connected goes on with its line', () => {
  const chosen = optionalConnection(
    invoke({ config: { vendor: 'quickbooks' } }),
    'vendor',
    'quickbooks',
  );
  assert.equal(chosen.chosen, true);
  assert.deepEqual(chosen.notConnected('QuickBooks', { a: 1 }), {
    outcome: 'failed',
    summary: "Not sent to QuickBooks: QuickBooks isn't connected",
    state: { a: 1 },
  });
  assert.equal(notSentLine('QuickBooks'), "Not sent to QuickBooks: QuickBooks isn't connected");
  assert.equal(
    optionalConnection(invoke({ config: { vendor: 'none' } }), 'vendor', 'quickbooks').chosen,
    false,
  );
  assert.equal(optionalConnection(invoke(), 'vendor', 'quickbooks').chosen, false);
});
