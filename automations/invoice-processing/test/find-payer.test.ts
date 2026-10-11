import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FAULT_MARKER,
  faultAnswer,
  sampleAccount,
  sampleEmployee,
} from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';

import { FIND_PAYER_SENTENCES } from '../src/steps/find-payer.js';
import { FILE_ID, callsOf, everythingSaid, lines, setUp } from './fixtures.js';

/**
 * `find-payer`: who paid, when someone paid with their own money — the switch and the name
 * (P0, P1), an owner from the settings with no QuickBooks call (P4), else one Employee
 * lookup by display name (P2, P3), else a name passed on to be looked for among vendors —
 * all before the document is read, whatever it turns out to be.
 */

const SETTINGS = {
  expenseAccount: 'Utilities:Electric',
  teamOwedAccount: 'Owed to Team Members',
  ownerInvestmentAccount: 'Owner investments',
  ownerNames: 'Pat Owner; Sam Partner = Owner investments',
};

const employeeQuery = (name: string) =>
  `SELECT * FROM Employee WHERE DisplayName = '${name}' AND Active IN (true, false) MAXRESULTS 2`;

async function paid(
  input: JsonObject,
  config: JsonObject = SETTINGS,
  edit: (world: ReturnType<typeof setUp>) => void = () => undefined,
) {
  const world = setUp({ config, input: { invoiceFile: FILE_ID, ...input } });
  edit(world);
  const result = await world.run();
  const line = lines(world.platform).find(([stepId]) => stepId === 'find-payer');
  const sent = callsOf(world.platform, world.request, 'find-payer');
  const payer = result.outcome === 'success' ? result.output?.payer : undefined;
  return { ...world, result, line, sent, payer };
}

const failed = (reason: keyof typeof FIND_PAYER_SENTENCES) => ({
  outcome: 'failed',
  failureReason: FIND_PAYER_SENTENCES[reason],
});

const OWED = {
  id: '120',
  fullyQualifiedName: 'Owed to Team Members',
  accountType: 'Other Current Liability',
};
const INVESTED = { id: '125', fullyQualifiedName: 'Owner investments', accountType: 'Equity' };

test('the switch off and no name: skipped, no line, no call, no payer — the company paid', async () => {
  for (const input of [
    {},
    { paidPersonally: false },
    { paidBy: '   ' },
    { paidBy: '\u200b' },
    { paidBy: 7 },
  ]) {
    const { result, line, sent, payer, platform } = await paid(input);
    assert.equal(result.outcome, 'success', JSON.stringify(input));
    assert.equal(line, undefined);
    assert.deepEqual(sent, []);
    assert.equal(payer, undefined);
    assert.equal(platform.modelCalls.length, 2, 'both reads');
  }
});

test('P0, P1 and the length bound fail before any call or model read, whatever the document is', async () => {
  const cases: [JsonObject, keyof typeof FIND_PAYER_SENTENCES][] = [
    [{ paidBy: 'Robin Example' }, 'paid_by_without_switch'],
    [{ paidPersonally: false, paidBy: 'Robin Example' }, 'paid_by_without_switch'],
    [{ paidPersonally: 'true', paidBy: 'Robin Example' }, 'paid_by_without_switch'],
    [{ paidPersonally: true }, 'paid_by_missing'],
    [{ paidPersonally: true, paidBy: ' \n\t ' }, 'paid_by_missing'],
    [{ paidPersonally: true, paidBy: 'A'.repeat(501) }, 'paid_by_too_long'],
  ];
  for (const [input, reason] of cases) {
    const { result, line, sent, platform } = await paid(input);
    assert.deepEqual(result, failed(reason), JSON.stringify(input).slice(0, 60));
    assert.deepEqual(line, ['find-payer', 'failed', `Who paid not accepted (${reason})`]);
    assert.deepEqual(sent, []);
    assert.deepEqual(platform.modelCalls, [], 'no model call');
  }
  // 500 characters is a name QuickBooks could hold: looked up.
  const longest = await paid({ paidPersonally: true, paidBy: 'A'.repeat(500) });
  assert.equal(longest.sent.length, 1);
});

test('an owner from the settings: no QuickBooks call, their own account or else the shared one; they win over an employee of the same name', async () => {
  const shared = await paid({ paidPersonally: true, paidBy: '  pat   OWNER ' });
  assert.deepEqual(shared.sent, []);
  assert.deepEqual(shared.payer, {
    route: 'owner',
    name: 'Pat Owner',
    employeeId: null,
    account: INVESTED,
  });
  assert.deepEqual(shared.line, [
    'find-payer',
    'ok',
    "Who paid: Pat Owner, an owner in this flow's settings (account Owner investments)",
  ]);
  const own = await paid(
    { paidPersonally: true, paidBy: 'Sam Partner' },
    { ...SETTINGS, ownerInvestmentAccount: '' },
  );
  assert.deepEqual(own.payer, {
    route: 'owner',
    name: 'Sam Partner',
    employeeId: null,
    account: INVESTED,
  });
  // Their own account wins over the shared one when both are set.
  const theirs = await paid(
    { paidPersonally: true, paidBy: 'Sam Partner' },
    { ...SETTINGS, ownerNames: 'Pat Owner; Sam Partner = Partner investments:Sam' },
    (world) =>
      world.simulator.company.accounts.push(
        sampleAccount('127', 'Partner investments:Sam', 'Equity', { Classification: 'Equity' }),
      ),
  );
  assert.deepEqual((theirs.payer as JsonObject).account, {
    id: '127',
    fullyQualifiedName: 'Partner investments:Sam',
    accountType: 'Equity',
  });
  const both = await paid({ paidPersonally: true, paidBy: 'Pat Owner' }, SETTINGS, (world) =>
    world.simulator.company.employees.push(sampleEmployee('60', 'Pat Owner')),
  );
  assert.equal((both.payer as JsonObject).route, 'owner');
  assert.deepEqual(both.sent, [], 'the owner is found first, with no lookup');
});

test('P4: an owner with no account of their own, and no Owner’s investment account', async () => {
  const { result, sent, platform } = await paid(
    { paidPersonally: true, paidBy: 'Pat Owner' },
    { ...SETTINGS, ownerInvestmentAccount: '' },
  );
  assert.deepEqual(result, failed('owner_account_missing'));
  assert.deepEqual([sent, platform.modelCalls], [[], []]);
});

test('an employee: one lookup by display name, re-checked after cleaning; active, and Owed to team members set', async () => {
  const { payer, sent, line } = await paid({ paidPersonally: true, paidBy: 'Robin\u00a0EXAMPLE' });
  assert.deepEqual(sent, [
    {
      providerId: 'quickbooks',
      operation: 'query.run',
      input: { query: employeeQuery('Robin EXAMPLE') },
    },
  ]);
  assert.deepEqual(payer, {
    route: 'employee',
    name: 'Robin Example',
    employeeId: '55',
    account: OWED,
  });
  assert.deepEqual(line, [
    'find-payer',
    'ok',
    'Who paid: Robin Example, an employee in QuickBooks (Id 55)',
  ]);
  const apostrophe = await paid({ paidPersonally: true, paidBy: 'Jo O’Neil' }, SETTINGS, (world) =>
    world.simulator.company.employees.push(sampleEmployee('61', "Jo O'Neil")),
  );
  assert.deepEqual(apostrophe.sent[0]?.input, { query: employeeQuery("Jo O\\'Neil") });
  assert.equal((apostrophe.payer as JsonObject).employeeId, '61');
});

test('P2 an inactive employee; P3 Owed to team members not set; two employees by one name', async () => {
  const inactive = await paid(
    { paidPersonally: true, paidBy: 'Robin Example' },
    SETTINGS,
    (world) => {
      world.simulator.company.employees[0]!.Active = false;
    },
  );
  assert.deepEqual(inactive.result, failed('payer_inactive'));
  assert.deepEqual(inactive.platform.modelCalls, []);
  // An inactive employee fails first, whether or not the account is set.
  const both = await paid(
    { paidPersonally: true, paidBy: 'Robin Example' },
    { ...SETTINGS, teamOwedAccount: '' },
    (world) => {
      world.simulator.company.employees[0]!.Active = false;
    },
  );
  assert.deepEqual(both.result, failed('payer_inactive'));
  const unset = await paid(
    { paidPersonally: true, paidBy: 'Robin Example' },
    { ...SETTINGS, teamOwedAccount: '' },
  );
  assert.deepEqual(unset.result, failed('team_owed_account_missing'));
  const twice = await paid({ paidPersonally: true, paidBy: 'Robin Example' }, SETTINGS, (world) =>
    world.simulator.company.employees.push(sampleEmployee('62', 'ROBIN EXAMPLE')),
  );
  assert.deepEqual(twice.result, failed('payer_ambiguous'));
});

test('a name that is no owner and no employee is passed on, to be looked for among vendors; a returned name that differs is no match', async () => {
  const { payer, line, result } = await paid({ paidPersonally: true, paidBy: 'Lee Contractor' });
  assert.equal(result.outcome, 'success');
  assert.deepEqual(payer, {
    route: 'not_employee',
    name: 'Lee Contractor',
    employeeId: null,
    account: null,
  });
  assert.deepEqual(line, [
    'find-payer',
    'ok',
    'Who paid: Lee Contractor, not an employee in QuickBooks; to be looked for among vendors',
  ]);
  const near = await paid({ paidPersonally: true, paidBy: 'Robin Example' }, SETTINGS, (world) =>
    world.simulator.script('query.run', [
      { status: 200 },
      {
        status: 200,
        body: { QueryResponse: { Employee: [sampleEmployee('55', 'Robin Example Jr')] } },
      },
    ]),
  );
  assert.equal((near.payer as JsonObject).route, 'not_employee');
});

test('a Fault on the lookup fails by its number; its text, and the name typed, never reach the reason', async () => {
  const { result, line, platform } = await paid(
    { paidPersonally: true, paidBy: 'Robin Example' },
    SETTINGS,
    (world) =>
      world.simulator.script('query.run', [
        { status: 200 },
        { status: 400, body: faultAnswer('4000') },
      ]),
  );
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason:
      "QuickBooks answered with error 4000 while looking up the name in 'Who paid'. Remove unusual characters from it, then run it again.",
  });
  assert.deepEqual(line, ['find-payer', 'failed', 'Who paid not accepted (qb_error 4000)']);
  assert.ok(!everythingSaid(platform, result).includes(FAULT_MARKER));
  const unexpected = await paid(
    { paidPersonally: true, paidBy: 'Robin Example' },
    SETTINGS,
    (world) => {
      delete world.simulator.company.employees[0]!.Id;
    },
  );
  assert.deepEqual(unexpected.result, {
    outcome: 'failed',
    failureReason:
      'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
  });
  for (const reason of Object.keys(FIND_PAYER_SENTENCES) as (keyof typeof FIND_PAYER_SENTENCES)[]) {
    const sentence = FIND_PAYER_SENTENCES[reason];
    assert.ok(sentence.length <= 200, reason);
    assert.ok(sentence.endsWith(' Nothing was created.'), reason);
  }
});
