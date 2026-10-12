import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { creditNote, sampleAnswer, statement } from './check-world.js';
import { REF, lineOf, queriesOf, routeRun, sampleBill, type RouteRun } from './lookups-world.js';

/**
 * Numbers QuickBooks could not hold are never sent (Group 4's G4-4), end to end on the simulator:
 * a credit's original invoice number past the 21 characters a bill's number holds makes
 * find-related say "Not checked" — its category then not the original bill's (D25) — and a
 * statement's listed numbers past 21 characters are left out of the IN query and counted as not in
 * QuickBooks; and a statement's number listed twice, in any case, is asked for, counted and listed
 * once (N1).
 */

const NO_NUMBER = 'Not checked by number: no number was read';

test("a credit's original invoice number past the 21 characters a bill's holds: find-related says \"Not checked\" and sends nothing, and the category is not the original bill's (G4-4, D25)", async () => {
  const long = `HOS-${'1042'.repeat(5)}-X`;
  assert.equal(long.length, 26);
  for (const answer of [
    creditNote({ originalInvoiceNumber: long }),
    sampleAnswer('card-refund', { originalInvoiceNumber: long }),
  ]) {
    const world = await routeRun({
      answer,
      // Were it searched, a bill with that number — one QuickBooks could never hold — would give
      // the category.
      company: (sim) =>
        sim.company.bills.push(
          sampleBill('151', REF.harrowgate, { DocNumber: long }),
          sampleBill('152', REF.tidewell, { DocNumber: long }),
        ),
    });
    assert.equal(
      lineOf(world, 'find-related'),
      'Original bill not checked: its number is longer than the 21 characters QuickBooks holds',
    );
    assert.equal(queriesOf(world)['find-related'], undefined, 'no query');
    assert.ok(world.result.outcome === 'success', JSON.stringify(world.result));
    const category = ((world.result.output as JsonObject).record as JsonObject)
      .category as JsonObject;
    assert.notEqual(category.why, 'the original bill used it');
  }
  // 21 characters, the most a bill's number holds: searched.
  const fits = 'O'.repeat(21);
  const world = await routeRun({
    answer: creditNote({ originalInvoiceNumber: fits }),
    through: 'find-related',
  });
  assert.equal(
    queriesOf(world)['find-related'],
    `SELECT * FROM Bill WHERE DocNumber = '${fits}' AND VendorRef = '7' MAXRESULTS 3`,
  );
  // A credit with no number of its own: that lookup says so, and its original bill is searched.
  const unnumbered = await routeRun({
    answer: creditNote({ documentNumber: null }),
    through: 'find-related',
  });
  assert.equal(lineOf(unnumbered, 'find-duplicate-number'), NO_NUMBER);
  assert.ok(queriesOf(unnumbered)['find-related'], 'the original bill searched');
});

test('a statement\'s listed numbers: each once whatever its case, those past 21 characters left out of the IN query and counted as not in QuickBooks; none it could hold: "Not checked" (N1, G4-4)', async () => {
  const long = `HOS-${'0'.repeat(18)}50`;
  const rows = (third: string, first = 'HOS-1031') => [
    { reference: 'Balance forward', amount: 214.2, kind: 'balance_forward' },
    { reference: first, amount: 380, kind: 'invoice' },
    { reference: 'PMT-5520', amount: -214.2, kind: 'payment' },
    { reference: 'HOS-1042', amount: 413.34, kind: 'invoice' },
    { reference: 'CM-0077', amount: -203.2, kind: 'credit' },
    { reference: third, amount: 96.4, kind: 'invoice' },
  ];
  const seeded: RouteRun['company'] = (sim) =>
    sim.company.bills.push(
      sampleBill('140', REF.harrowgate, { DocNumber: 'HOS-1042', TotalAmt: 413.34, Balance: 0 }),
    );
  // HOS-1031 listed twice, in two cases: one number asked for, one counted, one listed.
  const twice = await routeRun({
    answer: statement({ listedItems: rows('hos-1031') }),
    company: seeded,
  });
  assert.equal(
    queriesOf(twice)['find-duplicate-number'],
    "SELECT * FROM Bill WHERE DocNumber IN ('HOS-1031', 'HOS-1042') AND VendorRef = '7' MAXRESULTS 3",
  );
  assert.equal(
    lineOf(twice, 'find-duplicate-number'),
    'Listed invoices not in QuickBooks: HOS-1031',
  );
  /** The statement the run's output compares, and the run's summary. */
  const compared = (world: typeof twice) => {
    assert.ok(world.result.outcome === 'success', JSON.stringify(world.result));
    const { output, summary } = world.result;
    return { statement: (output as { statement: JsonObject }).statement, summary: summary ?? '' };
  };
  assert.deepEqual(compared(twice).statement.listedNotInQuickBooks, ['HOS-1031']);
  assert.match(compared(twice).summary, /; 1 listed invoice not in QuickBooks[;.]/u);
  // A number past 21 characters: left out of the query, and not in QuickBooks.
  const longer = await routeRun({
    answer: statement({ listedItems: rows(long) }),
    company: seeded,
  });
  assert.equal(
    queriesOf(longer)['find-duplicate-number'],
    "SELECT * FROM Bill WHERE DocNumber IN ('HOS-1031', 'HOS-1042') AND VendorRef = '7' MAXRESULTS 3",
  );
  assert.deepEqual(compared(longer).statement.listedNotInQuickBooks, ['HOS-1031', long]);
  assert.match(compared(longer).summary, /; 2 listed invoices not in QuickBooks[;.]/u);
  // Every listed number past 21 characters: nothing to search, each not in QuickBooks.
  const longest = `HOS-${'0'.repeat(18)}31`;
  const none = await routeRun({
    answer: statement({
      listedItems: rows(long, longest).map((row) =>
        row.reference === 'HOS-1042' ? { ...row, reference: `HOS-${'0'.repeat(18)}42` } : row,
      ),
    }),
    company: seeded,
  });
  assert.equal(queriesOf(none)['find-duplicate-number'], undefined);
  assert.equal(
    lineOf(none, 'find-duplicate-number'),
    'Not checked by number: every invoice number the statement lists is longer than the 21 characters QuickBooks holds, so none is in QuickBooks',
  );
  assert.equal((compared(none).statement.listedNotInQuickBooks as string[]).length, 3);
});
