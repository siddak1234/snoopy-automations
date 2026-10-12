import type { TransactionEntity } from '@autom8x/automation-kit/quickbooks';
import type { JsonObject } from '@autom8x/automation-sdk';

import { EXPENSE_SEARCH, type ExpenseSearch } from '../lookups/expense-search.js';
import { recheckSearch } from '../lookups/queries.js';
import { createdAtOf, instantOf } from '../lookups/records.js';
import type { DecideState } from './contract.js';
import {
  duplicateFactsOf,
  type DuplicateFacts,
  type DuplicateLookup,
  type RecordRoute,
} from './duplicate-rule.js';
import type { RecordPlan } from './plan.js';

/**
 * What confirm-no-duplicate repeats after an approval (the plan's §5, "repeats each path's
 * duplicate lookup"): ONE query, as every step makes one QuickBooks call, so each path's own —
 *
 * - a bill and a vendor credit: by the document's number only when the record will carry it — the
 *   plan sends it as `DocNumber`: a bill's when no bill in QuickBooks has it yet, a credit's only
 *   with own numbers on — else by its total and date, as the design's re-check of a bill chose. A
 *   number kept in the memo is on no record this automation makes (and with own numbers off
 *   QuickBooks numbers a credit itself, Intuit's model), so a search by it could never find a copy
 *   of this record: two uploads of one credit note, both approved, would make two;
 * - a company receipt and a card refund: the bank-feed check (D21), the charge most likely to
 *   arrive while a run waits — "possibly from your bank feed";
 * - an employee and an owner: the day's journal entries; a contractor: the bills to them for the
 *   total and date —
 *
 * the very search decide's lookup step sent, one row more and ordered by when QuickBooks created
 * each record, newest first (`ORDERBY MetaData.CreateTime DESC`, which Intuit applies before the
 * bound: sandbox G4–5 and the verifier's probe) — so a copy made while the run waited is never
 * hidden behind older matches past the bound — and the facts the one rule (`duplicate-rule.ts`)
 * compares. Built by decide and saved with the plan, so the re-check reads nothing else: not the
 * settings, not the document.
 */
export interface Recheck {
  readonly lookup: DuplicateLookup;
  readonly entity: TransactionEntity;
  readonly query: string;
  readonly maxResults: number;
  /**
   * When decide's lookup was full — more rows than it showed, "too many to check" — QuickBooks'
   * time on that answer: a matching record QuickBooks created before it was already there, past
   * the bound, and the approver approved it unseen. Null when the lookup was not full, or gave no
   * time: then every matching record the approver did not see counts as added while this waited.
   */
  readonly fullAt: string | null;
  readonly facts: DuplicateFacts;
}

/** The lookup a path's re-check repeats: by number only when the record will carry the number. */
export function recheckLookup(route: RecordRoute, carriesNumber: boolean): DuplicateLookup {
  return (route === 'bill' || route === 'vendor_credit') && carriesNumber
    ? 'numberLookup'
    : 'amountLookup';
}

export function recheckOf(
  state: DecideState,
  plan: RecordPlan,
  expenseSearch: ExpenseSearch = EXPENSE_SEARCH,
): Recheck {
  const facts = duplicateFactsOf(state);
  const lookup = recheckLookup(facts.route, plan.docNumber !== null);
  const search = recheckSearch(lookup, state.document, state.vendor, expenseSearch);
  const decided = state[lookup];
  return {
    lookup,
    entity: search.entity,
    query: search.query,
    maxResults: search.maxResults,
    fullAt: decided?.reachedMax === true ? (decided.answeredAt ?? null) : null,
    facts,
  };
}

/**
 * Whether QuickBooks created a row the re-check found before decide's full lookup answered
 * (`fullAt`), by its own clock: `MetaData.CreateTime`, which keeps whole seconds, before the second
 * that answer came in — a record made in that same second counts as new. Unknown either way is not
 * before, so an unseen match fails: the safe side.
 */
export function createdBefore(row: JsonObject | undefined, fullAt: string | null): boolean {
  const answered = instantOf(fullAt);
  const created = row === undefined ? undefined : createdAtOf(row);
  if (answered === undefined || created === undefined) return false;
  return created < Math.floor(answered / 1000) * 1000;
}
