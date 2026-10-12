import { addDays, cleanText, isWithin } from '@autom8x/automation-kit/values';

import type { Route } from '../document.js';
import type { DecideState, FoundRecord, JournalEntryRow } from './contract.js';

/**
 * The ONE duplicate rule — whether a record find-duplicate-number or find-duplicate-amount found
 * is the record decide plans — shared by decide (`matches.ts`), which holds on it ("possible
 * duplicate", the plan's §2.4), and by confirm-no-duplicate after an approval (§5), which fails on
 * a record it matches that the approver never saw: one function, so the two cannot disagree (the
 * design's open question on the re-check, its recommended answer applied: the owner's "complete
 * all" of 2026-10-11). It holds only the comparisons §2.4 lists for those two lookups, per path;
 * what is no duplicate — a receipt's bill (hold 6), a company charge (hold 7), an expense with a
 * bill's number, D32's other records — stays decide's alone.
 */

/** The bank-feed window (D21): from 1 day before the document's date to 20 days after it. */
export const FEED_WINDOW = { before: 1, after: 20 } as const;

/** A route that records something: every one but a statement's. */
export type RecordRoute = Exclude<Route, 'statement'>;

/** The lookups the rule weighs: find-duplicate-number's and find-duplicate-amount's. */
export type DuplicateLookup = 'numberLookup' | 'amountLookup';

/** What the rule compares a found record with: the planned record's facts, as decide read them. */
export interface DuplicateFacts {
  readonly route: RecordRoute;
  /** The document's own number, cleaned; null when none was read. */
  readonly number: string | null;
  /** What the record carries, a tip code added included. */
  readonly amountCents: number;
  readonly date: string;
  /** The vendor decide matched; null for a new vendor, so any vendor's record counts (D5). */
  readonly vendorId: string | null;
  /**
   * The account a matching record names: a company receipt's or a card refund's Paid from — none
   * set, no expense matches — or the account a person's journal entry credits — none, any.
   */
  readonly accountId: string | null;
  /** The employee a matching journal entry names; null for anyone (an owner, or no Id). */
  readonly employeeId: string | null;
}

const fold = (value: string | null) => cleanText(value)?.toLowerCase() ?? null;

/** The same number, cleaned, without case: Intuit compares without case. */
export function sameNumber(
  record: { readonly docNumber: string | null },
  number: string | null,
): boolean {
  const a = fold(record.docNumber);
  return a !== null && a === fold(number);
}

/** The D21 window around a date. */
export function inFeedWindow(date: string, around: string): boolean {
  return isWithin(date, addDays(around, -FEED_WINDOW.before), addDays(around, FEED_WINDOW.after));
}

/** A journal entry with a credit line of this amount, to this account and this person when named. */
export function creditsAmount(
  entry: JournalEntryRow,
  amountCents: number,
  accountId: string | null = null,
  employeeId: string | null = null,
): boolean {
  return entry.lines.some(
    (line) =>
      line.postingType === 'Credit' &&
      line.amountCents === amountCents &&
      (accountId === null || line.accountId === accountId) &&
      (employeeId === null || (line.entity?.type === 'Employee' && line.entity.id === employeeId)),
  );
}

/** decide's facts for the rule, from the state it reads; a statement has none. */
export function duplicateFactsOf(state: DecideState): DuplicateFacts {
  const { document, vendor, accounts, payer } = state;
  const route = document.route;
  if (route === 'statement') throw new Error('a statement is compared, never recorded');
  const person = route === 'employee' || route === 'owner';
  return {
    route,
    number: document.number,
    amountCents: document.amountCents ?? 0,
    date: document.date ?? '',
    vendorId: vendor?.status === 'matched' ? vendor.id : null,
    accountId:
      route === 'company_receipt' || route === 'card_refund'
        ? (accounts.paidFrom?.id ?? null)
        : person
          ? (payer?.account?.id ?? null)
          : null,
    employeeId: route === 'employee' ? (payer?.employeeId ?? null) : null,
  };
}

/** Whether `record`, which `lookup` found, duplicates the planned record (the plan's §2.4, per path). */
export function isDuplicate(
  facts: DuplicateFacts,
  lookup: DuplicateLookup,
  record: FoundRecord,
): boolean {
  const byNumber = lookup === 'numberLookup';
  const sameTotalAndDate = (found: { totalCents: number; txnDate: string }) =>
    found.totalCents === facts.amountCents && found.txnDate === facts.date;
  switch (facts.route) {
    case 'bill': {
      if (record.kind !== 'bill') return false;
      // The same vendor's bill; for a new vendor, any vendor's (D5).
      const vendor = facts.vendorId === null || record.vendorId === facts.vendorId;
      return vendor && (byNumber ? sameNumber(record, facts.number) : sameTotalAndDate(record));
    }
    case 'company_receipt':
    case 'card_refund': {
      const refund = facts.route === 'card_refund';
      // A receipt's number lookup finds its seller's bills — hold 6, not a duplicate; a refund's,
      // a vendor credit with its number.
      if (byNumber) {
        return refund && record.kind === 'vendor_credit' && sameNumber(record, facts.number);
      }
      // D21: the bank-feed check — a charge, or a refund, for this amount on the account, in the window.
      return (
        record.kind === 'expense' &&
        record.credit === refund &&
        record.accountId === facts.accountId &&
        record.totalCents === facts.amountCents &&
        inFeedWindow(record.txnDate, facts.date)
      );
    }
    case 'vendor_credit':
      // VendorRef cannot be searched on a vendor credit: compared here.
      return (
        record.kind === 'vendor_credit' &&
        record.vendorId === facts.vendorId &&
        (byNumber ? sameNumber(record, facts.number) : sameTotalAndDate(record))
      );
    case 'contractor':
      if (record.kind !== 'bill') return false;
      // A bill document's number, any vendor's; a bill to them for this total and date.
      return byNumber
        ? sameNumber(record, facts.number)
        : record.vendorId === facts.vendorId && sameTotalAndDate(record);
    case 'employee':
    case 'owner':
      if (byNumber) return record.kind === 'bill' && sameNumber(record, facts.number);
      // An entry on that date owing the same person the same amount: lines compared, TotalAmt is 0.
      return (
        record.kind === 'journal_entry' &&
        record.txnDate === facts.date &&
        creditsAmount(record, facts.amountCents, facts.accountId, facts.employeeId)
      );
  }
}
