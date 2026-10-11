import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { bill, creditNote, paidBy, receipt, sampleAnswer } from './check-world.js';
import { VENDOR, decide, heldOf, type DecideSetUp } from './decide-world.js';

/**
 * The approval wording (the plan's §2.7, replacing Group 3's D7): what approving creates, under
 * decide's line, and the end of the reason line, on each path; at most 200 characters each, names
 * shortened first with '…' and the amount always kept.
 */

const TIDEWELL = { ...VENDOR, id: '9', displayName: 'Tidewell Hardware' };
const LIMIT_ZERO = { holdAboveAmount: 0 };

/** Every path held by a limit of 0: the wording and the reason line it shows. */
function words(setUp: DecideSetUp) {
  const held = heldOf(decide({ config: LIMIT_ZERO, ...setUp }));
  return [held.heldReason, held.reason];
}

test("each path: the wording under decide's line, and the end of the reason line", () => {
  assert.deepEqual(words({ answer: bill() }), [
    'Approve to create this bill in QuickBooks',
    'Over the $0 limit: Harrowgate Office Supply, HOS-1042, $413.34',
  ]);
  assert.deepEqual(words({ answer: bill(), vendor: { status: 'new' } }), [
    'Approve to create this vendor and bill in QuickBooks',
    'Over the $0 limit; new vendor: Harrowgate Office Supply, HOS-1042, $413.34',
  ]);
  assert.deepEqual(words({ answer: receipt(), vendor: TIDEWELL }), [
    'Approve to record this expense, paid from Company Visa',
    'Over the $0 limit: Tidewell Hardware, $60.63 from Company Visa',
  ]);
  assert.deepEqual(words({ answer: receipt(), vendor: { status: 'new' } }), [
    'Approve to record this expense, paid from Company Visa',
    'Over the $0 limit: Tidewell Hardware, $60.63 from Company Visa',
  ]);
  assert.deepEqual(words({ answer: sampleAnswer('card-refund'), vendor: TIDEWELL }), [
    'Approve to record this refund to Company Visa',
    'Over the $0 limit: refund from Tidewell Hardware, $23.72',
  ]);
  assert.deepEqual(words({ answer: creditNote() }), [
    'Approve to record this vendor credit for Harrowgate Office Supply',
    'Over the $0 limit: credit from Harrowgate Office Supply, CM-0077, $203.20',
  ]);
  assert.deepEqual(words({ answer: receipt(), check: paidBy('employee', { paidFrom: null }) }), [
    'Approve to record this expense and that the company owes Robin Example $60.63',
    'Paid personally; over the $0 limit: Robin Example paid Tidewell Hardware, $60.63',
  ]);
  assert.deepEqual(words({ answer: receipt(), check: paidBy('owner', { paidFrom: null }) }), [
    "Approve to record this expense as Pat Owner's owner investment",
    'Paid personally; over the $0 limit: Pat Owner paid Tidewell Hardware, $60.63',
  ]);
  const contractor = {
    answer: receipt(),
    check: paidBy('not_employee', { paidFrom: null }),
  } as const;
  assert.deepEqual(
    words({ ...contractor, vendor: { ...VENDOR, displayName: 'Sam Lee', vendor1099: true } }),
    [
      'Approve to create a bill so the company repays Sam Lee $60.63',
      'Paid personally; over the $0 limit: Sam Lee (1099 vendor) paid Tidewell Hardware, $60.63',
    ],
  );
  assert.deepEqual(
    words({ ...contractor, vendor: { ...VENDOR, displayName: 'Sam Lee', vendor1099: false } })[1],
    [
      'Paid personally; over the $0 limit: Sam Lee (vendor, not marked 1099) paid Tidewell Hardware, $60.63',
    ][0],
  );
});

test("a contractor matched by company name: both lines name the vendor as QuickBooks shows it, never as typed in 'Who paid'", () => {
  const contractor = heldOf(
    decide({
      answer: receipt(),
      check: paidBy('not_employee', { paidFrom: null }),
      vendor: {
        ...VENDOR,
        id: '61',
        displayName: 'Samuel Lee Consulting',
        matchedBy: 'company name',
        vendor1099: true,
      },
    }),
  );
  assert.equal(
    contractor.heldReason,
    'Approve to create a bill so the company repays Samuel Lee Consulting $60.63',
  );
  assert.equal(
    contractor.reason,
    'Paid personally: Samuel Lee Consulting (1099 vendor) paid Tidewell Hardware, $60.63',
  );
  assert.deepEqual(contractor.saved.plan.payee, {
    kind: 'vendor',
    id: '61',
    name: 'Samuel Lee Consulting',
  });
  for (const line of [contractor.heldReason, contractor.reason, contractor.summary]) {
    assert.ok(!line.includes('Sam Lee '), `the name as typed: ${line}`);
  }
});

test("the plan's full example: paid personally and over the limit", () => {
  const answer = receipt({ total: 612.4, subtotal: 612.4, tax: null, lineItems: [] });
  const held = heldOf(decide({ answer, check: paidBy('employee', { paidFrom: null }) }));
  assert.equal(
    held.reason,
    'Paid personally; over the $500 limit: Robin Example paid Tidewell Hardware, $612.40',
  );
});

test('a name a customer has: the vendor is created, and shown, as "<name> (vendor)"', () => {
  const held = heldOf(
    decide({ answer: bill(), vendor: { status: 'new' }, customerNameClash: 'match' }),
  );
  assert.equal(
    held.reason,
    'New vendor; name used by a customer, will be created with (vendor): Harrowgate Office Supply (vendor), HOS-1042, $413.34',
  );
  assert.equal(
    held.saved.plan.payee.kind === 'new_vendor' && held.saved.plan.payee.name,
    'Harrowgate Office Supply (vendor)',
  );
});

test('long names are shortened with "…", first; the amount and the number always stay; every line at most 200', () => {
  const long = 'L'.repeat(500);
  const cases: DecideSetUp[] = [
    {
      answer: bill({ vendorName: long, documentNumber: `INV-${'9'.repeat(60)}` }),
      vendor: { status: 'new' },
    },
    {
      answer: receipt({ vendorName: long }),
      vendor: { status: 'new' },
      accounts: {
        paidFrom: {
          id: '41',
          fullyQualifiedName: `Cards:${'C'.repeat(600)}`,
          accountType: 'Credit Card',
        },
      },
    },
    { answer: creditNote(), vendor: { ...VENDOR, displayName: long } },
    {
      answer: receipt({ vendorName: long }),
      check: paidBy('employee', { paidFrom: null }),
      state: {
        payer: {
          route: 'employee',
          name: 'P'.repeat(500),
          employeeId: '55',
          account: {
            id: '120',
            fullyQualifiedName: 'Owed to Team Members',
            accountType: 'Other Current Liability',
          },
        } as JsonObject,
      },
    },
    {
      answer: receipt({ vendorName: long }),
      check: paidBy('owner', { paidFrom: null }),
      state: {
        payer: {
          route: 'owner',
          name: 'O'.repeat(500),
          employeeId: null,
          account: { id: '125', fullyQualifiedName: 'Owner investments', accountType: 'Equity' },
        } as JsonObject,
      },
    },
  ];
  for (const setUp of cases) {
    const held = heldOf(decide({ config: LIMIT_ZERO, ...setUp }));
    for (const line of [held.heldReason, held.reason, held.summary]) {
      assert.ok(line.length <= 200, `${line.length}: ${line.slice(0, 60)}`);
    }
    assert.match(held.reason, /\$\d[\d,]*\.\d\d( from .+)?$/u, held.reason.slice(-60));
    assert.ok(held.reason.includes('…'), 'a name was shortened');
  }
  const bill500 = heldOf(decide({ config: LIMIT_ZERO, ...cases[0]! }));
  assert.ok(
    bill500.reason.endsWith(`…, INV-${'9'.repeat(25)}…, $413.34`),
    bill500.reason.slice(-60),
  );
  const employee = heldOf(decide({ config: LIMIT_ZERO, ...cases[3]! }));
  assert.ok(employee.heldReason.endsWith('… $60.63'), employee.heldReason.slice(-30));
});
