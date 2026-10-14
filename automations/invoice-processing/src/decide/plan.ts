import type { NotRecordedReason } from '../quickbooks-path.js';
import type { DecideState } from './contract.js';
import { newVendorName } from './fails.js';
import { originalBillAccount, type Matches } from './matches.js';
import { pickCategory } from './picks.js';

/**
 * The record decide plans, built once, saved for after approval, and written exactly as it is
 * (the plan's §2.6 and §2.8): the operation, the payment type, the accounts — picked from the
 * company's chart, never from a setting (v2's §2.5) — the payee, the amount, the date, the memo,
 * the number or none, and the currency rule. Approval writes from this plan (create-record,
 * `src/writes/bodies.ts`). The one thing the write adds is the run that writes it, first in the
 * memo — after an approval the continuation's id, the run whose timeline shows the record.
 */

/** An account as the plan names it. */
export interface PlannedAccount {
  readonly id: string;
  /** Its full name, as QuickBooks shows it. */
  readonly name: string;
}

/** The category used (§2.5) and why, kept in the run's output. */
export interface CategoryChoice extends PlannedAccount {
  readonly why: string;
}

export type Payee =
  | { readonly kind: 'vendor'; readonly id: string; readonly name: string }
  | {
      readonly kind: 'new_vendor';
      readonly name: string;
      readonly printedName: string;
      readonly nameInUseBy: 'customer' | 'employee' | null;
    }
  | { readonly kind: 'none' };

export interface RecordPlan {
  readonly operation: 'bill.create' | 'purchase.create' | 'vendorCredit.create';
  readonly record: 'bill' | 'expense' | 'card_refund' | 'vendor_credit';
  /** An expense's: CreditCard from a card account; from a bank account Check for a check, else Cash. */
  readonly paymentType: 'Cash' | 'Check' | 'CreditCard' | null;
  /** A card refund: an expense with `Credit` true. */
  readonly credit: boolean;
  /** A check expense is sent with print status NotSet, said rather than left to QuickBooks, whose own default was NotSet too (sandbox S8). */
  readonly printStatus: 'NotSet' | null;
  readonly accounts: {
    readonly category: CategoryChoice;
    /** What a receipt or a refund was paid from (decision 1); null on a bill or a vendor credit. */
    readonly paidFrom: PlannedAccount | null;
  };
  readonly payee: Payee;
  /** With any tip code added. */
  readonly amountCents: number;
  readonly date: string;
  readonly dueDate: string | null;
  /** The number QuickBooks is sent as the record's own; null keeps it in the memo. */
  readonly docNumber: string | null;
  /**
   * The memo's words after the sentence naming the run that writes it ("Created by Autom8x Invoice
   * Processing, run <id>.", which create-record puts first); empty when nothing follows it.
   */
  readonly memo: string;
  readonly lineDescription: string;
  /** CurrencyRef USD when multicurrency is on (sandbox S13). */
  readonly currencyRef: 'USD' | null;
}

/** The plan, or why QuickBooks cannot take the record: the company has no account it could use. */
export type Planned =
  | { readonly kind: 'plan'; readonly plan: RecordPlan }
  | { readonly kind: 'not_recordable'; readonly reason: NotRecordedReason };

/**
 * The category (§2.5): for a credit, the original bill's account (D25); else the account picked
 * for the spend type from the chart — by name, by detail type, else Uncategorized Expense, which
 * also takes `other` and a spend type unclear or disputed by the two reads. None at all: undefined.
 */
export function categoryOf(state: DecideState): CategoryChoice | undefined {
  const { document, verification, chart } = state;
  if (document.type === 'credit_note') {
    const original = originalBillAccount(state);
    if (original) return { id: original.id, name: original.name, why: 'the original bill used it' };
  }
  const disputed = verification.status === 'made' && verification.spendTypeDisputed;
  const pick = pickCategory(chart, document.spendType, document.spendTypeUnclear || disputed);
  return pick.kind === 'picked'
    ? { id: pick.account.id, name: pick.account.fullName, why: pick.why }
    : undefined;
}

const TYPE_WORDS = {
  bill: 'bill',
  receipt: 'receipt',
  credit_note: 'credit note',
  supplier_statement: 'statement',
} as const;

export function recordPlan(state: DecideState, matches: Matches): Planned {
  const { document, vendor, preferences } = state;
  const route = document.route;
  const typeWords = TYPE_WORDS[document.type];
  const number = document.number;
  const seller = document.seller;
  const what = number === null ? typeWords : `${typeWords} ${number}`;
  const category = categoryOf(state);
  if (category === undefined) return { kind: 'not_recordable', reason: 'no_uncategorized' };
  const pick = state.paidFrom;
  if (pick?.kind === 'none') return { kind: 'not_recordable', reason: pick.reason };
  const paidFrom = pick === null ? null : { id: pick.account.id, name: pick.account.fullName };
  const card = pick !== null && pick.account.type === 'Credit Card';
  const vendorPayee: Payee =
    vendor.status === 'matched'
      ? { kind: 'vendor', id: vendor.id, name: vendor.displayName }
      : { kind: 'none' };
  const base = {
    credit: false,
    printStatus: null,
    amountCents: document.amountCents ?? 0,
    date: document.date ?? '',
    dueDate: null,
    docNumber: null,
    currencyRef: preferences.multiCurrencyEnabled ? ('USD' as const) : null,
    accounts: { category, paidFrom: null },
  };
  const plan = ((): RecordPlan => {
    switch (route) {
      case 'bill': {
        const sent = document.numberUsable && !matches.numberTaken ? number : null;
        const fresh = newVendorName(state);
        const payee: Payee =
          vendor.status === 'new'
            ? {
                kind: 'new_vendor',
                name: fresh.name,
                printedName: seller,
                nameInUseBy: fresh.inUseBy,
              }
            : vendorPayee;
        const name = payee.kind === 'none' ? seller : payee.name;
        return {
          ...base,
          operation: 'bill.create',
          record: 'bill',
          paymentType: null,
          payee,
          dueDate: document.dueDate,
          docNumber: sent,
          memo: number !== null && sent === null ? `Number ${number}.` : '',
          lineDescription: `${number === null ? 'Bill' : `Bill ${number}`} from ${name}`,
        };
      }
      case 'company_receipt':
      case 'card_refund': {
        const refund = route === 'card_refund';
        const paymentType = card
          ? 'CreditCard'
          : document.paymentMethod === 'check'
            ? 'Check'
            : 'Cash';
        const words = refund
          ? number === null
            ? 'Refund'
            : `Refund ${number}`
          : `${what[0]!.toUpperCase()}${what.slice(1)}`;
        return {
          ...base,
          operation: 'purchase.create',
          record: refund ? 'card_refund' : 'expense',
          paymentType,
          credit: refund,
          printStatus: paymentType === 'Check' ? 'NotSet' : null,
          accounts: { ...base.accounts, paidFrom },
          payee: vendorPayee,
          memo: `${words} from ${seller}.`,
          lineDescription: `${words} from ${seller}`,
        };
      }
      case 'vendor_credit': {
        const sent =
          document.numberUsable &&
          !matches.numberTaken &&
          preferences.purchaseCustomTxnNumbers === true
            ? number
            : null;
        const notes = [
          ...(number !== null && sent === null ? [`Number ${number}.`] : []),
          ...(document.originalInvoiceNumber === null
            ? []
            : [`Credits invoice ${document.originalInvoiceNumber}.`]),
        ];
        return {
          ...base,
          operation: 'vendorCredit.create',
          record: 'vendor_credit',
          paymentType: null,
          payee: vendorPayee,
          docNumber: sent,
          memo: notes.join(' '),
          lineDescription: `${number === null ? 'Credit note' : `Credit note ${number}`} from ${vendorPayee.kind === 'vendor' ? vendorPayee.name : seller}`,
        };
      }
      case 'statement':
        throw new Error('a statement is compared, never recorded');
    }
  })();
  return { kind: 'plan', plan };
}
