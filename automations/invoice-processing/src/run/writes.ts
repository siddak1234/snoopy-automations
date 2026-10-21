import type { Clock } from '@autom8x/automation-kit/quickbooks';
import { sameName } from '@autom8x/automation-kit/values';
import {
  isObject,
  type InvokeRequest,
  type JsonObject,
  type Step,
  type StepContext,
} from '@autom8x/automation-sdk';

import { NOT_RECORDED } from '../quickbooks-path.js';
import { confirmNoDuplicate } from '../steps/confirm-no-duplicate.js';
import { addVendor, confirmVendor, type NewVendor } from '../steps/confirm-vendor.js';
import { createRecord } from '../steps/create-record.js';
import { createdOf, newVendorOf, readSaved } from '../writes/saved-state.js';
import { written } from './documents.js';
import {
  partOf,
  partPlatform,
  runForDocument,
  stopped,
  turnOf,
  type FanOut,
  type Turn,
} from './fan-out.js';
import { planned, quickBooksRun } from './quickbooks.js';
import type { Entry, RunState } from './state.js';
import { countLine, sameAs } from './words.js';

/**
 * The writes, per document (the session's spec, §3.2 steps 13–14 and 18–21; B3): each document its
 * own vendor, found or added — one vendor added per name in the file, every document with that
 * name linked to it — and its own record, each write under the document's part, so each carries
 * its own Intuit `requestid`. v2's own steps do each document's work; a write QuickBooks refuses
 * keeps that one document out of QuickBooks, its details saved, and the others go on.
 *
 * On the first run the documents ready to record are written; after an approval, the documents
 * that waited, once the checks an approval repeats have run (v2's confirm-* steps).
 *
 * A receipt's or a card refund's new seller is added only when every check of its name came back
 * clear (`addsSeller`), and is never what keeps its expense out of QuickBooks: when it cannot be
 * found or added — refused, or no answer once the step's repeats are spent (`gaveUpOn`) — the
 * expense is recorded naming no vendor, the seller in its memo, as v2 did.
 *
 * Two copies of one purchase in one file both wait — the second "same as document N"
 * (`check.ts`) — and confirm-no-duplicates checks every waiting document before any is written, so
 * it cannot see the record a copy's twin is about to make. Each write therefore first looks for a
 * twin QuickBooks holds or may hold, written in the first run or earlier in the same step, and
 * keeps the copy out: "Not recorded in QuickBooks: same as document N" (Gate 25's R5d).
 */

type Done = Extract<Turn, { entry: Entry }>;

/** The new vendor a document's plan names, while no vendor is linked to it yet. */
function newVendorOfPlan(entry: Entry): NewVendor | undefined {
  const payee = readSaved(entry.engine)?.plan.payee;
  return payee?.kind === 'new_vendor' && newVendorOf(entry.engine) === null ? payee : undefined;
}

/** A purchase names a vendor only to link one (D20): without one it is recorded all the same. */
function purchase(entry: Entry): boolean {
  return readSaved(entry.engine)?.plan.operation === 'purchase.create';
}

/** A purchase whose new vendor could not be found or added: its plan names none, and it goes on. */
function unlinked(entry: Entry): Entry {
  const saved = readSaved(entry.engine);
  if (!saved) return entry;
  const { quickBooks: _stop, ...engine } = entry.engine;
  const plan = { ...saved.plan, payee: { kind: 'none' } };
  return { ...entry, engine: { ...engine, plan: plan as unknown as JsonObject } };
}

/** One document after a vendor step: linked or found — or kept out of QuickBooks, a purchase unlinked. */
function afterVendor(before: Entry, after: Entry): Entry {
  if (after.engine.quickBooks === undefined) return after;
  return purchase(before) ? unlinked({ ...before, engine: after.engine }) : after;
}

/** The first document in the file this one is a copy of ("same as document N"); else its own index. */
function firstCopyOf(entry: Entry, documents: readonly Entry[]): number {
  return (
    documents.find((other) => entry.doubts.includes(sameAs(other.index)))?.index ?? entry.index
  );
}

/**
 * A copy of this document in the file — the same seller, date and total — that QuickBooks holds or
 * may hold before this write: recorded, or written unconfirmed, in the first run or earlier in this
 * step (each document's entry as this step's turns left it).
 */
function writtenCopy(entry: Entry, run: RunState, earlier: readonly Done[]): Entry | undefined {
  const first = firstCopyOf(entry, run.documents);
  const now = new Map(run.documents.map((other) => [other.index, other]));
  for (const turn of earlier) now.set(turn.entry.index, turn.entry);
  return [...now.values()].find(
    (other) =>
      other.index !== entry.index &&
      firstCopyOf(other, run.documents) === first &&
      written(other.engine) !== null,
  );
}

/** The name a vendor step tried for a document, and what stopped it, kept for the others with it. */
function tried(entry: Entry, name: string, stop: unknown): Entry {
  const vendorTried = isObject(stop) ? { name, stop } : { name };
  return { ...entry, engine: { ...entry.engine, vendorTried } };
}

/** The documents a write step takes: the first run's ready ones, or after approval those that waited. */
function writable(stage: 'ready' | 'waiting') {
  return (entry: Entry, run: RunState, request: InvokeRequest) =>
    entry.stage === stage &&
    (request.continuation === undefined) === (stage === 'ready') &&
    quickBooksRun(run, request) &&
    planned(entry);
}

/** Adding the vendors: once per name in the file, every document with the name linked to it. */
function addVendors(stage: 'ready' | 'waiting'): FanOut {
  const takes = writable(stage);
  return {
    writes: true,
    gaveUpOn: afterVendor,
    eligible: (entry, run, request) =>
      takes(entry, run, request) && newVendorOfPlan(entry) !== undefined,
    async turn(context: StepContext, entry: Entry, _run, earlier) {
      const payee = newVendorOfPlan(entry)!;
      const leader = earlier.find((turn) => {
        const vendorTried = turn.entry.engine.vendorTried;
        return isObject(vendorTried) && sameName(vendorTried.name, payee.name);
      });
      if (leader) {
        const added = newVendorOf(leader.entry.engine);
        const stop = (leader.entry.engine.vendorTried as JsonObject).stop;
        const linked =
          added !== null && added !== undefined
            ? { ...entry, engine: { ...entry.engine, newVendor: added as unknown as JsonObject } }
            : stopped(entry, isObject(stop) ? stop : { notRecorded: NOT_RECORDED.no_answer });
        return { entry: afterVendor(entry, linked), summary: null, failed: !added };
      }
      const platform = partPlatform(context.platform, partOf(entry.index));
      const turn = turnOf(entry, await addVendor(platform, entry.engine, payee));
      if ('end' in turn) return turn;
      const marked = tried(turn.entry, payee.name, turn.entry.engine.quickBooks);
      return { ...turn, entry: afterVendor(entry, marked) };
    },
    line(turns: readonly Done[]) {
      const added = turns.filter((turn) => turn.summary === 'Vendor added').length;
      if (turns.length === 1) return turns[0]?.summary ?? 'Vendor linked';
      return countLine([
        [added, added === 1 ? 'vendor added' : 'vendors added'],
        [turns.length - added, 'linked'],
      ]);
    },
  };
}

/**
 * Recording: v2's create-record on each document, which is done either way — but never a copy
 * whose twin in the file QuickBooks already holds or may hold (`writtenCopy`).
 */
function records(stage: 'ready' | 'waiting'): FanOut {
  return {
    writes: true,
    eligible: writable(stage),
    async turn(context, entry, run, earlier) {
      const after = stage === 'waiting' ? { afterApproval: true } : {};
      const copy = writtenCopy(entry, run, earlier);
      if (copy) {
        const reason = sameAs(copy.index);
        const kept = stopped(entry, { notRecorded: reason });
        return {
          entry: { ...kept, stage: 'done', ...after },
          summary: `Not recorded in QuickBooks: ${reason}`,
          failed: false,
        };
      }
      const result = await runForDocument(createRecord(), context, run, entry, partOf(entry.index));
      const turn = turnOf(entry, result);
      if ('end' in turn) return turn;
      return { ...turn, entry: { ...turn.entry, stage: 'done', ...after } };
    },
    line(turns: readonly Done[]) {
      if (turns.length === 1) return turns[0]?.summary ?? 'Not recorded';
      const recorded = turns.filter((turn) => createdOf(turn.entry.engine) !== undefined).length;
      return countLine([
        [recorded, 'recorded in QuickBooks'],
        [turns.length - recorded, 'not recorded'],
      ]);
    },
  };
}

/** After approval, a check v2 repeats before writing, on each document that waited. */
function again(eligible: FanOut['eligible'], step: Step, label: string, vendor: boolean): FanOut {
  return {
    eligible,
    ...(vendor ? { gaveUpOn: afterVendor } : {}),
    async turn(context, entry, run) {
      const result = await runForDocument(step, context, run, entry, partOf(entry.index));
      const turn = turnOf(entry, result);
      if ('end' in turn || !vendor) return turn;
      return { ...turn, entry: afterVendor(entry, turn.entry) };
    },
    line(turns: readonly Done[]) {
      if (turns.length === 1) return turns[0]?.summary ?? label;
      return countLine([[turns.length, label]]);
    },
  };
}

export function writeSpecs(clock: Clock): Record<string, FanOut> {
  const waited = writable('waiting');
  return {
    'create-vendors': addVendors('ready'),
    'create-records': records('ready'),
    'confirm-vendors': again(
      (entry, run, request) => waited(entry, run, request) && newVendorOfPlan(entry) !== undefined,
      confirmVendor(clock),
      'vendors checked again',
      true,
    ),
    'create-approved-vendors': addVendors('waiting'),
    'confirm-no-duplicates': again(waited, confirmNoDuplicate(clock), 'checked again', false),
    'create-approved-records': records('waiting'),
  };
}
