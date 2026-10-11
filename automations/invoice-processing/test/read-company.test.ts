import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAULT_MARKER, QuickBooksSimulator, faultAnswer } from '@autom8x/automation-kit/testing';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { callsOf, everythingSaid, lines, setUp } from './fixtures.js';

/** `read-company`: one `companyInfo.get`; a US company continues with its names kept. */

async function readWith(edit: (info: Record<string, unknown>) => void = () => undefined) {
  const world = setUp();
  edit(world.simulator.company.companyInfo);
  const result = await world.run();
  const line = lines(world.platform).find(([stepId]) => stepId === 'read-company');
  return { ...world, result, line };
}

test('a US company continues: its names are kept and the line names it', async () => {
  const { result, line, platform, request } = await readWith();
  assert.deepEqual(line, ['read-company', 'ok', 'QuickBooks company: Sample Bakery (US)']);
  assert.ok(result.outcome === 'success');
  assert.deepEqual(result.output?.company, {
    name: 'Sample Bakery',
    legalName: 'Sample Bakery LLC',
    country: 'USA',
  });
  assert.deepEqual(callsOf(platform, request, 'read-company'), [
    { providerId: 'quickbooks', operation: 'companyInfo.get', input: {} },
  ]);
});

test("'US', 'us ', 'United States' and 'united states of america' continue, kept as returned", async () => {
  for (const country of ['US', 'us ', 'United States', 'united states of america']) {
    const { result } = await readWith((info) => (info.Country = country));
    assert.ok(result.outcome === 'success', country);
    assert.equal((result.output?.company as { country: string }).country, country);
  }
});

test('another country fails as not US; a missing or blank one as unknown', async () => {
  for (const country of ['CA', 'GB', 'USA2', 'U.S.A.']) {
    const { result, line, platform } = await readWith((info) => (info.Country = country));
    assert.deepEqual(result, {
      outcome: 'failed',
      failureReason:
        'Invoice Processing works only with US QuickBooks companies, and this company is set up for another country.',
    });
    assert.deepEqual(line, [
      'read-company',
      'failed',
      'QuickBooks company not checked (company_not_us)',
    ]);
    assert.equal(platform.steps.length, 2, 'nothing after read-company runs');
  }
  for (const edit of [
    (info: Record<string, unknown>) => delete info.Country,
    (info: Record<string, unknown>) => (info.Country = ''),
    (info: Record<string, unknown>) => (info.Country = '   '),
    (info: Record<string, unknown>) => (info.Country = null),
  ]) {
    const { result, line } = await readWith(edit);
    assert.deepEqual(result, {
      outcome: 'failed',
      failureReason:
        'QuickBooks did not say which country this company is in, so Invoice Processing cannot use it. Nothing was created.',
    });
    assert.equal(line?.[2], 'QuickBooks company not checked (company_country_unknown)');
  }
});

test('a missing or blank LegalName is kept as null', async () => {
  for (const edit of [
    (info: Record<string, unknown>) => delete info.LegalName,
    (info: Record<string, unknown>) => (info.LegalName = ' '),
    (info: Record<string, unknown>) => (info.LegalName = 12),
  ]) {
    const { result } = await readWith(edit);
    assert.ok(result.outcome === 'success');
    assert.equal((result.output?.company as { legalName: unknown }).legalName, null);
  }
});

test('an answer without a CompanyInfo or a CompanyName, or a body that was not JSON, is unexpected', async () => {
  const bodies = [
    { time: 't' },
    { CompanyInfo: [] },
    { CompanyInfo: { Country: 'USA' } },
    { CompanyInfo: { CompanyName: '  ', Country: 'USA' } },
    // What Connections sends in place of a body that was not JSON.
    { error: 'the provider returned a response that is not JSON' },
  ];
  for (const body of bodies) {
    const world = setUp();
    world.simulator.script('companyInfo.get', [{ status: 200, body }]);
    const result = await world.run();
    assert.deepEqual(result, {
      outcome: 'failed',
      failureReason:
        'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
    });
    assert.equal(
      lines(world.platform)[1]?.[2],
      'QuickBooks company not checked (unexpected_answer)',
    );
  }
});

test('a Fault inside a 200 fails by its number alone; its text appears nowhere', async () => {
  const world = setUp();
  world.simulator.script('companyInfo.get', [
    { status: 200, body: faultAnswer('150', 'SystemFault') },
  ]);
  const result = await world.run();
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason:
      'QuickBooks answered with error 150 while reading the company. Check QuickBooks, then run it again.',
  });
  assert.equal(lines(world.platform)[1]?.[2], 'QuickBooks company not checked (qb_error 150)');
  assert.ok(!everythingSaid(world.platform, result).includes(FAULT_MARKER));
});

test('a long company name is cut to 120 characters in the line', async () => {
  const name = `${'Sample '.repeat(30)}Bakery`;
  const { line, result } = await readWith((info) => (info.CompanyName = name));
  assert.equal(line?.[2], `QuickBooks company: ${name.slice(0, 120).trimEnd()} (US)`);
  assert.ok(result.outcome === 'success');
  assert.equal((result.output?.company as { name: string }).name, name, 'kept whole in the state');
});

test('every call is the one request under the step key; a replayed answer gives the same decision', async () => {
  const world = setUp();
  world.simulator.script('companyInfo.get', [{ status: 429 }, { status: 500 }, { status: 200 }]);
  assert.equal((await world.run()).outcome, 'success');
  assert.deepEqual(world.waits, [60_000]);
  assert.deepEqual(callsOf(world.platform, world.request, 'read-company'), [
    { providerId: 'quickbooks', operation: 'companyInfo.get', input: {} },
    { providerId: 'quickbooks', operation: 'companyInfo.get', input: {} },
    { providerId: 'quickbooks', operation: 'companyInfo.get', input: {} },
  ]);
  // The platform dispatches the same run again: the same keys meet Connections' records,
  // so a company that moved abroad since reads as it did, and the step decides the same.
  const simulator = new QuickBooksSimulator({ refusal: refusalFixture });
  const first = setUp({ simulator });
  assert.equal((await first.run()).outcome, 'success');
  simulator.company.companyInfo.Country = 'CA';
  const again = setUp({ simulator, runId: first.request.runId });
  assert.equal((await again.run()).outcome, 'success');
  assert.deepEqual(lines(again.platform)[1], [
    'read-company',
    'ok',
    'QuickBooks company: Sample Bakery (US)',
  ]);
  assert.ok(
    simulator.calls.some(
      (call) => call.operation === 'companyInfo.get' && call.outcome === 'replayed',
    ),
  );
});
