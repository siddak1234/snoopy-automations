import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';
import { refusalFixture, type ProblemInput } from '@autom8x/automation-sdk/testing';

import {
  QUICKBOOKS_WRITES,
  writeQuickBooks,
  writeSentences,
  type QuickBooksWriteKind,
} from '../src/quickbooks/write.js';
import { FAULT_MARKER, faultAnswer } from '../src/testing/quickbooks-company.js';
import { PROVIDER_REFUSALS } from '../src/testing/quickbooks-simulator.js';
import { harness, sent } from './fixtures.js';

/**
 * `writeQuickBooks`: one request whatever happens, never repeated; a certain failure says
 * nothing was created, an uncertain one that QuickBooks did not confirm it; the request id
 * left to the platform; Intuit's words nowhere.
 */

/** An expense the made-up company accepts: Checking pays, Office Supplies is the category. */
const EXPENSE: JsonObject = {
  PaymentType: 'Cash',
  AccountRef: { value: '35' },
  TxnDate: '2026-10-01',
  PrivateNote: 'Created by Autom8x, run 11111111-1111-4111-8111-111111111111',
  Line: [
    {
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: 45.2,
      AccountBasedExpenseLineDetail: { AccountRef: { value: '64' } },
    },
  ],
};

function writeWith(kind: QuickBooksWriteKind = 'expense', input: JsonObject = EXPENSE) {
  const world = harness();
  return {
    ...world,
    write: () => writeQuickBooks({ platform: world.platform, kind, input }),
  };
}

const UNCONFIRMED =
  'QuickBooks did not confirm whether the expense was created. Check QuickBooks before running this again.';

test('a created record is its Id and the record, from one request sent as it was given', async () => {
  const { write, recording, simulator } = writeWith();
  const result = await write();
  assert.ok(result.ok);
  assert.equal(result.id, '1001');
  assert.equal(result.record.TotalAmt, 45.2);
  assert.deepEqual(recording.providerCalls.map(sent), [
    { providerId: 'quickbooks', operation: 'purchase.create', input: EXPENSE },
  ]);
  assert.equal(simulator.company.purchases.length, 1);
});

test('each kind names its operation and the entity its answer carries', () => {
  assert.deepEqual(QUICKBOOKS_WRITES, {
    bill: { operation: 'bill.create', entity: 'Bill', noun: 'bill' },
    expense: { operation: 'purchase.create', entity: 'Purchase', noun: 'expense' },
    vendorCredit: {
      operation: 'vendorCredit.create',
      entity: 'VendorCredit',
      noun: 'vendor credit',
    },
    journalEntry: {
      operation: 'journalEntry.create',
      entity: 'JournalEntry',
      noun: 'journal entry',
    },
  });
});

test('the request id is the platform’s: an input naming requestid is refused before anything is sent', async () => {
  const { write, recording } = writeWith('expense', { ...EXPENSE, requestid: 'abc' });
  await assert.rejects(write(), /the platform adds the request id/u);
  assert.deepEqual(recording.providerCalls, []);
});

test('QuickBooks 5xx, 429, 408 or 425, a Fault 600, or a 2xx without an Id: not confirmed, and never asked again', async () => {
  const cases: [string, { status: number; body?: unknown }, string][] = [
    ['500', { status: 500 }, '500'],
    ['503', { status: 503 }, '503'],
    ['429', { status: 429 }, '429'],
    ['408', { status: 408 }, '408'],
    ['425', { status: 425 }, '425'],
    ['a 500 carrying a Fault', { status: 500, body: faultAnswer('10000') }, '500'],
    ['Fault 600 in a 400', { status: 400, body: faultAnswer('600') }, '600'],
    ['Fault 600 in a 200', { status: 200, body: faultAnswer('600') }, '600'],
    ['a 200 without the record', { status: 200, body: { time: 't' } }, 'no_id'],
    ['a 200 with an empty Id', { status: 200, body: { Purchase: { Id: ' ' } } }, 'no_id'],
    ['a 200 with a numeric Id', { status: 200, body: { Purchase: { Id: 7 } } }, 'no_id'],
  ];
  for (const [name, answer, detail] of cases) {
    const { write, recording, simulator } = writeWith();
    simulator.script('purchase.create', [answer, { status: 200 }]);
    assert.deepEqual(
      await write(),
      { ok: false, reason: 'qb_unconfirmed', created: 'unknown', sentence: UNCONFIRMED, detail },
      name,
    );
    assert.equal(recording.providerCalls.length, 1, `${name}: one request, never repeated`);
  }
});

test('the platform’s uncertain refusals — a reasonless 502, a 409 for another body under the key, no answer at all — are not confirmed', async () => {
  const thrown: [string, Error, string | undefined][] = [
    ['a reasonless 502', refusalFixture('provider', PROVIDER_REFUSALS.noAnswer()), '502'],
    [
      'idempotency_key_reused',
      refusalFixture('provider', PROVIDER_REFUSALS.keyReused('purchase.create')),
      'idempotency_key_reused',
    ],
    [
      'a 504',
      refusalFixture('provider', { status: 504, code: 'DEPENDENCY_FAILURE', detail: 'x' }),
      '504',
    ],
    ['no answer', new TypeError('fetch failed'), undefined],
    ['another callback', refusalFixture('model', PROVIDER_REFUSALS.notConnected()), undefined],
  ];
  for (const [name, error, detail] of thrown) {
    const { platform } = harness();
    let calls = 0;
    const result = await writeQuickBooks({
      platform: {
        callProvider: () => {
          calls += 1;
          return Promise.reject(error);
        },
      },
      kind: 'expense',
      input: EXPENSE,
    });
    assert.deepEqual(
      result,
      {
        ok: false,
        reason: 'qb_unconfirmed',
        created: 'unknown',
        sentence: UNCONFIRMED,
        ...(detail === undefined ? {} : { detail }),
      },
      name,
    );
    assert.equal(calls, 1, name);
    assert.ok(platform);
  }
});

test('refused before QuickBooks, or by it: certain, each with its sentence', async () => {
  const refusals: [string, ProblemInput, string, string | undefined][] = [
    ['not connected', PROVIDER_REFUSALS.notConnected(), 'qb_not_connected', undefined],
    [
      'scope missing',
      PROVIDER_REFUSALS.badRequest('purchase.create', 'insufficient_scope'),
      'qb_missing_scope',
      undefined,
    ],
    [
      'not configured',
      PROVIDER_REFUSALS.notConfigured('purchase.create'),
      'qb_not_configured',
      undefined,
    ],
    [
      'missing_request_id',
      PROVIDER_REFUSALS.badRequest('purchase.create', 'missing_request_id'),
      'platform_refused',
      'missing_request_id',
    ],
    [
      'a 400 naming no reason',
      { status: 400, code: 'BAD_REQUEST', detail: 'x' },
      'platform_refused',
      'refused',
    ],
    [
      'provider_not_declared',
      PROVIDER_REFUSALS.providerNotDeclared(),
      'platform_refused',
      'provider_not_declared',
    ],
    [
      'deadline_exceeded',
      { status: 403, code: 'FORBIDDEN', detail: 'x', details: { reason: 'deadline_exceeded' } },
      'platform_refused',
      'deadline_exceeded',
    ],
    [
      "the Edge's flood valve",
      { status: 429, code: 'TOO_MANY_REQUESTS', detail: 'x' },
      'platform_busy',
      undefined,
    ],
  ];
  for (const [name, problem, reason, detail] of refusals) {
    const { write, recording, simulator } = writeWith('vendorCredit', {
      VendorRef: { value: '9' },
    });
    simulator.script('vendorCredit.create', [{ refuse: problem }]);
    const result = await write();
    assert.deepEqual(
      result,
      {
        ok: false,
        reason,
        created: false,
        sentence: writeSentences('vendor credit')[reason as 'qb_refused'],
        ...(detail === undefined ? {} : { detail }),
      },
      name,
    );
    assert.equal(recording.providerCalls.length, 1, name);
  }
  const answered: [string, { status: number; body?: unknown }, string, string][] = [
    ['QuickBooks 401', { status: 401 }, 'qb_reauthorize', '401'],
    ['QuickBooks 403', { status: 403 }, 'qb_forbidden', '403'],
    ['a Fault in a 400', { status: 400, body: faultAnswer('6210') }, 'qb_refused', '6210'],
    ['a Fault in a 200', { status: 200, body: faultAnswer('2500') }, 'qb_refused', '2500'],
    [
      'a Fault without a number',
      { status: 400, body: { Fault: { Error: [{ code: FAULT_MARKER }] } } },
      'qb_refused',
      '400',
    ],
    ['a 404 with no Fault', { status: 404, body: {} }, 'qb_refused', '404'],
  ];
  for (const [name, answer, reason, detail] of answered) {
    const { write, simulator } = writeWith('journalEntry', { Line: [] });
    simulator.script('journalEntry.create', [answer]);
    assert.deepEqual(
      await write(),
      {
        ok: false,
        reason,
        created: false,
        sentence: writeSentences('journal entry')[reason as 'qb_refused'],
        detail,
      },
      name,
    );
  }
});

test('the sentences: one set per record, each at most 200 characters, never Intuit’s words', async () => {
  for (const { noun } of Object.values(QUICKBOOKS_WRITES)) {
    const sentences = writeSentences(noun);
    for (const [reason, sentence] of Object.entries(sentences)) {
      assert.ok(sentence.length <= 200, `${noun} ${reason}: ${sentence.length}`);
      assert.ok(sentence.includes(noun), `${noun} ${reason}`);
    }
    assert.match(sentences.qb_unconfirmed, /did not confirm/u);
    for (const reason of ['qb_refused', 'platform_refused', 'platform_busy'] as const) {
      assert.match(sentences[reason], new RegExp(`no ${noun} was created`, 'u'));
    }
  }
  const { write, simulator } = writeWith();
  simulator.script('purchase.create', [{ status: 400, body: faultAnswer('2050') }]);
  assert.ok(!JSON.stringify(await write()).includes(FAULT_MARKER));
});
