import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';
import type { ProblemInput } from '@autom8x/automation-sdk/testing';

import {
  writeQuickBooks,
  writeSentences,
  type QuickBooksWriteFailure,
  type QuickBooksWriteKind,
} from '../src/quickbooks/write.js';
import { FAULT_MARKER, faultAnswer } from '../src/testing/quickbooks-company.js';
import { PROVIDER_REFUSALS, type ScriptedAnswer } from '../src/testing/quickbooks-simulator.js';
import { harness } from './fixtures.js';

/**
 * A write repeated by the step's retry (Gate 25's AUT-38-1): once an attempt was thrown on
 * unanswered, it may have made the record — QuickBooks acting while its answer was lost — so no
 * later attempt's answer may say none was made. A refusal of the repeat, or QuickBooks refusing
 * it, says QuickBooks did not confirm it, naming what the repeat was answered; a step's first
 * answer is judged as it always was, and another step's write is judged afresh.
 */

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

const VENDOR: JsonObject = { DisplayName: 'Larkspur Paper Co.', CompanyName: 'Larkspur Paper Co.' };

/** The two kinds a step repeats here, each with its operation and a body QuickBooks accepts. */
const KINDS: readonly [QuickBooksWriteKind, string, JsonObject][] = [
  ['expense', 'purchase.create', EXPENSE],
  ['vendor', 'vendor.create', VENDOR],
];

/** One step's write: every attempt on the one platform object, as the SDK's runner hands it. */
function step(kind: QuickBooksWriteKind, input: JsonObject) {
  const world = harness();
  return { ...world, write: () => writeQuickBooks({ platform: world.platform, kind, input }) };
}

const unconfirmed = (kind: QuickBooksWriteKind, detail: string) => ({
  ok: false,
  reason: 'qb_unconfirmed',
  created: 'unknown',
  sentence: writeSentences(kind === 'vendor' ? 'vendor' : 'expense').qb_unconfirmed,
  detail,
});

/** A sentence certain that nothing was created: "No expense was created.", "so no vendor was created". */
const NOTHING_CREATED = /\bno (expense|vendor) was created\b/iu;

/** What answered nothing: lost after QuickBooks acted, or a 502 naming no reason. */
const NO_ANSWER: readonly [string, ScriptedAnswer][] = [
  ['an answer lost after QuickBooks made it', { lost: 'before_record' }],
  ['a reasonless 502', { refuse: PROVIDER_REFUSALS.noAnswer() }],
];

/** The platform's certain refusals, each with the word a repeat's "did not confirm" names. */
const REFUSED: readonly [string, (operation: string) => ProblemInput, string][] = [
  ['no live connection (404)', () => PROVIDER_REFUSALS.notConnected(), 'qb_not_connected'],
  [
    "the Edge's flood valve (429)",
    () => ({ status: 429, code: 'TOO_MANY_REQUESTS', detail: 'x' }),
    'platform_busy',
  ],
  [
    'a 400 naming its reason',
    (operation) => PROVIDER_REFUSALS.badRequest(operation, 'missing_request_id'),
    'missing_request_id',
  ],
  ['a 400 naming none', () => ({ status: 400, code: 'BAD_REQUEST', detail: 'x' }), 'refused'],
  [
    'a 403 at the deadline',
    () => ({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'x',
      details: { reason: 'deadline_exceeded' },
    }),
    'deadline_exceeded',
  ],
  [
    'a 403 for the provider',
    () => PROVIDER_REFUSALS.providerNotDeclared(),
    'provider_not_declared',
  ],
  [
    'the scope missing (400)',
    (operation) => PROVIDER_REFUSALS.badRequest(operation, 'insufficient_scope'),
    'qb_missing_scope',
  ],
  [
    'Connections unconfigured (503)',
    (operation) => PROVIDER_REFUSALS.notConfigured(operation),
    'qb_not_configured',
  ],
];

test("the review's case: QuickBooks made it and Connections recorded it, the answer was lost, then the connection was retired — the repeat's 404 says QuickBooks did not confirm it", async () => {
  const { write, simulator, recording } = step('expense', EXPENSE);
  simulator.script('purchase.create', [{ lost: 'after_record' }]);
  await assert.rejects(write());
  // Connections reads the credential before it serves a recorded answer: a 404 first.
  simulator.connected = false;
  assert.deepEqual(await write(), unconfirmed('expense', 'qb_not_connected'));
  assert.equal(recording.providerCalls.length, 2);
  assert.equal(simulator.company.purchases.length, 1, 'the expense QuickBooks made');
});

test('after an attempt nothing answered, a platform refusal of the repeat — 404, 429, 400, 403 and the rest — says QuickBooks did not confirm it, never that nothing was created', async () => {
  for (const [kind, operation, input] of KINDS) {
    for (const [lost, first] of NO_ANSWER) {
      for (const [name, problem, detail] of REFUSED) {
        const label = `${kind}, ${lost}, then ${name}`;
        const { write, simulator } = step(kind, input);
        simulator.script(operation, [first, { refuse: problem(operation) }]);
        await assert.rejects(write(), label);
        const result = await write();
        assert.deepEqual(result, unconfirmed(kind, detail), label);
        assert.doesNotMatch(JSON.stringify(result), NOTHING_CREATED, label);
      }
    }
  }
});

test("after an attempt nothing answered, QuickBooks refusing the repeat — a 401, a 403, a Fault, a 4xx — says it did not confirm it, Intuit's words nowhere", async () => {
  const answers: [string, ScriptedAnswer, string][] = [
    ['QuickBooks 401', { status: 401 }, '401'],
    ['QuickBooks 403', { status: 403 }, '403'],
    ['a Fault in a 400', { status: 400, body: faultAnswer('6210') }, '6210'],
    ['a Fault in a 200', { status: 200, body: faultAnswer('2500') }, '2500'],
    ['a 404 with no Fault', { status: 404, body: {} }, '404'],
  ];
  for (const [kind, operation, input] of KINDS) {
    for (const [name, answer, detail] of answers) {
      const { write, simulator } = step(kind, input);
      simulator.script(operation, [{ refuse: PROVIDER_REFUSALS.noAnswer() }, answer]);
      await assert.rejects(write(), name);
      const result = await write();
      assert.deepEqual(result, unconfirmed(kind, detail), `${kind}, ${name}`);
      assert.ok(!JSON.stringify(result).includes(FAULT_MARKER), name);
    }
  }
});

test('after an attempt nothing answered, a repeat QuickBooks answers with the record is that record, and an uncertain answer keeps its own word', async () => {
  const made = step('expense', EXPENSE);
  made.simulator.script('purchase.create', [{ lost: 'before_record' }]);
  await assert.rejects(made.write());
  const result = await made.write();
  assert.ok(result.ok);
  assert.equal(result.id, '1001');
  assert.equal(made.simulator.company.purchases.length, 1, 'one expense, answered twice');
  const busy = step('expense', EXPENSE);
  busy.simulator.script('purchase.create', [{ lost: 'before_record' }, { status: 500 }]);
  await assert.rejects(busy.write());
  assert.deepEqual(await busy.write(), unconfirmed('expense', '500'));
});

test("a step's first answer is judged as it always was: a clean refusal is certain, and leaves nothing that makes the next one uncertain", async () => {
  for (const [kind, operation, input] of KINDS) {
    for (const [name, problem, detail] of REFUSED) {
      const { write, simulator } = step(kind, input);
      simulator.script(operation, [{ refuse: problem(operation) }, { refuse: problem(operation) }]);
      for (const attempt of ['first', 'second']) {
        const result = await write();
        assert.equal(result.ok, false);
        if (result.ok) continue;
        assert.equal(result.created, false, `${kind}, ${name}, ${attempt}`);
        assert.notEqual(result.reason, 'qb_unconfirmed', `${kind}, ${name}, ${attempt}`);
        assert.match(result.sentence, NOTHING_CREATED, `${kind}, ${name}, ${attempt}`);
        // The word the repeat would have named is the certain failure's own.
        assert.equal(result.detail ?? result.reason, detail, `${kind}, ${name}`);
      }
    }
  }
});

test("the mark is the step's own: another step's write — another platform object, the same QuickBooks — is judged afresh", async () => {
  const { write, simulator, recording } = step('expense', EXPENSE);
  simulator.script('purchase.create', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]);
  await assert.rejects(write());
  simulator.connected = false;
  // Another step's platform, as the runner builds one per step: its key, its own object.
  const other = await writeQuickBooks({
    platform: {
      callProvider: (request) => recording.callProvider({ ...request, idempotencyKey: 'other' }),
    },
    kind: 'vendor',
    input: VENDOR,
  });
  const reason: QuickBooksWriteFailure = 'qb_not_connected';
  assert.deepEqual(other, {
    ok: false,
    reason,
    created: false,
    sentence: writeSentences('vendor')[reason],
  });
  // The first step's own repeat is still uncertain.
  assert.deepEqual(await write(), unconfirmed('expense', 'qb_not_connected'));
});
