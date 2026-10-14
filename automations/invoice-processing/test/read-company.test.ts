import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAULT_MARKER, QuickBooksSimulator, faultAnswer } from '@autom8x/automation-kit/testing';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { nameWords } from '../src/words.js';
import { callsOf, everythingSaid, lines, setUp } from './fixtures.js';

/**
 * `read-company`: one `companyInfo.get`, on the QuickBooks path; a US company continues with its
 * names kept. Anything that keeps QuickBooks from recording the document — another country, no
 * usable answer — is "not recorded in QuickBooks": the run goes on to read the document and save its
 * details, every later QuickBooks step skipped (decision 6). Line (§3.E): `QuickBooks: {company}`.
 */

/** The run's state through verify-read, and whether QuickBooks will record. */
const quickBooksOf = (result: Awaited<ReturnType<ReturnType<typeof setUp>['run']>>) =>
  result.outcome === 'success' ? result.output?.quickBooks : result;

async function readWith(edit: (info: Record<string, unknown>) => void = () => undefined) {
  const world = setUp();
  edit(world.simulator.company.companyInfo);
  const result = await world.run();
  const line = lines(world.platform).find(([stepId]) => stepId === 'read-company');
  return { ...world, result, line };
}

test('a US company continues: its names are kept and the line names it', async () => {
  const { result, line, platform, request } = await readWith();
  assert.deepEqual(line, ['read-company', 'ok', 'QuickBooks: Sample Bakery']);
  assert.ok(result.outcome === 'success');
  assert.deepEqual(result.output?.company, {
    name: 'Sample Bakery',
    legalName: 'Sample Bakery LLC',
    country: 'USA',
    createdAt: '2024-01-02T09:00:00-08:00',
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

test('another country: only US companies work; a missing or blank one, QuickBooks did not answer usably — the run goes on without QuickBooks', async () => {
  for (const country of ['CA', 'GB', 'USA2', 'U.S.A.']) {
    const { result, line, platform } = await readWith((info) => (info.Country = country));
    assert.deepEqual(quickBooksOf(result), { notRecorded: 'only US companies work' });
    assert.deepEqual(line, [
      'read-company',
      'failed',
      'Not recorded in QuickBooks: only US companies work',
    ]);
    const reported = platform.steps.map((step) => step.stepId);
    assert.ok(!reported.includes('read-preferences') && !reported.includes('find-accounts'));
    assert.ok(reported.includes('extract'), 'the document is still read');
  }
  for (const edit of [
    (info: Record<string, unknown>) => delete info.Country,
    (info: Record<string, unknown>) => (info.Country = ''),
    (info: Record<string, unknown>) => (info.Country = '   '),
    (info: Record<string, unknown>) => (info.Country = null),
  ]) {
    const { result, line } = await readWith(edit);
    assert.deepEqual(quickBooksOf(result), { notRecorded: "QuickBooks didn't answer" });
    assert.equal(line?.[2], "Not recorded in QuickBooks: QuickBooks didn't answer");
  }
});

test("the company file's creation time is kept from the same answer, for confirm-company; null when QuickBooks does not give one", async () => {
  const created = async (edit: (info: Record<string, unknown>) => void) => {
    const { result, platform, request } = await readWith(edit);
    assert.ok(result.outcome === 'success');
    assert.equal(callsOf(platform, request, 'read-company').length, 1, 'no extra call');
    return (result.output?.company as { createdAt: unknown }).createdAt;
  };
  assert.equal(
    await created((info) => (info.MetaData = { CreateTime: ' 2015-06-05T13:55:54-07:00 ' })),
    '2015-06-05T13:55:54-07:00',
  );
  for (const edit of [
    (info: Record<string, unknown>) => delete info.MetaData,
    (info: Record<string, unknown>) => (info.MetaData = { CreateTime: '' }),
    (info: Record<string, unknown>) => (info.MetaData = { CreateTime: 20150605 }),
    (info: Record<string, unknown>) => (info.MetaData = 'x'),
  ]) {
    assert.equal(await created(edit), null);
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

test('an answer without a CompanyInfo or a CompanyName, or a body that was not JSON, is QuickBooks not answering usably', async () => {
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
    assert.deepEqual(quickBooksOf(result), { notRecorded: "QuickBooks didn't answer" });
    assert.equal(
      lines(world.platform)[1]?.[2],
      "Not recorded in QuickBooks: QuickBooks didn't answer",
    );
  }
});

test('a Fault inside a 200: QuickBooks did not answer usably; its text, and its number, appear nowhere a person reads', async () => {
  const world = setUp();
  world.simulator.script('companyInfo.get', [
    { status: 200, body: faultAnswer('150', 'SystemFault') },
  ]);
  const result = await world.run();
  assert.deepEqual(quickBooksOf(result), { notRecorded: "QuickBooks didn't answer" });
  assert.equal(
    lines(world.platform)[1]?.[2],
    "Not recorded in QuickBooks: QuickBooks didn't answer",
  );
  assert.ok(!everythingSaid(world.platform, result).includes(FAULT_MARKER));
  assert.ok(!JSON.stringify(world.platform.steps).includes('150'), 'no code in a line');
});

test('a long company name is shortened to 60 characters in the line', async () => {
  const name = `${'Sample '.repeat(30)}Bakery`;
  const { line, result } = await readWith((info) => (info.CompanyName = name));
  assert.equal(line?.[2], `QuickBooks: ${nameWords(name)}`);
  assert.ok((line?.[2] ?? '').length <= 'QuickBooks: '.length + 60);
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
  assert.deepEqual(lines(again.platform)[1], ['read-company', 'ok', 'QuickBooks: Sample Bakery']);
  assert.ok(
    simulator.calls.some(
      (call) => call.operation === 'companyInfo.get' && call.outcome === 'replayed',
    ),
  );
});
