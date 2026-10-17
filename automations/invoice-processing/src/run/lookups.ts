import type { Clock } from '@autom8x/automation-kit/quickbooks';
import { shorten } from '@autom8x/automation-kit/values';
import type { Step, StepContext } from '@autom8x/automation-sdk';

import type { ExpenseSearch } from '../lookups/expense-search.js';
import {
  findCustomerName,
  findEmployeeName,
  findSimilarVendors,
} from '../steps/find-name-checks.js';
import {
  findDuplicateAmount,
  findDuplicateNumber,
  findOtherRecord,
  findRelated,
} from '../steps/find-records.js';
import { findVendor, findVendorCompany } from '../steps/find-vendor.js';
import { LINE_MAXIMUM } from '../words.js';
import { partOf, runForDocument, turnOf, type FanOut, type Turn } from './fan-out.js';
import { forQuickBooks, quickBooksRun } from './quickbooks.js';
import type { Entry, RunState } from './state.js';
import { countLine } from './words.js';

/**
 * The lookups, per document (the session's spec, §3.2 steps 8–11): v2's nine lookups merged into
 * four steps, each running v2's own on every document headed for QuickBooks, in the file's order,
 * each call under the document's part — `find-vendors` (v2's find-vendor, find-vendor-company,
 * find-similar-vendors), `find-names` (find-customer-name, find-employee-name), `find-duplicates`
 * (find-duplicate-number, find-duplicate-amount) and `find-related` (find-related,
 * find-other-record). A lookup that keeps one document out of QuickBooks keeps that one out; the
 * others go on.
 */

/** v2's steps in turn on one document, each its own part, until QuickBooks stops the document. */
export function inTurn(steps: readonly Step[]) {
  return async (context: StepContext, entry: Entry, run: RunState): Promise<Turn> => {
    let current = entry;
    const said: string[] = [];
    let failed = false;
    for (const [call, step] of steps.entries()) {
      if (current.engine.quickBooks !== undefined) break;
      const result = await runForDocument(step, context, run, current, partOf(entry.index, call));
      const turn = turnOf(current, result);
      if ('end' in turn) return turn;
      current = turn.entry;
      failed ||= turn.failed;
      // QuickBooks stopped the document: that lookup's line is its line.
      if (current.engine.quickBooks !== undefined) {
        return { entry: current, summary: turn.summary, failed };
      }
      if (turn.summary !== null && !said.includes(turn.summary)) said.push(turn.summary);
    }
    // Each line v2 said for the document, once.
    return { entry: current, summary: said.length === 0 ? null : said.join('; '), failed };
  };
}

/** v2's line for a vendor found nowhere: what a chain says unless one of its lookups says more. */
const NEW_VENDOR = 'New vendor';

/**
 * The step's line: one document's as v2 said it — every line its lookups said, or for the vendor
 * and name lookups the last that says more than "New vendor" — several counted, with those
 * QuickBooks stopped.
 */
function lineFor(label: string, telling = false) {
  return (turns: readonly Extract<Turn, { entry: Entry }>[]): string => {
    if (turns.length === 1) {
      const said = (turns[0]?.summary ?? label).split('; ');
      const told = said.filter((line) => line !== NEW_VENDOR).at(-1) ?? NEW_VENDOR;
      return shorten(telling ? told : said.join('; '), LINE_MAXIMUM);
    }
    const stoppedCount = turns.filter((turn) => turn.entry.engine.quickBooks !== undefined).length;
    return countLine([
      [turns.length, label],
      [stoppedCount, 'not recorded'],
    ]);
  };
}

const eligible = (entry: Entry, run: RunState, request: StepContext['request']) =>
  quickBooksRun(run, request) && forQuickBooks(entry);

/** The four lookup steps, each once per document. */
export function lookupSpecs(clock: Clock, how: ExpenseSearch): Record<string, FanOut> {
  return {
    'find-vendors': {
      eligible,
      turn: inTurn([findVendor(clock), findVendorCompany(clock), findSimilarVendors(clock)]),
      line: lineFor('vendors looked up', true),
    },
    'find-names': {
      eligible,
      turn: inTurn([findCustomerName(clock), findEmployeeName(clock)]),
      line: lineFor('names checked', true),
    },
    'find-duplicates': {
      eligible,
      turn: inTurn([findDuplicateNumber(clock, how), findDuplicateAmount(clock, how)]),
      line: lineFor('checked for duplicates'),
    },
    'find-related': {
      eligible,
      turn: inTurn([findRelated(clock, how), findOtherRecord(clock, how)]),
      line: lineFor('related records looked up'),
    },
  };
}
