import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { creditNote, sampleAnswer, statement } from './check-world.js';
import { REF, lineOf, queriesOf, routeRun, sampleBill, type RouteRun } from './lookups-world.js';
import { outputOf } from './writes-world.js';

/**
 * Numbers QuickBooks could not hold are never sent (Group 4's G4-4), end to end on the simulator:
 * a credit's original invoice number past the 21 characters a bill's number holds makes
 * find-related search nothing — its category then not the original bill's (D25) — and a
 * statement's listed numbers past 21 characters are left out of the IN query and counted as not in
 * QuickBooks; and a statement's number listed twice, in any case, is asked for, counted and listed
 * once (N1).
 */

/** A lookup with no number QuickBooks could hold searches nothing, and finds nothing (§3.E). */
const NO_NUMBER = 'No duplicate';

test("a credit's original invoice number past the 21 characters a bill's holds: find-related sends nothing, and the category is not the original bill's (G4-4, D25)", async () => {
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
    assert.equal(lineOf(world, 'find-related')?.split('; ')[0], NO_NUMBER);
    assert.equal(queriesOf(world)['find-related'], undefined, 'no query');
    assert.ok(world.result.outcome === 'success', JSON.stringify(world.result));
    const category = (outputOf(world.result).record as JsonObject).category as JsonObject;
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
  assert.equal(lineOf(unnumbered, 'find-duplicates')?.split('; ')[0], NO_NUMBER);
  assert.ok(queriesOf(unnumbered)['find-related'], 'the original bill searched');
});

test("a statement's listed numbers: each once whatever its case, those past 21 characters left out of the IN query and counted as not in QuickBooks; none it could hold: nothing searched (N1, G4-4)", async () => {
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
  assert.equal(lineOf(twice, 'find-duplicates')?.split('; ')[0], 'Number checked');
  /** The statement the run's output compares, and the run's summary. */
  const compared = (world: typeof twice) => {
    assert.ok(world.result.outcome === 'success', JSON.stringify(world.result));
    const output = outputOf(world.result);
    const summary = world.result.summary;
    return { statement: (output as { statement: JsonObject }).statement, summary: summary ?? '' };
  };
  assert.deepEqual(compared(twice).statement.listedNotInQuickBooks, ['HOS-1031']);
  assert.equal(compared(twice).summary, 'Compared with QuickBooks: 1 invoice not in QuickBooks.');
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
  assert.equal(compared(longer).summary, 'Compared with QuickBooks: 2 invoices not in QuickBooks.');
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
  assert.equal(lineOf(none, 'find-duplicates')?.split('; ')[0], 'Number checked');
  assert.equal((compared(none).statement.listedNotInQuickBooks as string[]).length, 3);
});
