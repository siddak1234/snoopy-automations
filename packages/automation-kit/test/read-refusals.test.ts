import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CallbackRefusedError, type StepPlatform } from '@autom8x/automation-sdk';
import { refusalFixture, type ProblemInput } from '@autom8x/automation-sdk/testing';

import { QUICKBOOKS_SENTENCES, readQuickBooks } from '../src/quickbooks/read.js';
import { PROVIDER_REFUSALS } from '../src/testing/quickbooks-simulator.js';
import { fakeClock, harness } from './fixtures.js';

/**
 * The platform's refusals of the provider callback: the ones that name a cause become a
 * sentence; every other failure is thrown on as the same object, so the SDK's step
 * retry can read a transient one and the run's wrapper can give its sentence.
 */

function read(platform: Pick<StepPlatform, 'callProvider'>, input: Record<string, unknown> = {}) {
  const { clock, deadlineIn } = fakeClock();
  return readQuickBooks({
    platform,
    clock,
    deadline: deadlineIn(900_000),
    operation: 'companyInfo.get',
    input,
    purpose: 'reading the company',
  });
}

function refusing(problem: ProblemInput) {
  const { simulator, platform, recording } = harness();
  simulator.script('companyInfo.get', [{ refuse: problem }]);
  return { platform, recording };
}

test('no live connection, a missing scope and Connections not configured are sentences', async () => {
  const { simulator, platform } = harness();
  simulator.connected = false;
  assert.deepEqual(await read(platform), {
    ok: false,
    reason: 'qb_not_connected',
    sentence: 'Reconnect QuickBooks in Connections, then run it again.',
  });
  const scope = refusing(PROVIDER_REFUSALS.badRequest('companyInfo.get', 'insufficient_scope'));
  assert.deepEqual(await read(scope.platform), {
    ok: false,
    reason: 'qb_missing_scope',
    sentence:
      'QuickBooks was connected without accounting access. Reconnect QuickBooks in Connections, then run it again.',
  });
  const unconfigured = refusing(PROVIDER_REFUSALS.notConfigured('companyInfo.get'));
  assert.deepEqual(await read(unconfigured.platform), {
    ok: false,
    reason: 'qb_not_configured',
    sentence:
      'QuickBooks calls are not available on Autom8x right now. Nothing was created; run it again later.',
  });
  assert.equal(scope.recording.providerCalls.length, 1, 'a refusal is final: asked once');
});

test('the refusals only a bug produces name the platform’s word and nothing more', async () => {
  const cases: [Promise<unknown>, string][] = [
    [read(harness().platform, { accountId: '9' }), 'reserved_parameter'],
    [
      read(refusing(PROVIDER_REFUSALS.badRequest('companyInfo.get', 'unknown_operation')).platform),
      'unknown_operation',
    ],
    [
      read(refusing(PROVIDER_REFUSALS.keyReused('companyInfo.get')).platform),
      'idempotency_key_reused',
    ],
    [read(refusing(PROVIDER_REFUSALS.providerNotDeclared()).platform), 'provider_not_declared'],
    // A 400 whose reason is not one word is named for what it is, and no more.
    [
      read(
        refusing({
          status: 400,
          code: 'BAD_REQUEST',
          detail: 'x',
          details: { reason: 'Bad Reason!' },
        }).platform,
      ),
      'refused',
    ],
    [read(refusing({ status: 400, code: 'BAD_REQUEST', detail: 'x' }).platform), 'refused'],
  ];
  for (const [pending, word] of cases) {
    assert.deepEqual(await pending, {
      ok: false,
      reason: 'platform_refused',
      sentence: `Autom8x could not ask QuickBooks (${word}). Nothing was created.`,
      detail: word,
    });
  }
});

test('every other failure is thrown on unchanged, the same object', async () => {
  const thrown: Error[] = [
    // No answer: what the SDK's retry repeats.
    refusalFixture('provider', PROVIDER_REFUSALS.noAnswer()),
    refusalFixture('provider', { status: 503, code: 'DEPENDENCY_FAILURE', detail: 'x' }),
    refusalFixture('provider', { status: 504, code: 'DEPENDENCY_FAILURE', detail: 'x' }),
    // Past the deadline, or the run has ended: nothing a sentence could reach.
    refusalFixture('provider', {
      status: 403,
      code: 'FORBIDDEN',
      detail: 'x',
      details: { reason: 'deadline_exceeded' },
    }),
    refusalFixture('provider', {
      status: 409,
      code: 'CONFLICT',
      detail: 'x',
      details: { reason: 'run_not_active' },
    }),
    // The Edge's flood valve: the run's wrapper says Autom8x is busy.
    refusalFixture('provider', { status: 429, code: 'TOO_MANY_REQUESTS', detail: 'x' }),
    // Another callback's refusal, and the client's own error for a malformed answer.
    refusalFixture('model', { status: 404, code: 'NOT_FOUND', detail: 'x' }),
    new Error('the provider callback did not answer with a status'),
    new TypeError('fetch failed'),
  ];
  for (const error of thrown) {
    const platform = { callProvider: () => Promise.reject(error) };
    await assert.rejects(read(platform), (caught) => caught === error);
  }
  // The SDK's own class, as the simulator throws it.
  const { simulator, platform } = harness();
  simulator.script('companyInfo.get', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]);
  await assert.rejects(
    read(platform),
    (caught) =>
      caught instanceof CallbackRefusedError &&
      caught.status === 502 &&
      caught.reason === undefined,
  );
});

test('the sentences, word for word', () => {
  assert.deepEqual(QUICKBOOKS_SENTENCES, {
    qb_not_connected: 'Reconnect QuickBooks in Connections, then run it again.',
    qb_reauthorize: 'Reconnect QuickBooks in Connections, then run it again.',
    qb_forbidden:
      'QuickBooks refused access to this company. Reconnect QuickBooks in Connections as a company admin, then run it again.',
    qb_missing_scope:
      'QuickBooks was connected without accounting access. Reconnect QuickBooks in Connections, then run it again.',
    qb_not_configured:
      'QuickBooks calls are not available on Autom8x right now. Nothing was created; run it again later.',
    qb_busy: 'QuickBooks is busy; run it again in a few minutes.',
    qb_unreachable:
      'Autom8x could not reach QuickBooks. Run it again in a few minutes; nothing was created.',
    unexpected_answer:
      'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
  });
  for (const sentence of Object.values(QUICKBOOKS_SENTENCES)) assert.ok(sentence.length <= 140);
});
