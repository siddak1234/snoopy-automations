import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BillRow } from '../src/decide/contract.js';
import { relatedLine as relatedLineOf } from '../src/lookups/lines.js';
import { check, creditNote, documentOf } from './check-world.js';
import { VENDOR, billRow } from './decide-world.js';
import { REF, lineOf, routeRun, sampleBill } from './lookups-world.js';

/**
 * The record lookups' lines within the platform's 200 characters (Group 4's N4): "+N more" and a
 * full answer's "maybe more" (D6) always end the line whole; a record whose words do not fit beside
 * them is left out from the end and counted, the first always shown — cut only when it alone is
 * too long.
 */

test("a three-row record line too long for 200 characters keeps its '; maybe more' (D6): a record that does not fit whole beside it is counted in '+N more'", async () => {
  const original = 'HOS-1042-2026-REV-B07';
  assert.equal(original.length, 21);
  const relatedLine = async (number: string, ids: readonly string[], amount: number) =>
    lineOf(
      await routeRun({
        answer: creditNote({ originalInvoiceNumber: number }),
        through: 'find-related',
        company: (sim) =>
          sim.company.bills.push(
            ...ids.map((id) =>
              sampleBill(id, REF.harrowgate, {
                DocNumber: number,
                TxnDate: '2026-08-14',
                TotalAmt: amount,
                Balance: 0,
              }),
            ),
          ),
      }),
      'find-related',
    ) ?? '';
  assert.equal(
    await relatedLine(original, ['80212', '80213', '80214'], 413.34),
    `Bills from this vendor with number '${original}': Id 80212 (this vendor, 2026-08-14, $413.34, paid); Id 80213 (this vendor, 2026-08-14, $413.34, paid); +1 more; maybe more`,
  );
  // Short enough, all three stay whole.
  assert.equal(
    await relatedLine('HOS-1042', ['21', '22', '23'], 9),
    "Bills from this vendor with number 'HOS-1042': Id 21 (this vendor, 2026-08-14, $9.00, paid); Id 22 (this vendor, 2026-08-14, $9.00, paid); Id 23 (this vendor, 2026-08-14, $9.00, paid); maybe more",
  );
  // A first record too long on its own is shown cut, never left out, and the mark still ends the line.
  const document = documentOf(check(creditNote()));
  const huge: BillRow = { ...billRow({ id: '5' }), txnDate: '2'.repeat(300), balanceCents: 0 };
  const cut = relatedLineOf({
    document,
    vendor: VENDOR,
    how: 'amount',
    rows: [{}, {}],
    records: [huge, huge],
    reachedMax: true,
  });
  assert.equal(cut.length, 200);
  assert.match(
    cut,
    /^Bills from this vendor with number 'HOS-1042': Id 5 \(this vendor, 2+…; \+1 more; maybe more$/u,
  );
});
