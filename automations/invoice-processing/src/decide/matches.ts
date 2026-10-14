import { addDays, isWithin } from '@autom8x/automation-kit/values';

import type { BillRow, DecideState, FoundRecord, LookupState } from './contract.js';
import {
  FEED_WINDOW,
  creditsAmount,
  duplicateFactsOf,
  inFeedWindow,
  isDuplicate,
  sameNumber,
  type DuplicateLookup,
} from './duplicate-rule.js';

/**
 * What the lookups found, compared in code as the plan leaves to it (§2.4 "Possible duplicate, per
 * type", hold 6, hold 7, §5): the vendor, the account, the window, a journal entry's lines. What
 * find-duplicate-number and find-duplicate-amount found is weighed by the one rule
 * (`duplicate-rule.ts`) that confirm-no-duplicate repeats after an approval.
 */

export { FEED_WINDOW };

/** A bill the receipt may pay (hold 6, D22). */
export interface MatchedBill {
  readonly docNumber: string | null;
  readonly paid: boolean;
  /** Its total is the receipt's amount: "for this amount". */
  readonly sameAmount: boolean;
}

export interface Matches {
  /** Why a possible duplicate (hold 4), each in words for decide's line; empty when none. */
  readonly duplicates: readonly string[];
  /** A company receipt's bill from the same seller, open or paid (hold 6). */
  readonly matchedBill: MatchedBill | null;
  /**
   * The bank or card charges for this amount on the account a receipt or a refund is paid from, in
   * the bank-feed window (D21): "a bank or card charge matches" (hold 7's words, §2.6).
   */
  readonly companyCharges: number;
  /** The document's number is already another record's of the kind it would be sent on. */
  readonly numberTaken: boolean;
  /** Every record any lookup returned, by kind: kept for the after-approval re-check. */
  readonly seen: {
    readonly billIds: readonly string[];
    readonly expenseIds: readonly string[];
    readonly vendorCreditIds: readonly string[];
    readonly journalEntryIds: readonly string[];
  };
}

function rows<K extends FoundRecord['kind']>(
  lookup: LookupState | null,
  kind: K,
): Extract<FoundRecord, { kind: K }>[] {
  return (lookup?.records ?? []).filter(
    (record): record is Extract<FoundRecord, { kind: K }> => record.kind === kind,
  );
}

/** The bill a company receipt may pay: an open one first, then one already paid (D22). */
function billPaidBy(candidates: readonly BillRow[], amountCents: number): MatchedBill | null {
  const ordered = [...candidates].sort(
    (a, b) => Number(a.balanceCents === 0) - Number(b.balanceCents === 0),
  );
  const [bill] = ordered;
  if (!bill) return null;
  return {
    docNumber: bill.docNumber,
    paid: bill.balanceCents === 0,
    sameAmount: bill.totalCents === amountCents,
  };
}

export function matchesOf(state: DecideState): Matches {
  const { document, vendor } = state;
  const { numberLookup, amountLookup, relatedLookup, otherRecordLookup } = state;
  const amount = document.amountCents ?? 0;
  const date = document.date ?? '';
  const number = document.number;
  const vendorId = vendor.status === 'matched' ? vendor.id : null;
  const duplicates: string[] = [];
  let matchedBill: MatchedBill | null = null;
  let companyCharges = 0;
  let numberTaken = false;
  const note = (found: boolean, words: string) => {
    if (found && !duplicates.includes(words)) duplicates.push(words);
  };
  const facts = document.route === 'statement' ? null : duplicateFactsOf(state);
  /** The records the lookup found that the one rule calls duplicates of the planned record. */
  const duplicatesIn = (lookup: DuplicateLookup) =>
    facts === null
      ? []
      : (state[lookup]?.records ?? []).filter((record) => isDuplicate(facts, lookup, record));
  const found = (lookup: DuplicateLookup) => duplicatesIn(lookup).length > 0;

  switch (document.route) {
    case 'bill': {
      numberTaken = rows(numberLookup, 'bill').some((bill) => sameNumber(bill, number));
      // The same vendor's bill with this number; for a new vendor, any bill with it (D5).
      note(found('numberLookup'), 'a bill with this number');
      note(found('amountLookup'), 'a bill for this total and date');
      note(
        rows(relatedLookup, 'expense').some((expense) => sameNumber(expense, number)),
        'an expense with this number',
      );
      // D32: a receipt or a feed charge recorded before the bill arrived.
      const until = addDays(document.dueDate ?? date, FEED_WINDOW.after);
      note(
        rows(otherRecordLookup, 'expense').some(
          (expense) =>
            !expense.credit &&
            expense.totalCents === amount &&
            isWithin(expense.txnDate, addDays(date, -1), until),
        ),
        'an expense for this amount',
      );
      break;
    }
    case 'company_receipt': {
      // A bill from this seller with this number or for this amount, open or paid (hold 6).
      const sellers = [
        ...rows(numberLookup, 'bill').filter(
          (bill) => bill.vendorId === vendorId && sameNumber(bill, number),
        ),
        ...rows(relatedLookup, 'bill').filter(
          (bill) => vendorId !== null && bill.vendorId === vendorId && bill.totalCents === amount,
        ),
      ];
      matchedBill = billPaidBy(sellers, amount);
      note(
        rows(relatedLookup, 'bill').some(
          (bill) =>
            bill.vendorId !== vendorId &&
            bill.totalCents === amount &&
            inFeedWindow(bill.txnDate, date),
        ),
        "another vendor's bill for this amount",
      );
      // D21: the bank-feed check on the account it is paid from.
      companyCharges = duplicatesIn('amountLookup').length;
      // D32: someone's reimbursement for the same purchase.
      note(
        rows(otherRecordLookup, 'journal_entry').some(
          (entry) => inFeedWindow(entry.txnDate, date) && creditsAmount(entry, amount),
        ),
        'a reimbursement for this amount',
      );
      break;
    }
    case 'card_refund':
      note(found('numberLookup'), 'a vendor credit with this number');
      // D21: a refund for this amount on the card.
      companyCharges = duplicatesIn('amountLookup').length;
      break;
    case 'vendor_credit':
      numberTaken = rows(numberLookup, 'vendor_credit').some((credit) =>
        sameNumber(credit, number),
      );
      note(found('numberLookup'), 'a vendor credit with this number');
      note(found('amountLookup'), 'a vendor credit for this total and date');
      break;
    case 'statement':
      break;
  }
  const lookups = [numberLookup, amountLookup, relatedLookup, otherRecordLookup];
  if (document.route !== 'statement' && lookups.some((lookup) => lookup?.reachedMax === true)) {
    // D6: more may be unseen, the same vendor's among them.
    note(true, 'too many to check');
  }
  const all = lookups.flatMap((lookup) => lookup?.records ?? []);
  const ids = <K extends FoundRecord['kind']>(kind: K) => [
    ...new Set(all.filter((record) => record.kind === kind).map((record) => record.id)),
  ];
  return {
    duplicates,
    matchedBill,
    companyCharges,
    numberTaken,
    seen: {
      billIds: ids('bill'),
      expenseIds: ids('expense'),
      vendorCreditIds: ids('vendor_credit'),
      journalEntryIds: ids('journal_entry'),
    },
  };
}

/** The account a credit note reduces: the original bill's, when that bill used one account (D25). */
export function originalBillAccount(
  state: DecideState,
): { id: string; name: string; billId: string } | null {
  const { document, vendor, relatedLookup } = state;
  if (document.originalInvoiceNumber === null) return null;
  const vendorId = vendor.status === 'matched' ? vendor.id : null;
  const bills = rows(relatedLookup, 'bill').filter(
    (bill) => bill.vendorId === vendorId && sameNumber(bill, document.originalInvoiceNumber),
  );
  if (bills.length !== 1) return null;
  const [bill] = bills as [BillRow];
  const accounts = new Map(bill.lineAccounts.map((account) => [account.id, account.name]));
  if (accounts.size !== 1) return null;
  const [[id, name]] = [...accounts] as [[string, string]];
  return { id, name, billId: bill.id };
}
