import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { Decision } from '../src/decide/decide.js';
import { SAVED_MAXIMUM_BYTES, savedBytes } from '../src/decide/saved.js';
import { memoOf, recordBody, runLine } from '../src/writes/bodies.js';
import { readSaved } from '../src/writes/saved-state.js';
import { bill, receipt } from './check-world.js';
import { billRow, decide, found } from './decide-world.js';

/**
 * What decide saves for the steps after it (the plan's §2.8; Group 5): the seller and the
 * document's number, carried by design; the company with its file's creation time, for
 * confirm-company; the re-check confirm-no-duplicate repeats; a memo whose run is the one that
 * writes it, naming Invoice Processing; and all of it under 32 KiB with the longest names, read back
 * whole by the steps after decide.
 */

function saved(decision: Decision) {
  assert.ok(decision.outcome === 'ok' || decision.outcome === 'held', decision.outcome);
  return decision.saved;
}

test("the seller and the document's number are saved, and the company with its file's creation time", () => {
  const straight = saved(decide({ answer: bill() }));
  assert.deepEqual(
    [straight.seller, straight.documentNumber],
    ['Harrowgate Office Supply', 'HOS-1042'],
  );
  assert.deepEqual(
    saved(decide({ answer: bill(), company: { createdAt: '2024-01-02T09:00:00-08:00' } })).company,
    {
      name: 'Sample Bakery',
      legalName: 'Sample Bakery LLC',
      country: 'USA',
      createdAt: '2024-01-02T09:00:00-08:00',
    },
  );
  assert.equal(straight.company.createdAt, null, 'none kept: null');
  // Read back whole by the steps after decide, held or straight through.
  assert.ok(readSaved(straight as unknown as JsonObject));
  const held = saved(decide({ answer: bill(), config: { holdAboveAmount: 0 } }));
  assert.ok(readSaved(held as unknown as JsonObject));
});

test("the plan's memo leaves the run to the write: the run that writes it comes first, after an approval the continuation", () => {
  const plan = saved(decide({ answer: receipt(), config: { holdAboveAmount: 0 } })).plan;
  assert.equal(plan.memo, 'Receipt 55120 from Tidewell Hardware.');
  const continuation = '88888888-8888-4888-8888-888888888888';
  assert.equal(
    memoOf(plan, continuation),
    `Created by Autom8x Invoice Processing, run ${continuation}. Receipt 55120 from Tidewell Hardware.`,
  );
  assert.equal(memoOf({ ...plan, memo: '' }, continuation), runLine(continuation));
  // The same plan and run give the same bytes, every time: what the platform's record replays.
  assert.equal(
    JSON.stringify(recordBody(plan, '7', continuation)),
    JSON.stringify(recordBody(structuredClone(plan), '7', continuation)),
  );
});

test('the saved data, with its re-check, stays far under 32 KiB with the longest names and numbers; past 32 KiB decide fails cleanly', () => {
  const long = saved(
    decide({
      answer: bill({ vendorName: 'V'.repeat(500), documentNumber: 'N'.repeat(100) }),
      vendor: { status: 'new' },
      company: {
        name: 'C'.repeat(1_024),
        legalName: 'L'.repeat(1_024),
        createdAt: '2024-01-02T09:00:00-08:00',
      },
    }),
  );
  assert.equal(long.recheck.facts.number, 'N'.repeat(100));
  assert.ok(savedBytes(long) < 12 * 1024, String(savedBytes(long)));
  const numbered = saved(
    decide({ answer: bill({ documentNumber: 'N'.repeat(21) }), vendor: { status: 'new' } }),
  );
  assert.match(numbered.recheck.query, new RegExp(`DocNumber = '${'N'.repeat(21)}'`, 'u'));
  assert.equal(SAVED_MAXIMUM_BYTES, 32_768);
  const ids = Array.from({ length: 3_000 }, (_, index) =>
    billRow({ id: `B${String(index).padStart(11, '0')}`, vendorId: '88', docNumber: null }),
  );
  assert.equal(
    decide({ answer: bill(), lookups: { amountLookup: found(...ids) } }).outcome,
    'failed',
  );
});
