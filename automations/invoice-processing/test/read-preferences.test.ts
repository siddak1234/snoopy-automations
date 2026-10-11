import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callsOf, lines, setUp } from './fixtures.js';

/** `read-preferences`: one `preferences.get`, keeping the settings later steps read. */

type Prefs = Record<string, Record<string, unknown>>;

async function readWith(edit: (prefs: Prefs) => void = () => undefined) {
  const world = setUp();
  edit(world.simulator.company.preferences as Prefs);
  const result = await world.run();
  const line = lines(world.platform).find(([stepId]) => stepId === 'read-preferences');
  const preferences = result.outcome === 'success' ? result.output?.preferences : undefined;
  return { ...world, result, line, preferences };
}

test('the company settings are kept and named in the line', async () => {
  const { line, preferences, platform, request } = await readWith();
  assert.deepEqual(line, [
    'read-preferences',
    'ok',
    'Home currency USD; multicurrency off; books closed through 2025-12-31',
  ]);
  assert.deepEqual(preferences, {
    homeCurrency: 'USD',
    multiCurrencyEnabled: false,
    customTxnNumbers: false,
    warnDuplicateBillNumber: false,
    bookCloseDate: '2025-12-31',
  });
  assert.deepEqual(callsOf(platform, request, 'read-preferences'), [
    { providerId: 'quickbooks', operation: 'preferences.get', input: {} },
  ]);
});

test('no AccountingInfoPrefs, or no closing date in it, continues with none', async () => {
  for (const edit of [
    (prefs: Prefs) => delete prefs.AccountingInfoPrefs,
    (prefs: Prefs) => delete prefs.AccountingInfoPrefs!.BookCloseDate,
  ]) {
    const { line, preferences } = await readWith(edit);
    assert.equal(
      line?.[2],
      'Home currency USD; multicurrency off; no closing date from QuickBooks',
    );
    assert.equal((preferences as { bookCloseDate: unknown }).bookCloseDate, null);
  }
});

test('a closing date that is not a real YYYY-MM-DD day is kept as null and called unreadable', async () => {
  for (const date of [
    '2026-02-30',
    '12/31/2025',
    '2025-13-01',
    '2025-12-31T00:00:00',
    20251231,
    '',
  ]) {
    const { line, preferences } = await readWith(
      (prefs) => (prefs.AccountingInfoPrefs!.BookCloseDate = date),
    );
    assert.equal(
      line?.[2],
      'Home currency USD; multicurrency off; closing date unreadable',
      String(date),
    );
    assert.equal((preferences as { bookCloseDate: unknown }).bookCloseDate, null);
  }
  const { preferences } = await readWith(
    (prefs) => (prefs.AccountingInfoPrefs!.BookCloseDate = '2024-02-29'),
  );
  assert.equal((preferences as { bookCloseDate: unknown }).bookCloseDate, '2024-02-29');
});

test('multicurrency is off when missing and on only when QuickBooks says true', async () => {
  const missing = await readWith((prefs) => delete prefs.CurrencyPrefs!.MultiCurrencyEnabled);
  assert.equal(
    (missing.preferences as { multiCurrencyEnabled: unknown }).multiCurrencyEnabled,
    false,
  );
  const text = await readWith((prefs) => (prefs.CurrencyPrefs!.MultiCurrencyEnabled = 'true'));
  assert.equal((text.preferences as { multiCurrencyEnabled: unknown }).multiCurrencyEnabled, false);
  const on = await readWith((prefs) => (prefs.CurrencyPrefs!.MultiCurrencyEnabled = true));
  assert.equal((on.preferences as { multiCurrencyEnabled: unknown }).multiCurrencyEnabled, true);
  assert.match(on.line?.[2] ?? '', /^Home currency USD; multicurrency on; /u);
});

test('a home currency that is missing or not three letters fails; one in lower case is read', async () => {
  const edits: ((prefs: Prefs) => void)[] = [
    (prefs) => delete prefs.CurrencyPrefs,
    (prefs) => delete prefs.CurrencyPrefs!.HomeCurrency,
    (prefs) => (prefs.CurrencyPrefs!.HomeCurrency = 'USD'),
    ...['US', 'USDX', '12A', '', 'U$D'].map((value) => (prefs: Prefs) => {
      prefs.CurrencyPrefs!.HomeCurrency = { value };
    }),
  ];
  for (const edit of edits) {
    const { result, line, platform } = await readWith(edit);
    assert.deepEqual(result, {
      outcome: 'failed',
      failureReason:
        "QuickBooks did not return this company's home currency, so the bill cannot be checked. Run it again; if it repeats, contact support.",
    });
    assert.equal(line?.[2], 'QuickBooks settings not read (home_currency_missing)');
    assert.equal(platform.steps.length, 3, 'find-account does not run');
  }
  const lower = await readWith((prefs) => (prefs.CurrencyPrefs!.HomeCurrency = { value: ' cad ' }));
  assert.equal((lower.preferences as { homeCurrency: unknown }).homeCurrency, 'CAD');
});

test('WarnDuplicateBillNumber reads true, false or nothing; CustomTxnNumbers only a boolean', async () => {
  const nameValue = (value: unknown) => (prefs: Prefs) => {
    prefs.OtherPrefs!.NameValue = [{ Name: 'WarnDuplicateBillNumber', Value: value }];
  };
  const read = async (edit: (prefs: Prefs) => void) =>
    (await readWith(edit)).preferences as {
      warnDuplicateBillNumber: unknown;
      customTxnNumbers: unknown;
    };
  assert.equal((await read(nameValue('true'))).warnDuplicateBillNumber, true);
  assert.equal((await read(nameValue('false'))).warnDuplicateBillNumber, false);
  assert.equal((await read(nameValue('TRUE'))).warnDuplicateBillNumber, null);
  assert.equal((await read(nameValue(true))).warnDuplicateBillNumber, null);
  assert.equal(
    (await read((prefs) => (prefs.OtherPrefs!.NameValue = []))).warnDuplicateBillNumber,
    null,
  );
  assert.equal((await read((prefs) => delete prefs.OtherPrefs)).warnDuplicateBillNumber, null);
  assert.equal(
    (await read((prefs) => (prefs.SalesFormsPrefs!.CustomTxnNumbers = true))).customTxnNumbers,
    true,
  );
  assert.equal(
    (await read((prefs) => (prefs.SalesFormsPrefs!.CustomTxnNumbers = 'false'))).customTxnNumbers,
    null,
  );
  assert.equal((await read((prefs) => delete prefs.SalesFormsPrefs)).customTxnNumbers, null);
});

test('an answer without a Preferences object, or a body that was not JSON, is unexpected', async () => {
  for (const body of [
    { time: 't' },
    { Preferences: 'x' },
    { error: 'the provider returned a response that is not JSON' },
  ]) {
    const world = setUp();
    world.simulator.script('preferences.get', [{ status: 200, body }]);
    assert.deepEqual(await world.run(), {
      outcome: 'failed',
      failureReason:
        'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
    });
    assert.equal(lines(world.platform)[2]?.[2], 'QuickBooks settings not read (unexpected_answer)');
  }
});

test("earlier state is kept, and a Fault names the step's purpose", async () => {
  const { result } = await readWith();
  assert.ok(result.outcome === 'success');
  assert.ok(result.output?.file && result.output.company, 'receive and read-company state kept');
  const world = setUp();
  world.simulator.script('preferences.get', [
    { status: 400, body: { Fault: { Error: [{ code: '5010' }] } } },
  ]);
  assert.deepEqual(await world.run(), {
    outcome: 'failed',
    failureReason:
      'QuickBooks answered with error 5010 while reading the company settings. Check QuickBooks, then run it again.',
  });
});
