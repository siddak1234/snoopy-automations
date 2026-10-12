import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleAccount } from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';

import { ACCOUNT_SETTINGS, ROLE_TYPES } from '../src/account-settings.js';
import { CATEGORY_SETTINGS } from '../src/spend-types.js';
import {
  CARD_DIGITS_UNREADABLE,
  CARD_SETTING,
  OWNERS_UNREADABLE,
  OWNER_PLACE,
  accountSentence,
  placeOf,
  type AccountReason,
} from '../src/steps/find-accounts.js';
import { failed, find, query } from './accounts-world.js';

/**
 * `find-accounts`, setting by setting: each role held to the kinds it accepts, each
 * failure naming its setting, the first in the manifest's order winning; the owners' own
 * accounts; USD with multicurrency on; empty optional settings never asked for.
 */

const BASE = { expenseAccount: 'Utilities:Electric' };

/** Sets account `id`'s type, adding the account when the company lacks it. */
const typed =
  (id: string, name: string, accountType: string) =>
  (world: { simulator: { company: { accounts: JsonObject[] } } }) => {
    const row = world.simulator.company.accounts.find((account) => account.Id === id);
    if (row) row.AccountType = accountType;
    else world.simulator.company.accounts.push(sampleAccount(id, name, accountType));
  };

test('Paid from is a bank or credit card account; Owed to team members a liability but A/P or a card; the investment account equity', async () => {
  const cases: [string, string, string[], string[]][] = [
    [
      'paidFromAccount',
      'Paid from',
      ['Bank', 'Credit Card'],
      ['Expense', 'Accounts Payable', 'Other Current Asset'],
    ],
    [
      'teamOwedAccount',
      'Owed to team members',
      ['Other Current Liability', 'Long Term Liability'],
      ['Accounts Payable', 'Credit Card', 'Equity', 'Expense'],
    ],
    [
      'ownerInvestmentAccount',
      "Owner's investment account",
      ['Equity'],
      ['Other Current Liability', 'Bank'],
    ],
  ];
  const kinds: Record<string, string> = {
    paidFromAccount: 'a bank or credit card account',
    teamOwedAccount: 'a liability account other than Accounts Payable or a credit card',
    ownerInvestmentAccount: 'an equity account',
  };
  for (const [key, title, good, bad] of cases) {
    for (const accountType of good) {
      const { result } = await find(
        { ...BASE, [key]: 'Spare Account' },
        typed('300', 'Spare Account', accountType),
      );
      assert.equal(result.outcome, 'success', `${key} ${accountType}`);
    }
    for (const accountType of bad) {
      const { result, line } = await find(
        { ...BASE, [key]: 'Spare Account' },
        typed('300', 'Spare Account', accountType),
      );
      assert.deepEqual(
        result,
        failed(
          `The account in the '${title}' setting is not ${kinds[key]} in QuickBooks. Choose one that is, then run it again.`,
        ),
        `${key} ${accountType}`,
      );
      assert.equal(line?.[2], `${title} "Spare Account" not resolved (account_wrong_kind)`);
    }
  }
  assert.deepEqual(ROLE_TYPES, {
    category: ['Expense', 'Other Expense', 'Cost of Goods Sold'],
    paidFrom: ['Bank', 'Credit Card'],
    teamOwed: ['Other Current Liability', 'Long Term Liability'],
    ownerEquity: ['Equity'],
  });
});

test('each category setting is a category, and names itself when it is not one, is missing, inactive or doubled', async () => {
  for (const { key, title } of CATEGORY_SETTINGS) {
    const wrong = await find({ ...BASE, [key]: 'Checking' });
    assert.deepEqual(
      wrong.result,
      failed(
        `The account in the '${title}' setting is not an Expense, Other Expense or Cost of Goods Sold account in QuickBooks. Choose one that is, then run it again.`,
      ),
      key,
    );
  }
  const missing = await find({ ...BASE, categoryTravel: 'Travel' });
  assert.deepEqual(
    missing.result,
    failed(
      "No QuickBooks account matches the 'Category for travel' setting. Type the full name exactly as QuickBooks shows it, capitals included, without its number, then run it again.",
    ),
  );
  const inactive = await find({ ...BASE, categoryMeals: 'Meals' }, (world) => {
    world.simulator.company.accounts.find((row) => row.Id === '66')!.Active = false;
  });
  assert.deepEqual(
    inactive.result,
    failed(
      "The account in the 'Category for meals' setting is inactive in QuickBooks. Make it active or choose another, then run it again.",
    ),
  );
  const doubled = await find({ ...BASE, categoryMeals: 'Meals' }, (world) =>
    world.simulator.company.accounts.push(sampleAccount('67', 'Meals', 'Expense')),
  );
  assert.deepEqual(
    doubled.result,
    failed(
      "Two QuickBooks accounts match the 'Category for meals' setting. Type the full Parent:Child name, or rename one in QuickBooks, then run it again.",
    ),
  );
  const invalid = await find({ ...BASE, categoryRent: 'Rent::Office' });
  assert.deepEqual(
    invalid.result,
    failed(
      "The 'Category for rent' setting is not a QuickBooks account name. Type the full name, such as Utilities:Electric, then run it again.",
    ),
  );
  assert.deepEqual(invalid.sent, [], 'refused before the query');
});

test('an optional setting left empty is never asked for; an empty category setting means the default', async () => {
  const { sent, result } = await find({
    ...BASE,
    paidFromAccount: '',
    teamOwedAccount: '   ',
    categoryMeals: '',
    ownerNames: '',
  });
  assert.deepEqual(sent[0]?.input, { query: query(['Utilities:Electric']) });
  assert.ok(result.outcome === 'success');
  const accounts = result.output?.accounts as JsonObject;
  assert.deepEqual([accounts.paidFrom, accounts.teamOwed, accounts.categories], [null, null, {}]);
});

test("the first setting that fails, in the manifest's order, is the one named", async () => {
  // Paid from comes before the categories, and the categories before the owners' accounts.
  const { result } = await find({
    ...BASE,
    categoryMeals: 'Checking',
    paidFromAccount: 'Meals',
    ownerNames: 'Pat Owner = Nowhere',
  });
  assert.deepEqual(
    result,
    failed(
      "The account in the 'Paid from' setting is not a bank or credit card account in QuickBooks. Choose one that is, then run it again.",
    ),
  );
  const later = await find({
    ...BASE,
    categoryMeals: 'Checking',
    ownerNames: 'Pat Owner = Nowhere',
  });
  assert.match(
    later.result.outcome === 'failed' ? later.result.failureReason : '',
    /'Category for meals'/u,
  );
  assert.deepEqual(ACCOUNT_SETTINGS.map((setting) => setting.key).slice(0, 5), [
    'expenseAccount',
    'paidFromAccount',
    'teamOwedAccount',
    'ownerInvestmentAccount',
    'categoryMeals',
  ]);
});

test("an owner's own account is equity, and its failures name the Owners and partners setting; an unreadable setting fails before the query", async () => {
  const owners = (accountType: string) => typed('126', 'Partner investments:Pat', accountType);
  const ok = await find(
    { ...BASE, ownerNames: 'Pat Owner = Partner investments : Pat' },
    owners('Equity'),
  );
  assert.ok(ok.result.outcome === 'success');
  assert.deepEqual((ok.result.output?.accounts as JsonObject).owners, [
    {
      name: 'Pat Owner',
      account: { id: '126', fullyQualifiedName: 'Partner investments:Pat', accountType: 'Equity' },
    },
  ]);
  const wrong = await find(
    { ...BASE, ownerNames: 'Pat Owner = Partner investments:Pat' },
    owners('Expense'),
  );
  assert.deepEqual(
    wrong.result,
    failed(
      "An account in the 'Owners and partners' setting is not an equity account in QuickBooks. Choose one that is, then run it again.",
    ),
  );
  assert.equal(
    wrong.line?.[2],
    'Owners and partners "Partner investments:Pat" not resolved (account_wrong_kind)',
  );
  const missing = await find({ ...BASE, ownerNames: 'Pat Owner = Partner investments:Pat' });
  assert.deepEqual(
    missing.result,
    failed(
      "No QuickBooks account matches an account in the 'Owners and partners' setting. Type the full name exactly as QuickBooks shows it, capitals included, without its number, then run it again.",
    ),
  );
  for (const setting of ['Pat Owner =', '=Partner investments', 'Pat; pat', 'Pat = A::B']) {
    const unreadable = await find({ ...BASE, ownerNames: setting });
    assert.deepEqual(unreadable.result, failed(OWNERS_UNREADABLE), setting);
    assert.equal(unreadable.line?.[2], 'Owners and partners not read (owners_setting_invalid)');
    assert.deepEqual(unreadable.sent, [], setting);
  }
});

test("'Company card's last four digits' filled in but not four digits fails here, naming the setting, before the query and any read; empty or four digits passes", async () => {
  assert.equal(CARD_SETTING.key, 'companyCardLast4');
  assert.equal(
    CARD_DIGITS_UNREADABLE,
    "The 'Company card's last four digits' setting must be exactly four digits, such as 4417. Fix it in this flow's settings, then run it again. Nothing was created.",
  );
  assert.ok(CARD_DIGITS_UNREADABLE.length <= 200);
  for (const setting of ['Visa 4417', '****4417', '441', '44 17', '44170', '4417-0000-0000-4417']) {
    const typed = await find({ ...BASE, companyCardLast4: setting });
    assert.deepEqual(typed.result, failed(CARD_DIGITS_UNREADABLE), setting);
    assert.equal(
      typed.line?.[2],
      "Company card's last four digits not read (card_digits_setting_invalid)",
      setting,
    );
    assert.deepEqual(typed.sent, [], `${setting}: no QuickBooks call`);
    assert.deepEqual(typed.platform.modelCalls, [], `${setting}: nothing read`);
  }
  for (const setting of ['4417', ' 4417 ', '', '   ', null, undefined]) {
    const fine = await find({
      ...BASE,
      ...(setting === undefined ? {} : { companyCardLast4: setting }),
    });
    assert.equal(fine.result.outcome, 'success', String(setting));
  }
  // Checked before "Owners and partners", after the account settings' own names.
  const both = await find({ ...BASE, companyCardLast4: 'Visa 4417', ownerNames: 'Pat =' });
  assert.deepEqual(both.result, failed(CARD_DIGITS_UNREADABLE));
  const named = await find({ expenseAccount: 'A::B', companyCardLast4: 'Visa 4417' });
  assert.equal(named.line?.[2]?.endsWith('(account_setting_invalid)'), true);
});

test('with multicurrency on, every account must hold USD; with it off, the currency is not read', async () => {
  const multicurrency = (world: Parameters<Parameters<typeof find>[1] & object>[0]) => {
    (world.simulator.company.preferences.CurrencyPrefs as JsonObject).MultiCurrencyEnabled = true;
  };
  const config = { ...BASE, paidFromAccount: 'Company Visa' };
  assert.equal((await find(config, multicurrency)).result.outcome, 'success');
  const canadian = await find(config, (world) => {
    multicurrency(world);
    world.simulator.company.accounts.find((row) => row.Id === '41')!.CurrencyRef = { value: 'CAD' };
  });
  assert.deepEqual(
    canadian.result,
    failed(
      "The account in the 'Paid from' setting is not in USD in QuickBooks, and this automation records USD only. Choose a USD account, then run it again.",
    ),
  );
  assert.equal(canadian.line?.[2], 'Paid from "Company Visa" not resolved (account_not_usd)');
  const lower = await find(config, (world) => {
    multicurrency(world);
    world.simulator.company.accounts.find((row) => row.Id === '41')!.CurrencyRef = {
      value: ' usd ',
    };
  });
  assert.equal(lower.result.outcome, 'success');
  const unsaid = await find(config, (world) => {
    multicurrency(world);
    delete world.simulator.company.accounts.find((row) => row.Id === '41')!.CurrencyRef;
  });
  assert.deepEqual(
    unsaid.result,
    failed(
      'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
    ),
  );
  const off = await find(config, (world) => {
    world.simulator.company.accounts.find((row) => row.Id === '41')!.CurrencyRef = { value: 'CAD' };
  });
  assert.equal(
    off.result.outcome,
    'success',
    'multicurrency off: every account is the home currency',
  );
});

test("a full answer gives no verdict on a name it left out: another setting's duplicates fail, and nothing else passes", async () => {
  const config = { ...BASE, paidFromAccount: 'Company Visa' };
  const visa = (id: string, name: string, active = true) =>
    sampleAccount(id, name, 'Credit Card', { Active: active });
  // Eight rows, the bound for two names in both their forms, all for Paid from: the default
  // category's are crowded out.
  const crowded = await find(config, (world) =>
    world.simulator.script('query.run', [
      {
        status: 200,
        body: {
          QueryResponse: {
            Account: [
              visa('41', 'Company Visa'),
              visa('42', 'Company Visa'),
              ...['43', '44', '45', '46', '47', '48'].map((id) =>
                visa(id, 'Company Visa (deleted)', false),
              ),
            ],
          },
        },
      },
    ]),
  );
  assert.deepEqual(
    crowded.result,
    failed(
      "Two QuickBooks accounts match the 'Paid from' setting. Type the full Parent:Child name, or rename one in QuickBooks, then run it again.",
    ),
  );
  const unrelated = await find(config, (world) =>
    world.simulator.script('query.run', [
      {
        status: 200,
        body: {
          QueryResponse: {
            Account: ['1', '2', '3', '4', '5', '6', '7', '8'].map((id) => visa(id, `Other ${id}`)),
          },
        },
      },
    ]),
  );
  assert.deepEqual(
    unrelated.result,
    failed(
      'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
    ),
  );
});

test('every A1 sentence names its setting, fits 200 characters, and never carries the value typed', () => {
  const reasons: AccountReason[] = [
    'account_setting_missing',
    'account_setting_invalid',
    'account_not_found',
    'account_not_found_number',
    'account_ambiguous',
    'account_inactive',
    'account_wrong_kind',
    'account_not_usd',
  ];
  for (const setting of ACCOUNT_SETTINGS) {
    for (const reason of reasons) {
      const sentence = accountSentence(reason, placeOf(setting.title), setting.role);
      assert.ok(sentence.length <= 200, `${setting.key} ${reason}: ${sentence.length}`);
      assert.ok(sentence.includes(`'${setting.title}'`), `${setting.key} ${reason}`);
    }
  }
  for (const reason of reasons) {
    const sentence = accountSentence(reason, OWNER_PLACE, 'ownerEquity');
    assert.ok(sentence.length <= 200 && sentence.includes("'Owners and partners'"), reason);
  }
  assert.ok(OWNERS_UNREADABLE.length <= 200);
});
