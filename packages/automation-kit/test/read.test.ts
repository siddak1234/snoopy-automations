import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RESERVE_AFTER_WAIT_MS,
  THROTTLE_WAIT_MS,
  readQuickBooks,
  type Clock,
  type QuickBooksReadRequest,
} from '../src/quickbooks/read.js';
import { FAULT_MARKER, faultAnswer } from '../src/testing/quickbooks-company.js';
import { fakeClock, harness, sent } from './fixtures.js';

/**
 * `readQuickBooks` against QuickBooks' own statuses, which arrive inside a successful
 * callback: the 429 waits (on a clock that only records them), the one 5xx repeat, and
 * the fixed sentences — with every call the same request.
 */

function readWith(
  platform: QuickBooksReadRequest['platform'],
  clock: Clock,
  deadline: string,
  extra: Partial<QuickBooksReadRequest> = {},
) {
  return readQuickBooks({
    platform,
    clock,
    deadline,
    operation: 'companyInfo.get',
    input: {},
    purpose: 'reading the company',
    ...extra,
  });
}

/** A run with its whole 15 minutes ahead. */
function setUp() {
  const time = fakeClock();
  return { ...harness(), ...time, deadline: time.deadlineIn(900_000) };
}

test('a 2xx without a Fault is the answer, from one call', async () => {
  const { platform, recording, clock, waits, deadline } = setUp();
  const read = await readWith(platform, clock, deadline);
  assert.ok(read.ok);
  assert.equal((read.body as { CompanyInfo: { Country: string } }).CompanyInfo.Country, 'USA');
  assert.deepEqual(recording.providerCalls.map(sent), [
    { providerId: 'quickbooks', operation: 'companyInfo.get', input: {} },
  ]);
  assert.deepEqual(waits, []);
});

test('a 429 waits 60 s and asks the same again, at most twice', async () => {
  const { platform, recording, simulator, clock, waits, deadline } = setUp();
  simulator.script('companyInfo.get', [{ status: 429 }, { status: 429 }, { status: 200 }]);
  const read = await readWith(platform, clock, deadline);
  assert.ok(read.ok);
  assert.deepEqual(waits, [THROTTLE_WAIT_MS, THROTTLE_WAIT_MS]);
  assert.equal(THROTTLE_WAIT_MS, 60_000);
  assert.equal(recording.providerCalls.length, 3);
  assert.equal(new Set(recording.providerCalls.map((call) => JSON.stringify(call))).size, 1);

  const again = setUp();
  again.simulator.script('companyInfo.get', [{ status: 429 }, { status: 429 }, { status: 429 }]);
  assert.deepEqual(await readWith(again.platform, again.clock, again.deadline), {
    ok: false,
    reason: 'qb_busy',
    sentence: 'QuickBooks is busy; run it again in a few minutes.',
    detail: '429',
  });
  assert.deepEqual(again.waits, [60_000, 60_000]);
  assert.equal(again.recording.providerCalls.length, 3);
});

test('a 429 waits only while five minutes would remain after the wait', async () => {
  assert.equal(RESERVE_AFTER_WAIT_MS, 300_000);
  // Exactly six minutes left: the wait would leave less than the reserve.
  const short = setUp();
  short.simulator.script('companyInfo.get', [{ status: 429 }, { status: 200 }]);
  const read = await readWith(short.platform, short.clock, short.deadlineIn(360_000));
  assert.equal(read.ok ? 'ok' : read.reason, 'qb_busy');
  assert.deepEqual(short.waits, []);
  assert.equal(short.recording.providerCalls.length, 1);

  const enough = setUp();
  enough.simulator.script('companyInfo.get', [{ status: 429 }, { status: 200 }]);
  assert.ok((await readWith(enough.platform, enough.clock, enough.deadlineIn(360_001))).ok);
  assert.deepEqual(enough.waits, [60_000]);

  // The second wait is judged after the first: 7 minutes allow one, not two.
  const one = setUp();
  one.simulator.script('companyInfo.get', [{ status: 429 }, { status: 429 }]);
  const after = await readWith(one.platform, one.clock, one.deadlineIn(420_000));
  assert.equal(after.ok ? 'ok' : after.reason, 'qb_busy');
  assert.deepEqual(one.waits, [60_000]);

  const unreadable = setUp();
  unreadable.simulator.script('companyInfo.get', [{ status: 429 }, { status: 200 }]);
  const never = await readWith(unreadable.platform, unreadable.clock, 'not a date');
  assert.equal(never.ok ? 'ok' : never.reason, 'qb_busy');
  assert.deepEqual(unreadable.waits, []);
});

test('a 5xx is asked again once, at once; a 408 or 425 is busy with no repeat', async () => {
  const once = setUp();
  once.simulator.script('companyInfo.get', [{ status: 500 }, { status: 200 }]);
  assert.ok((await readWith(once.platform, once.clock, once.deadline)).ok);
  assert.equal(once.recording.providerCalls.length, 2);
  assert.deepEqual(once.waits, []);

  const twice = setUp();
  twice.simulator.script('companyInfo.get', [{ status: 500 }, { status: 503 }, { status: 200 }]);
  const busy = await readWith(twice.platform, twice.clock, twice.deadline);
  assert.deepEqual(busy, {
    ok: false,
    reason: 'qb_busy',
    sentence: 'QuickBooks is busy; run it again in a few minutes.',
    detail: '503',
  });
  assert.equal(twice.recording.providerCalls.length, 2, 'exactly two calls');

  for (const status of [408, 425]) {
    const slow = setUp();
    slow.simulator.script('companyInfo.get', [{ status }, { status: 200 }]);
    const read = await readWith(slow.platform, slow.clock, slow.deadline);
    assert.equal(read.ok ? 'ok' : read.reason, 'qb_busy', String(status));
    assert.equal(slow.recording.providerCalls.length, 1);
  }

  // The two counts are separate: a 429, then a 500, then the answer.
  const mixed = setUp();
  mixed.simulator.script('companyInfo.get', [{ status: 429 }, { status: 500 }, { status: 200 }]);
  assert.ok((await readWith(mixed.platform, mixed.clock, mixed.deadline)).ok);
  assert.deepEqual(mixed.waits, [60_000]);
  assert.equal(mixed.recording.providerCalls.length, 3);
});

test("a 401 or a 403 is the person's to fix, asked once", async () => {
  const expired = setUp();
  expired.simulator.script('companyInfo.get', [{ status: 401 }]);
  assert.deepEqual(await readWith(expired.platform, expired.clock, expired.deadline), {
    ok: false,
    reason: 'qb_reauthorize',
    sentence: 'Reconnect QuickBooks in Connections, then run it again.',
  });
  const forbidden = setUp();
  forbidden.simulator.script('companyInfo.get', [{ status: 403 }]);
  assert.deepEqual(await readWith(forbidden.platform, forbidden.clock, forbidden.deadline), {
    ok: false,
    reason: 'qb_forbidden',
    sentence:
      'QuickBooks refused access to this company. Reconnect QuickBooks in Connections as a company admin, then run it again.',
  });
  assert.equal(
    expired.recording.providerCalls.length + forbidden.recording.providerCalls.length,
    2,
  );
});

test('any other status, or a Fault in a 2xx, is an error named by its number alone', async () => {
  const cases: [unknown, string][] = [
    [{ status: 404 }, 'QuickBooks answered with error 404 while reading the company.'],
    [
      { status: 400, body: faultAnswer('4000') },
      'QuickBooks answered with error 4000 while reading the company.',
    ],
    [
      { status: 400, body: { error: 'x' } },
      'QuickBooks answered with error 400 while reading the company.',
    ],
    [
      { status: 200, body: faultAnswer('6000') },
      'QuickBooks answered with error 6000 while reading the company.',
    ],
    [
      {
        status: 200,
        body: { QueryResponse: { Fault: { Error: [{ code: '4001', Detail: FAULT_MARKER }] } } },
      },
      'QuickBooks answered with error 4001 while reading the company.',
    ],
    [
      { status: 200, body: { Fault: { Error: [{ code: FAULT_MARKER, Message: FAULT_MARKER }] } } },
      'QuickBooks answered with an error while reading the company.',
    ],
  ];
  for (const [answer, start] of cases) {
    const { platform, simulator, recording, clock, deadline } = setUp();
    simulator.script('companyInfo.get', [answer as { status: number }]);
    const read = await readWith(platform, clock, deadline);
    assert.ok(!read.ok);
    assert.equal(read.reason, 'qb_error');
    assert.equal(read.sentence, `${start} Check QuickBooks, then run it again.`);
    assert.ok(!JSON.stringify(read).includes(FAULT_MARKER));
    assert.equal(recording.providerCalls.length, 1, 'an error is final: asked once');
  }
  const { platform, simulator, clock, deadline } = setUp();
  simulator.script('query.run', [{ status: 400, body: faultAnswer('4000') }]);
  const read = await readWith(platform, clock, deadline, {
    operation: 'query.run',
    input: { query: 'x' },
    purpose: 'looking up the Expense account setting',
    advice: 'Remove unusual characters from it, then run it again.',
  });
  assert.deepEqual(read, {
    ok: false,
    reason: 'qb_error',
    sentence:
      'QuickBooks answered with error 4000 while looking up the Expense account setting. Remove unusual characters from it, then run it again.',
    detail: '4000',
  });
});
