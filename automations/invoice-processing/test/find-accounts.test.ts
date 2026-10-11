import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAULT_MARKER, faultAnswer, sampleAccount } from '@autom8x/automation-kit/testing';

import { find, failed, only, query } from './accounts-world.js';
import { everythingSaid, type setUp } from './fixtures.js';

/**
 * `find-accounts`: one `query.run` — `FullyQualifiedName IN (…)` — turns every account the
 * flow's settings name into one QuickBooks account each, or ends the run with find-account's
 * sentence naming the setting (A1), before any model call. The default category's cases
 * here; each role's, the owners' and multicurrency's in `find-accounts-roles.test.ts`.
 */

test('the default category alone: the exact IN text is sent, and the run continues with the account', async () => {
  const { result, line, sent, platform } = await find(only('Utilities:Electric'));
  assert.deepEqual(sent, [
    {
      providerId: 'quickbooks',
      operation: 'query.run',
      input: { query: query(['Utilities:Electric']) },
    },
  ]);
  assert.deepEqual(line, [
    'find-accounts',
    'ok',
    'Default category: Utilities:Electric (QuickBooks Id 57)',
  ]);
  assert.ok(result.outcome === 'success');
  assert.deepEqual(result.output?.accounts, {
    defaultCategory: { id: '57', fullyQualifiedName: 'Utilities:Electric', accountType: 'Expense' },
    categories: {},
    paidFrom: null,
    teamOwed: null,
    ownerInvestment: null,
    owners: [],
  });
  assert.equal(platform.modelCalls.length, 2, 'both reads');
});

test('every account setting in one query, each name once, two rows a name; each kept by its role', async () => {
  const config = {
    expenseAccount: 'Utilities:Electric',
    paidFromAccount: 'Company Visa',
    teamOwedAccount: 'Owed to Team Members',
    ownerInvestmentAccount: 'Owner investments',
    ownerNames: 'Pat Owner = Partner investments:Pat; Sam Partner',
    categoryMeals: 'Meals',
    categoryOfficeSupplies: 'OFFICE SUPPLIES',
    categoryMaterials: 'Cost of Goods Sold',
    // The same account as another setting is asked for once.
    categoryUtilitiesAndPhone: 'utilities:electric',
  };
  const { result, line, sent } = await find(config, (world) =>
    world.simulator.company.accounts.push(
      sampleAccount('126', 'Partner investments:Pat', 'Equity', { Classification: 'Equity' }),
    ),
  );
  assert.deepEqual(sent, [
    {
      providerId: 'quickbooks',
      operation: 'query.run',
      input: {
        query: query([
          'Utilities:Electric',
          'Company Visa',
          'Owed to Team Members',
          'Owner investments',
          'Meals',
          'OFFICE SUPPLIES',
          'Cost of Goods Sold',
          'Partner investments:Pat',
        ]),
      },
    },
  ]);
  assert.deepEqual(line, [
    'find-accounts',
    'ok',
    'Default category: Utilities:Electric (QuickBooks Id 57); 8 more accounts found',
  ]);
  assert.ok(result.outcome === 'success');
  const ref = (id: string, name: string, type: string) => ({
    id,
    fullyQualifiedName: name,
    accountType: type,
  });
  assert.deepEqual(result.output?.accounts, {
    defaultCategory: ref('57', 'Utilities:Electric', 'Expense'),
    categories: {
      meals: ref('66', 'Meals', 'Expense'),
      office_supplies: ref('64', 'Office Supplies', 'Expense'),
      utilities_and_phone: ref('57', 'Utilities:Electric', 'Expense'),
      materials: ref('80', 'Cost of Goods Sold', 'Cost of Goods Sold'),
    },
    paidFrom: ref('41', 'Company Visa', 'Credit Card'),
    teamOwed: ref('120', 'Owed to Team Members', 'Other Current Liability'),
    ownerInvestment: ref('125', 'Owner investments', 'Equity'),
    owners: [
      { name: 'Pat Owner', account: ref('126', 'Partner investments:Pat', 'Equity') },
      { name: 'Sam Partner', account: null },
    ],
  });
});

test('spaces around the colons go; case does not matter, and the name is kept as QuickBooks spells it', async () => {
  const spaced = await find(only('  Utilities : Electric '));
  assert.deepEqual(spaced.sent[0]?.input, { query: query(['Utilities:Electric']) });
  assert.equal(spaced.result.outcome, 'success');
  const lower = await find(only('utilities:electric'));
  assert.ok(lower.result.outcome === 'success');
  assert.equal(
    (lower.result.output?.accounts as { defaultCategory: { fullyQualifiedName: string } })
      .defaultCategory.fullyQualifiedName,
    'Utilities:Electric',
  );
});

test('an apostrophe is escaped and a backslash doubled in the text sent', async () => {
  const add = (name: string) => (world: ReturnType<typeof setUp>) =>
    world.simulator.company.accounts.push(sampleAccount('70', name, 'Expense'));
  const apostrophes = await find(only("Legal:O'Brien's Fees"), add("Legal:O'Brien's Fees"));
  assert.deepEqual(apostrophes.sent[0]?.input, { query: query(["Legal:O\\'Brien\\'s Fees"]) });
  assert.equal(apostrophes.result.outcome, 'success');
  const backslash = await find(only('Fees\\Misc'), add('Fees\\Misc'));
  assert.deepEqual(backslash.sent[0]?.input, { query: query(['Fees\\\\Misc']) });
  assert.equal(backslash.result.outcome, 'success');
});

test('no match fails as not found; an account number typed in front gets the hint', async () => {
  const missing = await find(only('Utilities:Gas'));
  assert.deepEqual(
    missing.result,
    failed(
      "No QuickBooks account matches the 'Default category' setting. Type the full name as QuickBooks shows it, without its number, then run it again.",
    ),
  );
  assert.equal(
    missing.line?.[2],
    'Default category "Utilities:Gas" not resolved (account_not_found)',
  );
  assert.deepEqual(missing.platform.modelCalls, [], 'before any model call');
  const numbered = await find(only('6100 Utilities:Electric'));
  assert.deepEqual(
    numbered.result,
    failed(
      "No QuickBooks account matches the 'Default category' setting. Type the name without the account number in front, then run it again.",
    ),
  );
  assert.equal(
    numbered.line?.[2],
    'Default category "6100 Utilities:Electric" not resolved (account_not_found_number)',
  );
});

test('two matches fail as ambiguous, an inactive account as inactive', async () => {
  const two = await find(only('Utilities:Electric'), (world) =>
    world.simulator.company.accounts.push(
      sampleAccount('58', 'UTILITIES:ELECTRIC', 'Expense', { Active: false }),
    ),
  );
  assert.deepEqual(
    two.result,
    failed(
      "Two QuickBooks accounts match the 'Default category' setting. Type the full Parent:Child name, or rename one in QuickBooks, then run it again.",
    ),
  );
  const inactive = await find(only('Office Supplies'), (world) => {
    world.simulator.company.accounts.find((row) => row.Id === '64')!.Active = false;
  });
  assert.deepEqual(
    inactive.result,
    failed(
      "The account in the 'Default category' setting is inactive in QuickBooks. Make it active or choose another, then run it again.",
    ),
  );
  // A row with no Active field is Intuit's default: active.
  const unmarked = await find(only('Office Supplies'), (world) => {
    delete world.simulator.company.accounts.find((row) => row.Id === '64')!.Active;
  });
  assert.equal(unmarked.result.outcome, 'success');
});

test('a category may be an Expense, Other Expense or Cost of Goods Sold account; anything else fails as the wrong kind', async () => {
  for (const accountType of ['Expense', 'Other Expense', 'Cost of Goods Sold']) {
    const { result } = await find(only('Office Supplies'), (world) => {
      world.simulator.company.accounts.find((row) => row.Id === '64')!.AccountType = accountType;
    });
    assert.equal(result.outcome, 'success', accountType);
  }
  for (const accountType of ['Bank', 'Equity', 'expense', 'Income', 'Other Current Liability']) {
    const { result, line } = await find(only('Office Supplies'), (world) => {
      world.simulator.company.accounts.find((row) => row.Id === '64')!.AccountType = accountType;
    });
    assert.deepEqual(
      result,
      failed(
        "The account in the 'Default category' setting is not an Expense, Other Expense or Cost of Goods Sold account in QuickBooks. Choose one that is, then run it again.",
      ),
      accountType,
    );
    assert.equal(line?.[2], 'Default category "Office Supplies" not resolved (account_wrong_kind)');
  }
  const untyped = await find(only('Office Supplies'), (world) => {
    delete world.simulator.company.accounts.find((row) => row.Id === '64')!.AccountType;
  });
  assert.equal(
    untyped.line?.[2],
    'Default category "Office Supplies" not resolved (account_wrong_kind)',
  );
});

test('a returned name that differs beyond case is no match', async () => {
  const { result } = await find(only('Utilities:Electric'), (world) =>
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
      "No QuickBooks account matches the 'Default category' setting. Type the full name as QuickBooks shows it, without its number, then run it again.",
    ),
  );
});

test('a default category missing, blank or not text fails without any call; one with an empty part, or over 1,000 characters, too', async () => {
  const unset = failed("Set 'Default category' in this flow's settings, then run it again.");
  for (const setting of [undefined, '', '   ', 42, null]) {
    const { result, line, sent } = await find(only(setting));
    assert.deepEqual(result, unset, String(setting));
    assert.equal(line?.[2], 'Default category not set (account_setting_missing)');
    assert.deepEqual(sent, []);
  }
  const invalid = failed(
    "The 'Default category' setting is not a QuickBooks account name. Type the full name, such as Utilities:Electric, then run it again.",
  );
  for (const setting of [
    'Utilities:',
    ':Electric',
    'Utilities::Electric',
    'Utilities: :Electric',
    'A'.repeat(1_001),
  ]) {
    const { result, sent } = await find(only(setting));
    assert.deepEqual(result, invalid, setting.slice(0, 20));
    assert.deepEqual(sent, []);
  }
  const over = await find(only('A'.repeat(1_001)));
  assert.equal(
    over.line?.[2],
    `Default category "${'A'.repeat(80)}" not resolved (account_setting_invalid)`,
  );
  const exact = await find(only('A'.repeat(1_000)));
  assert.equal(exact.sent.length, 1);
});

test('a query Fault fails by its number with the unusual-characters hint; its text appears nowhere', async () => {
  const { result, line, platform } = await find(only('Repairs & Maintenance'), (world) =>
    world.simulator.script('query.run', [{ status: 400, body: faultAnswer('4000') }]),
  );
  assert.deepEqual(
    result,
    failed(
      "QuickBooks answered with error 4000 while looking up the accounts in this flow's settings. Remove unusual characters from them, then run it again.",
    ),
  );
  assert.equal(
    line?.[2],
    "The accounts in this flow's settings were not looked up (qb_error 4000)",
  );
  assert.ok(!everythingSaid(platform, result).includes(FAULT_MARKER));
  // The typed value may be in a timeline line, never in the run's reason.
  assert.ok(result.outcome === 'failed' && !result.failureReason.includes('Repairs'));
});

test('no QueryResponse, or a matched row without an Id, is an unexpected answer', async () => {
  const unexpected = failed(
    'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
  );
  const noResponse = await find(only('Utilities:Electric'), (world) =>
    world.simulator.script('query.run', [{ status: 200, body: { Account: [] } }]),
  );
  assert.deepEqual(noResponse.result, unexpected);
  for (const id of [undefined, '', 57]) {
    const { result, line } = await find(only('Utilities:Electric'), (world) => {
      const row = world.simulator.company.accounts.find((account) => account.Id === '57')!;
      if (id === undefined) delete row.Id;
      else row.Id = id;
    });
    assert.deepEqual(result, unexpected, String(id));
    assert.equal(
      line?.[2],
      "The accounts in this flow's settings were not looked up (unexpected_answer)",
    );
  }
});
