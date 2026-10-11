import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAULT_MARKER, faultAnswer, sampleAccount } from '@autom8x/automation-kit/testing';

import { callsOf, everythingSaid, lines, setUp } from './fixtures.js';

/**
 * `find-account`: one `query.run` turns the Expense account setting into exactly one
 * active Expense account, or a sentence naming the setting — before any model call.
 */

const query = (name: string) =>
  `SELECT * FROM Account WHERE FullyQualifiedName = '${name}' AND Active IN (true, false) MAXRESULTS 2`;

async function find(
  setting: unknown,
  edit: (world: ReturnType<typeof setUp>) => void = () => undefined,
) {
  const world = setUp({ config: setting === undefined ? {} : { expenseAccount: setting } });
  edit(world);
  const result = await world.run();
  const line = lines(world.platform).find(([stepId]) => stepId === 'find-account');
  const sent = callsOf(world.platform, world.request, 'find-account');
  return { ...world, result, line, sent };
}

const failed = (failureReason: string) => ({ outcome: 'failed', failureReason });

test('the exact lookup text is sent, and the run continues with the account Id', async () => {
  const { result, line, sent } = await find('Utilities:Electric');
  assert.deepEqual(sent, [
    {
      providerId: 'quickbooks',
      operation: 'query.run',
      input: { query: query('Utilities:Electric') },
    },
  ]);
  assert.deepEqual(line, [
    'find-account',
    'ok',
    'Expense account: Utilities:Electric (QuickBooks Id 57)',
  ]);
  assert.ok(result.outcome === 'success');
  assert.deepEqual(result.output?.account, { id: '57', fullyQualifiedName: 'Utilities:Electric' });
});

test('spaces around the colons go; case does not matter, and the name is kept as QuickBooks spells it', async () => {
  const spaced = await find('  Utilities : Electric ');
  assert.deepEqual(spaced.sent[0]?.input, { query: query('Utilities:Electric') });
  assert.equal(spaced.result.outcome, 'success');
  const lower = await find('utilities:electric');
  assert.ok(lower.result.outcome === 'success');
  assert.deepEqual(lower.result.output?.account, {
    id: '57',
    fullyQualifiedName: 'Utilities:Electric',
  });
});

test('an apostrophe is escaped and a backslash doubled in the text sent', async () => {
  const add = (name: string) => (world: ReturnType<typeof setUp>) =>
    world.simulator.company.accounts.push(sampleAccount('70', name, 'Expense'));
  const apostrophes = await find("Legal:O'Brien's Fees", add("Legal:O'Brien's Fees"));
  assert.deepEqual(apostrophes.sent[0]?.input, { query: query("Legal:O\\'Brien\\'s Fees") });
  assert.equal(apostrophes.result.outcome, 'success');
  const backslash = await find('Fees\\Misc', add('Fees\\Misc'));
  assert.deepEqual(backslash.sent[0]?.input, { query: query('Fees\\\\Misc') });
  assert.equal(backslash.result.outcome, 'success');
});

test('no match fails as not found; an account number typed in front gets the hint', async () => {
  const missing = await find('Utilities:Gas');
  assert.deepEqual(
    missing.result,
    failed(
      'No QuickBooks account matches the Expense account setting. Type the full name as QuickBooks shows it, without its number, then run it again.',
    ),
  );
  assert.equal(
    missing.line?.[2],
    'Expense account "Utilities:Gas" not resolved (account_not_found)',
  );
  const numbered = await find('6100 Utilities:Electric');
  assert.deepEqual(
    numbered.result,
    failed(
      'No QuickBooks account matches the Expense account setting. Type the name without the account number in front, then run it again.',
    ),
  );
  assert.equal(
    numbered.line?.[2],
    'Expense account "6100 Utilities:Electric" not resolved (account_not_found_number)',
  );
});

test('two matches fail as ambiguous, an inactive account as inactive', async () => {
  const two = await find('Utilities:Electric', (world) =>
    world.simulator.company.accounts.push(
      sampleAccount('58', 'UTILITIES:ELECTRIC', 'Expense', { Active: false }),
    ),
  );
  assert.deepEqual(
    two.result,
    failed(
      'Two QuickBooks accounts match the Expense account setting. Type the full Parent:Child name, or rename one in QuickBooks, then run it again.',
    ),
  );
  const inactive = await find('Office Supplies', (world) => {
    world.simulator.company.accounts.find((row) => row.Id === '64')!.Active = false;
  });
  assert.deepEqual(
    inactive.result,
    failed(
      'The account in the Expense account setting is inactive in QuickBooks. Make it active or choose another, then run it again.',
    ),
  );
  // A row with no Active field is Intuit's default: active.
  const unmarked = await find('Office Supplies', (world) => {
    delete world.simulator.company.accounts.find((row) => row.Id === '64')!.Active;
  });
  assert.equal(unmarked.result.outcome, 'success');
});

test('an account that is not of type Expense fails', async () => {
  for (const accountType of ['Cost of Goods Sold', 'Other Expense', 'Bank', 'expense']) {
    const { result, line } = await find('Office Supplies', (world) => {
      world.simulator.company.accounts.find((row) => row.Id === '64')!.AccountType = accountType;
    });
    assert.deepEqual(
      result,
      failed(
        'The account in the Expense account setting is not an Expense account in QuickBooks. Choose an Expense account, then run it again.',
      ),
      accountType,
    );
    assert.equal(line?.[2], 'Expense account "Office Supplies" not resolved (account_not_expense)');
  }
});

test('a returned name that differs beyond case is no match', async () => {
  const { result } = await find('Utilities:Electric', (world) =>
    world.simulator.script('query.run', [
      {
        status: 200,
        body: {
          QueryResponse: { Account: [sampleAccount('57', 'Utilities:Electric2', 'Expense')] },
        },
      },
    ]),
  );
  assert.deepEqual(
    result,
    failed(
      'No QuickBooks account matches the Expense account setting. Type the full name as QuickBooks shows it, without its number, then run it again.',
    ),
  );
});

test('a setting that is missing, blank, not text or has an empty part fails without any call', async () => {
  const unset = failed("Set the Expense account in this flow's settings, then run it again.");
  for (const setting of [undefined, '', '   ', 42, null]) {
    const { result, line, sent } = await find(setting);
    assert.deepEqual(result, unset, String(setting));
    assert.equal(line?.[2], 'Expense account not set (account_setting_missing)');
    assert.deepEqual(sent, []);
  }
  const invalid = failed(
    'The Expense account setting is not a QuickBooks account name. Type the full name, such as Utilities:Electric, then run it again.',
  );
  for (const setting of [
    'Utilities:',
    ':Electric',
    'Utilities::Electric',
    'Utilities: :Electric',
  ]) {
    const { result, sent } = await find(setting);
    assert.deepEqual(result, invalid, setting);
    assert.deepEqual(sent, []);
  }
});

test('a setting over 1,000 characters fails without any call; 1,000 is looked up', async () => {
  const over = await find('A'.repeat(1_001));
  assert.deepEqual(
    over.result,
    failed(
      'The Expense account setting is not a QuickBooks account name. Type the full name, such as Utilities:Electric, then run it again.',
    ),
  );
  assert.deepEqual(over.sent, []);
  assert.equal(
    over.line?.[2],
    `Expense account "${'A'.repeat(80)}" not resolved (account_setting_invalid)`,
  );
  const exact = await find('A'.repeat(1_000));
  assert.equal(exact.sent.length, 1);
});

test('a query Fault fails by its number with the unusual-characters hint; its text appears nowhere', async () => {
  const { result, line, platform } = await find('Repairs & Maintenance', (world) =>
    world.simulator.script('query.run', [{ status: 400, body: faultAnswer('4000') }]),
  );
  assert.deepEqual(
    result,
    failed(
      'QuickBooks answered with error 4000 while looking up the Expense account setting. Remove unusual characters from it, then run it again.',
    ),
  );
  assert.equal(line?.[2], 'Expense account "Repairs & Maintenance" not resolved (qb_error 4000)');
  assert.ok(!everythingSaid(platform, result).includes(FAULT_MARKER));
  // The typed value may be in the timeline line, never in the run's reason.
  assert.ok(result.outcome === 'failed' && !result.failureReason.includes('Repairs'));
});

test('no QueryResponse, or a matched row without an Id, is an unexpected answer', async () => {
  const unexpected = failed(
    'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
  );
  const noResponse = await find('Utilities:Electric', (world) =>
    world.simulator.script('query.run', [{ status: 200, body: { Account: [] } }]),
  );
  assert.deepEqual(noResponse.result, unexpected);
  for (const id of [undefined, '', 57]) {
    const { result } = await find('Utilities:Electric', (world) => {
      const row = world.simulator.company.accounts.find((account) => account.Id === '57')!;
      if (id === undefined) delete row.Id;
      else row.Id = id;
    });
    assert.deepEqual(result, unexpected, String(id));
  }
});
