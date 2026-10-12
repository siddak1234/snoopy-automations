import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { PAID, type RouteRun } from './lookups-world.js';
import { SAMPLES } from './sample-maker/samples.js';
import { approve, firstRun, writesOf } from './writes-world.js';

/**
 * The planted marker, end to end (the plan's §2.9: it "never appears in any line, reason, sentence,
 * saved data, QuickBooks request or email, for every type"): each made-up sample's marker planted
 * in the fields the code reads and must never pass on — its currency, card digits and the
 * references a document other than a statement lists — and the run taken through every step on
 * the simulator, approved when it held, on every path its document can take, with an "Also email"
 * address set. The seller's name and the document's number are carried by design, so the marker
 * is never planted there.
 */

/** Read 1's answer with the marker in the fields named. */
function planted(answer: JsonObject, marker: string, fields: readonly string[]): JsonObject {
  const copy: JsonObject = structuredClone(answer);
  for (const field of fields) {
    if (field === 'listedItems') {
      if (answer.documentType === 'supplier_statement') continue;
      copy.listedItems = [
        ...(answer.listedItems as JsonObject[]),
        { reference: marker, amount: 10, kind: 'invoice' },
      ];
    } else {
      copy[field] = marker;
    }
  }
  return copy;
}

/**
 * The paths a sample's document can take, as each is run: the company's — for a bill, its vendor
 * also new, so the vendor is created — and paid personally.
 */
function pathsOf(answer: JsonObject): [string, Partial<RouteRun>][] {
  const company: [string, Partial<RouteRun>] = ['company', PAID.company];
  if (answer.documentType !== 'bill' && answer.documentType !== 'receipt') return [company];
  return [
    company,
    ...(answer.documentType === 'bill'
      ? [['company, a new vendor', { ...PAID.company, bare: true }] as [string, Partial<RouteRun>]]
      : []),
    ['employee', PAID.employee],
    ['owner', PAID.owner],
    ['contractor', PAID.contractor],
  ];
}

test("every sample's marker, planted where the code must not pass it on, reaches no QuickBooks request, mail, line or result — on every path, held and approved or straight through", async () => {
  const written = new Map<string, number>();
  for (const sample of SAMPLES) {
    for (const fields of [[], ['currency', 'cardLast4', 'listedItems']] as const) {
      for (const [path, settings] of pathsOf(sample.answer)) {
        const label = `${sample.name}, ${path}, planted in ${fields.join(' ') || 'nothing'}`;
        const run: RouteRun = {
          ...settings,
          answer: planted(sample.answer, sample.marker, fields),
          config: { ...(settings.config ?? {}), notifyEmail: 'books@example.com' },
        };
        const first = await firstRun(run);
        const said: unknown[] = [
          first.platform.providerCalls,
          first.platform.mails,
          first.platform.steps,
          first.result,
        ];
        let writes = writesOf(first.platform.providerCalls);
        if (first.result.outcome === 'held') {
          const approved = await approve(first);
          said.push(approved.providerCalls, approved.mails, approved.steps, approved.result);
          writes = writesOf(approved.providerCalls);
        }
        assert.ok(!JSON.stringify(said).includes(sample.marker), `${label}: the marker`);
        for (const [operation] of writes) {
          written.set(operation, (written.get(operation) ?? 0) + 1);
        }
      }
    }
  }
  // Every write was made with a marker in play.
  for (const operation of [
    'vendor.create',
    'bill.create',
    'purchase.create',
    'vendorCredit.create',
    'journalEntry.create',
  ]) {
    assert.ok((written.get(operation) ?? 0) > 0, operation);
  }
});
