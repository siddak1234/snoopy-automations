import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CallbackRefusedError, type ProviderRequest } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { lookupQuery } from '../src/quickbooks/query.js';
import { FAULT_MARKER, sampleAccount } from '../src/testing/quickbooks-company.js';
import { PROVIDER_REFUSALS, QuickBooksSimulator } from '../src/testing/quickbooks-simulator.js';

/** The simulator holds the platform's Connections to its rules, and answers as QuickBooks. */

const KEY = `read-company-${'a'.repeat(48)}`;
const OTHER_KEY = `find-account-${'b'.repeat(48)}`;

function call(
  operation: string,
  input: Record<string, unknown> = {},
  idempotencyKey = KEY,
): ProviderRequest {
  return { providerId: 'quickbooks', operation, input, idempotencyKey };
}

function simulator() {
  return new QuickBooksSimulator({ refusal: refusalFixture });
}

function refusedWith(status: number, reason?: string) {
  return (error: unknown) =>
    error instanceof CallbackRefusedError &&
    error.callback === 'provider' &&
    error.status === status &&
    error.reason === reason;
}

test("QuickBooks answers its reads in Intuit's shapes, from the made-up company", async () => {
  const sim = simulator();
  const info = await sim.provider(call('companyInfo.get'));
  assert.equal(info.status, 200);
  const body = info.body as { CompanyInfo: Record<string, unknown>; time: string };
  assert.equal(body.CompanyInfo.CompanyName, 'Sample Bakery');
  assert.equal(body.CompanyInfo.Country, 'USA');
  assert.equal(typeof body.time, 'string');
  const prefs = await sim.provider(call('preferences.get', {}, OTHER_KEY));
  assert.deepEqual(
    (prefs.body as { Preferences: { CurrencyPrefs: unknown } }).Preferences.CurrencyPrefs,
    {
      HomeCurrency: { value: 'USD' },
      MultiCurrencyEnabled: false,
    },
  );
  await assert.rejects(
    sim.provider(call('bill.create', {}, `x-${'c'.repeat(48)}`)),
    /does not answer bill\.create/u,
  );
  await assert.rejects(
    sim.provider({ ...call('companyInfo.get'), providerId: 'google' }),
    /provider google/u,
  );
});

test('query.run answers exactly the lookup text, matched without case, unescaped, at most MAXRESULTS', async () => {
  const sim = simulator();
  sim.company.accounts.push(sampleAccount('90', "Legal:O'Brien's \\ Fees", 'Expense'));
  const ask = async (name: string, max = 2, key = `q-${name.length}-${'d'.repeat(40)}`) =>
    (
      await sim.provider(
        call('query.run', { query: lookupQuery('Account', 'FullyQualifiedName', name, max) }, key),
      )
    ).body;

  const found = (await ask('utilities:ELECTRIC')) as {
    QueryResponse: { Account: { Id: string }[]; maxResults: number };
  };
  assert.deepEqual(
    found.QueryResponse.Account.map((row) => row.Id),
    ['57'],
  );
  assert.equal(found.QueryResponse.maxResults, 1);
  const escaped = (await ask("Legal:O'Brien's \\ Fees")) as {
    QueryResponse: { Account: { Id: string }[] };
  };
  assert.deepEqual(
    escaped.QueryResponse.Account.map((row) => row.Id),
    ['90'],
  );
  // Nothing matched: Intuit leaves the entity array out.
  assert.deepEqual(((await ask('Utilities:Gas')) as { QueryResponse: unknown }).QueryResponse, {});

  sim.company.accounts.push(sampleAccount('91', 'Office Supplies', 'Expense', { Active: false }));
  const both = (await ask('office supplies', 2, `both-${'e'.repeat(48)}`)) as {
    QueryResponse: { Account: unknown[] };
  };
  assert.equal(both.QueryResponse.Account.length, 2, 'active and inactive alike');
  const one = (await ask('office supplies', 1, `one-${'e'.repeat(48)}`)) as {
    QueryResponse: { Account: unknown[] };
  };
  assert.equal(one.QueryResponse.Account.length, 1);

  // Any other text is a parser Fault, so a changed query fails the suite that sent it.
  for (const query of [
    "SELECT * FROM Account WHERE Name = 'Utilities'",
    'select * from Account',
    '',
  ]) {
    const answer = await sim.provider(
      call('query.run', { query }, `bad-${query.length}-${'f'.repeat(40)}`),
    );
    assert.equal(answer.status, 400);
    assert.match(JSON.stringify(answer.body), /"code":"4000"/u);
    assert.ok(JSON.stringify(answer.body).includes(FAULT_MARKER));
  }
});

test('a final answer is replayed for the same request under its key, whatever QuickBooks now holds', async () => {
  const sim = simulator();
  const first = await sim.provider(call('companyInfo.get'));
  sim.company.companyInfo.Country = 'CA';
  const again = await sim.provider(call('companyInfo.get'));
  assert.deepEqual(again, first);
  assert.deepEqual(
    sim.calls.map((entry) => entry.outcome),
    ['answered', 'replayed'],
  );
  // A final 4xx is recorded too.
  sim.script('preferences.get', [{ status: 404 }]);
  const missing = await sim.provider(call('preferences.get', {}, OTHER_KEY));
  assert.deepEqual(await sim.provider(call('preferences.get', {}, OTHER_KEY)), missing);
  assert.equal(sim.calls.at(-1)?.outcome, 'replayed');
});

test('a different request under a used key is refused 409 idempotency_key_reused', async () => {
  const sim = simulator();
  await sim.provider(
    call('query.run', { query: lookupQuery('Account', 'FullyQualifiedName', 'Utilities', 2) }),
  );
  await assert.rejects(
    sim.provider(
      call('query.run', { query: lookupQuery('Account', 'FullyQualifiedName', 'Checking', 2) }),
    ),
    refusedWith(409, 'idempotency_key_reused'),
  );
  // Key order inside the input is not a different request: the hash is canonical.
  const ordered = simulator();
  await ordered.provider(call('companyInfo.get', { a: 1, b: { c: 2, d: 3 } }));
  await ordered.provider(call('companyInfo.get', { b: { d: 3, c: 2 }, a: 1 }));
  assert.equal(ordered.calls.at(-1)?.outcome, 'replayed');
});

test('nothing is recorded for 5xx, 401, 403, 408, 425 or 429: the next call asks QuickBooks again', async () => {
  for (const status of [500, 503, 401, 403, 408, 425, 429]) {
    const sim = simulator();
    sim.script('companyInfo.get', [{ status }]);
    assert.equal((await sim.provider(call('companyInfo.get'))).status, status);
    assert.equal((await sim.provider(call('companyInfo.get'))).status, 200, String(status));
    assert.deepEqual(
      sim.calls.map((entry) => entry.outcome),
      ['answered', 'answered'],
    );
  }
});

test('an answer over 192 KiB reaches the automation as a 502 naming no reason, recorded nowhere', async () => {
  const sim = simulator();
  sim.script('companyInfo.get', [
    { status: 200, body: { CompanyInfo: { Notes: 'x'.repeat(192 * 1024) } } },
  ]);
  await assert.rejects(sim.provider(call('companyInfo.get')), refusedWith(502));
  assert.equal((await sim.provider(call('companyInfo.get'))).status, 200);
  assert.deepEqual(
    sim.calls.map((entry) => entry.outcome),
    ['refused', 'answered'],
  );
  // Just under the bound is an answer.
  const under = simulator();
  const body = { CompanyInfo: { Notes: 'x'.repeat(192 * 1024 - 40) } };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 192 * 1024);
  under.script('companyInfo.get', [{ status: 200, body }]);
  assert.equal((await under.provider(call('companyInfo.get'))).status, 200);
});

test('an input naming accountId is refused 400 reserved_parameter; nothing reaches QuickBooks', async () => {
  const sim = simulator();
  await assert.rejects(
    sim.provider(call('companyInfo.get', { accountId: '123' })),
    refusedWith(400, 'reserved_parameter'),
  );
  assert.deepEqual(
    sim.calls.map((entry) => [entry.outcome, entry.status]),
    [['refused', 400]],
  );
  assert.equal(
    (await sim.provider(call('companyInfo.get'))).status,
    200,
    'and nothing was recorded',
  );
});

test('no live connection is a 404 before anything else, a recorded answer included', async () => {
  const sim = simulator();
  await sim.provider(call('companyInfo.get'));
  sim.connected = false;
  await assert.rejects(sim.provider(call('companyInfo.get')), refusedWith(404));
});

test("a scripted refusal is the platform's, thrown as the SDK's client throws it, recording nothing", async () => {
  const sim = simulator();
  sim.script('companyInfo.get', [{ refuse: PROVIDER_REFUSALS.notConfigured('companyInfo.get') }]);
  await assert.rejects(
    sim.provider(call('companyInfo.get')),
    refusedWith(503, 'connections_not_configured'),
  );
  assert.equal((await sim.provider(call('companyInfo.get'))).status, 200);
});
