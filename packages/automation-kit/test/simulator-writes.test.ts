import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, ProviderRequest } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { lookupQuery, transactionQuery } from '../src/quickbooks/query.js';
import {
  sampleCustomer,
  sampleEmployee,
  samplePurchase,
  sampleVendor,
} from '../src/testing/quickbooks-company.js';
import {
  QuickBooksSimulator,
  REFUSED_BODY_FIELDS,
  refusedFieldOf,
} from '../src/testing/quickbooks-simulator.js';

/**
 * The simulator's writes: a create that names the record it would update is refused as the
 * platform refuses it (its BUILD-PLAN 25.2.33, `4807959`), before anything is written; a vendor and
 * a bill created by Intuit's documented rules and found by the kit's queries; and an answer lost
 * after QuickBooks acted.
 */

let keys = 0;
function call(operation: string, input: JsonObject, key?: string): ProviderRequest {
  keys += 1;
  return {
    providerId: 'quickbooks',
    operation,
    input,
    idempotencyKey: key ?? `writes-${String(keys).padStart(4, '0')}-${'a'.repeat(40)}`,
  };
}

function simulator() {
  const sim = new QuickBooksSimulator({ refusal: refusalFixture });
  sim.company.vendors.push(
    sampleVendor('7', 'Harrowgate Office Supply'),
    sampleVendor('8', 'Closed Supplier', { Active: false }),
  );
  return sim;
}

const line = (amount: number, account = '64') => ({
  DetailType: 'AccountBasedExpenseLineDetail',
  Amount: amount,
  AccountBasedExpenseLineDetail: { AccountRef: { value: account } },
});
const BILL: JsonObject = {
  VendorRef: { value: '7' },
  TxnDate: '2026-09-14',
  Line: [line(400), line(13.34)],
};

/** Every create the platform declares, each with a body the made-up company would accept. */
const WRITES: readonly [string, JsonObject][] = [
  ['vendor.create', { DisplayName: 'Larkspur Paper Co.' }],
  ['bill.create', BILL],
  ['purchase.create', { PaymentType: 'Cash', AccountRef: { value: '35' }, Line: [line(10)] }],
  ['vendorCredit.create', { VendorRef: { value: '7' }, Line: [line(10)] }],
  [
    'journalEntry.create',
    {
      Line: [
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 5,
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '64' } },
        },
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: 5,
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '120' } },
        },
      ],
    },
  ],
];

async function faultOf(sim: QuickBooksSimulator, operation: string, input: JsonObject) {
  const answer = await sim.provider(call(operation, input));
  const body = answer.body as { Fault?: { Error: { code: string }[] } };
  return [answer.status, body.Fault?.Error[0]?.code];
}

const held = (sim: QuickBooksSimulator) =>
  sim.company.vendors.length +
  sim.company.bills.length +
  sim.company.purchases.length +
  sim.company.vendorCredits.length +
  sim.company.journalEntries.length;

test('a write naming Id, SyncToken or sparse at the top level, in any case, is refused 400 refused_field: nothing written, nothing recorded', async () => {
  assert.deepEqual(REFUSED_BODY_FIELDS, ['Id', 'SyncToken', 'sparse']);
  const spellings = ['Id', 'id', 'ID', 'SyncToken', 'synctoken', 'SYNCTOKEN', 'sparse', 'Sparse'];
  for (const [operation, input] of WRITES) {
    for (const field of spellings) {
      const sim = simulator();
      const before = held(sim);
      const key = `refused-${field}-${'b'.repeat(40)}`;
      await assert.rejects(sim.provider(call(operation, { ...input, [field]: '1' }, key)), {
        status: 400,
        reason: 'refused_field',
      });
      assert.equal(held(sim), before, `${operation} ${field}: nothing written`);
      assert.deepEqual(
        sim.calls.map((entry) => [entry.outcome, entry.status]),
        [['refused', 400]],
      );
      assert.equal(refusedFieldOf(operation, { ...input, [field]: '1' }), field);
      // Nothing was recorded under the key: the same key with a body that names no record is answered.
      const answer = await sim.provider(call(operation, input, key));
      assert.equal(answer.status, 200, `${operation} ${field}`);
      assert.equal(held(sim), before + 1);
    }
  }
});

test('a nested Id goes on, a read is not a write, and accountId is refused first', async () => {
  const sim = simulator();
  const nested = { ...BILL, Line: [{ ...line(10), Id: '1' }] };
  assert.equal(refusedFieldOf('bill.create', nested), undefined);
  assert.equal((await sim.provider(call('bill.create', nested))).status, 200);
  assert.equal(refusedFieldOf('companyInfo.get', { Id: '1' }), undefined);
  assert.equal((await sim.provider(call('companyInfo.get', { Id: '1' }))).status, 200);
  await assert.rejects(sim.provider(call('bill.create', { ...BILL, accountId: '1', Id: '2' })), {
    status: 400,
    reason: 'reserved_parameter',
  });
  // A field merely containing the words is no refused field.
  assert.equal(refusedFieldOf('vendor.create', { Identity: 'x', SyncTokens: 'y' }), undefined);
});

test("a vendor: its name required, held to Intuit's lengths, unique among vendors, customers and employees without case; active in the home currency", async () => {
  const sim = simulator();
  sim.company.customers.push(sampleCustomer('20', 'Brightquill Office Mart'));
  for (const [name, input, code] of [
    ['no display name', { CompanyName: 'X' }, '2020'],
    ['a display name of 501', { DisplayName: 'V'.repeat(501) }, '2050'],
    ['a company name of 101', { DisplayName: 'V', CompanyName: 'C'.repeat(101) }, '2050'],
    // Sandbox G4–5: a check name past 110 is "Max:110", a company name past 100 "Max:100".
    ['a check name of 111', { DisplayName: 'V', PrintOnCheckName: 'P'.repeat(111) }, '2050'],
    ["another vendor's name", { DisplayName: 'HARROWGATE office supply' }, '6240'],
    ["a customer's name", { DisplayName: 'brightquill office mart' }, '6240'],
    ["an employee's name", { DisplayName: 'Robin Example' }, '6240'],
  ] as const) {
    assert.deepEqual(await faultOf(sim, 'vendor.create', input), [400, code], name);
  }
  assert.equal(sim.company.vendors.length, 2);
  const made = await sim.provider(
    call('vendor.create', { DisplayName: 'Brightquill Office Mart (vendor)', CompanyName: 'B' }),
  );
  const vendor = (made.body as { Vendor: JsonObject }).Vendor;
  assert.deepEqual(
    [vendor.Id, vendor.Active, vendor.Balance, vendor.Vendor1099, vendor.CurrencyRef],
    ['1001', true, 0, false, { value: 'USD' }],
  );
  assert.equal(vendor.PrintOnCheckName, 'Brightquill Office Mart (vendor)');
  const query = lookupQuery('Vendor', 'DisplayName', 'brightquill office mart (VENDOR)', 2);
  const found = await sim.provider(call('query.run', { query }));
  assert.deepEqual(
    (found.body as { QueryResponse: { Vendor: JsonObject[] } }).QueryResponse.Vendor.map(
      (row) => row.Id,
    ),
    ['1001'],
  );
  // Exactly 500, 100 and 110 characters are taken.
  const longest = await sim.provider(
    call('vendor.create', {
      DisplayName: 'L'.repeat(500),
      CompanyName: 'C'.repeat(100),
      PrintOnCheckName: 'P'.repeat(110),
    }),
  );
  assert.equal(longest.status, 200);
  sim.company.employees.push(sampleEmployee('60', 'Casey Sample'));
  assert.deepEqual(await faultOf(sim, 'vendor.create', { DisplayName: 'casey sample' }), [
    400,
    '6240',
  ]);
});

test("a bill: its vendor required, held and active; its number at most 21 characters; its total its lines', open, due on its date when none is sent", async () => {
  const sim = simulator();
  for (const [name, input, code] of [
    ['no vendor', { ...BILL, VendorRef: undefined }, '2020'],
    ['a vendor the company does not hold', { ...BILL, VendorRef: { value: '999' } }, '2500'],
    ['an inactive vendor', { ...BILL, VendorRef: { value: '8' } }, '610'],
    ['a number of 22', { ...BILL, DocNumber: 'N'.repeat(22) }, '2050'],
    ['an unknown category', { ...BILL, Line: [line(10, '999')] }, '2500'],
    ['a negative line', { ...BILL, Line: [line(-10)] }, '2290'],
    ['no lines', { ...BILL, Line: [] }, '2020'],
  ] as const) {
    assert.deepEqual(await faultOf(sim, 'bill.create', input as JsonObject), [400, code], name);
  }
  assert.deepEqual(sim.company.bills, []);
  const made = await sim.provider(call('bill.create', { ...BILL, DocNumber: 'N'.repeat(21) }));
  const bill = (made.body as { Bill: JsonObject }).Bill;
  assert.deepEqual(
    [bill.Id, bill.TotalAmt, bill.Balance, bill.DueDate, bill.VendorRef],
    ['1001', 413.34, 413.34, '2026-09-14', { value: '7', name: 'Harrowgate Office Supply' }],
  );
  const due = await sim.provider(call('bill.create', { ...BILL, DueDate: '2026-10-14' }));
  assert.equal((due.body as { Bill: JsonObject }).Bill.DueDate, '2026-10-14');
  const query = transactionQuery({
    entity: 'Bill',
    where: [
      { field: 'TotalAmt', operator: '=', value: '413.34' },
      { field: 'TxnDate', operator: '=', value: '2026-09-14' },
      { field: 'VendorRef', operator: '=', value: '7' },
    ],
    maxResults: 4,
  });
  const found = await sim.provider(call('query.run', { query }));
  assert.equal(
    (found.body as { QueryResponse: { Bill: JsonObject[] } }).QueryResponse.Bill.length,
    2,
  );
});

test('a vendor credit names a vendor the company holds and keeps active', async () => {
  const sim = simulator();
  const credit = (vendor: string) => ({ VendorRef: { value: vendor }, Line: [line(10)] });
  assert.deepEqual(await faultOf(sim, 'vendorCredit.create', credit('999')), [400, '2500']);
  assert.deepEqual(await faultOf(sim, 'vendorCredit.create', credit('8')), [400, '610']);
  const made = await sim.provider(call('vendorCredit.create', credit('7')));
  assert.deepEqual((made.body as { VendorCredit: JsonObject }).VendorCredit.VendorRef, {
    value: '7',
    name: 'Harrowgate Office Supply',
  });
});

test("an expense or a vendor credit sent no number: with own numbers off QuickBooks numbers it, the last number plus 1 (Intuit's model); on, or unstated as in Intuit's samples, none", async () => {
  const numbered = async (setting: string | null) => {
    const sim = simulator();
    if (setting !== null) {
      const other = sim.company.preferences.OtherPrefs as JsonObject;
      (other.NameValue as JsonObject[]).push({
        Name: 'VendorAndPurchasesPrefs.UseCustomTxnNumbers',
        Value: setting,
      });
    }
    sim.company.purchases.push(
      samplePurchase('140', { value: '41', name: 'Company Visa' }, { DocNumber: '1022' }),
      samplePurchase('141', { value: '41', name: 'Company Visa' }, { DocNumber: 'R-77' }),
    );
    const expense = { PaymentType: 'Cash', AccountRef: { value: '35' }, Line: [line(10)] };
    const credit = { VendorRef: { value: '7' }, Line: [line(10)] };
    const numbers: unknown[] = [];
    for (const [operation, input, entity] of [
      ['purchase.create', expense, 'Purchase'],
      ['purchase.create', expense, 'Purchase'],
      ['purchase.create', { ...expense, DocNumber: '55120' }, 'Purchase'],
      ['vendorCredit.create', credit, 'VendorCredit'],
      ['vendorCredit.create', { ...credit, DocNumber: 'CM-0077' }, 'VendorCredit'],
    ] as const) {
      const made = await sim.provider(call(operation, input as JsonObject));
      numbers.push((made.body as Record<string, JsonObject>)[entity]?.DocNumber ?? null);
    }
    return numbers;
  };
  assert.deepEqual(await numbered('false'), ['1023', '1024', '55120', '1', 'CM-0077']);
  for (const setting of ['true', null]) {
    assert.deepEqual(
      await numbered(setting),
      [null, null, '55120', null, 'CM-0077'],
      String(setting),
    );
  }
});

test('an answer lost after QuickBooks acted: a 502 naming no reason; recorded first, the key replays it, else QuickBooks is asked again and answers the first record under the same requestid (sandbox S6)', async () => {
  for (const lost of ['after_record', 'before_record'] as const) {
    const sim = simulator();
    sim.script('bill.create', [{ lost }]);
    const request = call('bill.create', BILL);
    await assert.rejects(sim.provider(request), { status: 502, reason: undefined });
    assert.equal(sim.company.bills.length, 1, `${lost}: QuickBooks made the bill`);
    assert.deepEqual(
      sim.calls.map((entry) => [entry.outcome, entry.status]),
      [['lost', 200]],
    );
    const again = await sim.provider(request);
    assert.equal(again.status, 200);
    assert.equal((again.body as { Bill: JsonObject }).Bill.Id, '1001', lost);
    assert.equal(sim.company.bills.length, 1, `${lost}: no second bill`);
    assert.equal(
      sim.calls.at(-1)?.outcome,
      lost === 'after_record' ? 'replayed' : 'answered',
      `${lost}: from Connections' record, else from QuickBooks' own`,
    );
  }
});

test('QuickBooks answers a repeated requestid with its first answer, whatever the body; a refused first request is not kept, and another key or operation is another id (sandbox S6)', async () => {
  const sim = simulator();
  // Nothing recorded by Connections — QuickBooks' answer lost each time — so each ask reaches it.
  sim.script('bill.create', [{ lost: 'before_record' }, { lost: 'before_record' }]);
  const first = call('bill.create', BILL);
  await assert.rejects(sim.provider(first), { status: 502 });
  // The same key with the body changed: Connections recorded nothing, so QuickBooks answers it.
  const changed = { ...first, input: { ...BILL, DocNumber: 'CHANGED-1' } };
  await assert.rejects(sim.provider(changed), { status: 502 });
  const answered = await sim.provider(changed);
  const bill = (answered.body as { Bill: JsonObject }).Bill;
  assert.deepEqual(
    [bill.Id, bill.DocNumber],
    ['1001', undefined],
    'the first body, not the changed one',
  );
  assert.equal(sim.company.bills.length, 1, 'one bill, as first sent');
  // Another key is another request id: a second bill.
  const other = await sim.provider({ ...first, idempotencyKey: 'create-record-other-key-0001' });
  assert.equal((other.body as { Bill: JsonObject }).Bill.Id, '1002');
  // A first request QuickBooks refused is not kept — here its answer lost before Connections
  // recorded it — so the corrected body under the same id creates the record.
  const refusedFirst = { ...first, idempotencyKey: 'create-record-refused-first-01' };
  sim.script('bill.create', [{ lost: 'before_record' }]);
  await assert.rejects(
    sim.provider({ ...refusedFirst, input: { ...BILL, VendorRef: { value: '404' } } }),
    { status: 502 },
  );
  assert.equal(sim.calls.at(-1)?.status, 400, 'QuickBooks refused it');
  const corrected = await sim.provider(refusedFirst);
  assert.equal((corrected.body as { Bill: JsonObject }).Bill.Id, '1003');
  assert.equal(sim.company.bills.length, 3);
});
