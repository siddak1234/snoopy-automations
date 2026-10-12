import type { TransactionEntity } from '@autom8x/automation-kit/quickbooks';

import { EXPENSE_SEARCH, type ExpenseSearch } from '../lookups/expense-search.js';
import { recheckSearch } from '../lookups/queries.js';
import type { DecideState } from './contract.js';
import {
  duplicateFactsOf,
  type DuplicateFacts,
  type DuplicateLookup,
  type RecordRoute,
} from './duplicate-rule.js';

/**
 * What confirm-no-duplicate repeats after an approval (the plan's §5, "repeats each path's
 * duplicate lookup"): ONE query, as every step makes one QuickBooks call, so each path's own —
 *
 * - a bill and a vendor credit: by the document's number when QuickBooks could hold it (1–21
 *   characters), else by its total and date, as the design's re-check of a bill chose;
 * - a company receipt and a card refund: the bank-feed check (D21), the charge most likely to
 *   arrive while a run waits — "possibly from your bank feed";
 * - an employee and an owner: the day's journal entries; a contractor: the bills to them for the
 *   total and date —
 *
 * the very search decide's lookup step sent, one row more, and the facts the one rule
 * (`duplicate-rule.ts`) compares. Built by decide and saved with the plan, so the re-check reads
 * nothing else: not the settings, not the document.
 */
export interface Recheck {
  readonly lookup: DuplicateLookup;
  readonly entity: TransactionEntity;
  readonly query: string;
  readonly maxResults: number;
  readonly facts: DuplicateFacts;
}

/** The lookup a path's re-check repeats. */
export function recheckLookup(route: RecordRoute, numberUsable: boolean): DuplicateLookup {
  return (route === 'bill' || route === 'vendor_credit') && numberUsable
    ? 'numberLookup'
    : 'amountLookup';
}

export function recheckOf(
  state: DecideState,
  expenseSearch: ExpenseSearch = EXPENSE_SEARCH,
): Recheck {
  const facts = duplicateFactsOf(state);
  const lookup = recheckLookup(facts.route, state.document.numberUsable);
  const search = recheckSearch(lookup, state.document, state.vendor, expenseSearch);
  return {
    lookup,
    entity: search.entity,
    query: search.query,
    maxResults: search.maxResults,
    facts,
  };
}
