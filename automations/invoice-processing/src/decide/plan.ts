import { CATEGORY_SETTINGS } from '../spend-types.js';
import type { DecideState } from './contract.js';
import { newVendorName } from './fails.js';
import { originalBillAccount, type Matches } from './matches.js';

/**
 * The record decide plans, built once, saved for after approval, and written exactly as it is
 * (the plan's §2.6 and §2.8): the operation, the payment type, the accounts by role, the payee,
 * the amount, the date, the memo, the number or none, and the currency rule. Approval writes from
 * this plan, never from the settings as they are by then.
 */

/** An account as the plan names it. */
export interface PlannedAccount {
  readonly id: string;
  readonly name: string;
}

/** The category used (D27) and why, for the line every approval shows. */
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
  | { readonly kind: 'employee'; readonly id: string; readonly name: string }
  | { readonly kind: 'owner'; readonly name: string }
  | { readonly kind: 'none' };

export interface RecordPlan {
  readonly operation:
    'bill.create' | 'purchase.create' | 'vendorCredit.create' | 'journalEntry.create';
  readonly record: 'bill' | 'expense' | 'card_refund' | 'vendor_credit' | 'journal_entry';
  /** An expense's: CreditCard from a card account; from a bank account Check for a check, else Cash. */
  readonly paymentType: 'Cash' | 'Check' | 'CreditCard' | null;
  /** A card refund: an expense with `Credit` true. */
  readonly credit: boolean;
  /** A check expense is sent with print status NotSet; QuickBooks' default is NeedToPrint (sandbox S8). */
  readonly printStatus: 'NotSet' | null;
  readonly accounts: {
    readonly category: CategoryChoice;
    readonly paidFrom: PlannedAccount | null;
    /** "Owed to team members": an employee's journal entry credits it. */
    readonly liability: PlannedAccount | null;
    /** The owner's own account, or "Owner's investment account". */
    readonly equity: PlannedAccount | null;
  };
  readonly payee: Payee;
  /** With any tip code added. */
  readonly amountCents: number;
  readonly date: string;
  readonly dueDate: string | null;
  /** The number QuickBooks is sent as the record's own; null keeps it in the memo. */
  readonly docNumber: string | null;
  readonly memo: string;
  readonly lineDescription: string;
  /** CurrencyRef USD when multicurrency is on (sandbox S13). */
  readonly currencyRef: 'USD' | null;
}

const account = (ref: { id: string; fullyQualifiedName: string }): PlannedAccount => ({
  id: ref.id,
  name: ref.fullyQualifiedName,
});

/** The category (D27): the original bill's for a credit, else the spend type's setting, else the default. */
export function categoryOf(state: DecideState): CategoryChoice {
  const { document, accounts, verification } = state;
  const fallback = (why: string): CategoryChoice => ({ ...account(accounts.defaultCategory), why });
  if (document.type === 'credit_note') {
    const original = originalBillAccount(state);
    if (original) return { id: original.id, name: original.name, why: 'the original bill used it' };
  }
  if (document.spendTypeUnclear) return fallback('spend type unclear');
  if (verification.status === 'made' && verification.spendTypeDisputed) {
    return fallback('the reads disagree on the spend type');
  }
  if (document.spendType === 'other') return fallback('spend type other');
  const setting = CATEGORY_SETTINGS.find((each) => each.spendType === document.spendType);
  const mapped = accounts.categories[document.spendType];
  const words = setting?.title.replace('Category for ', '') ?? document.spendType;
  return mapped ? { ...account(mapped), why: words } : fallback(`no category set for ${words}`);
}

const TYPE_WORDS = {
  bill: 'bill',
  receipt: 'receipt',
  credit_note: 'credit note',
  supplier_statement: 'statement',
} as const;

/** The plan for a record that is written; a statement has none. */
export function recordPlan(state: DecideState, runId: string, matches: Matches): RecordPlan {
  const { document, accounts, vendor, payer, preferences } = state;
  const route = document.route;
  const typeWords = TYPE_WORDS[document.type];
  const number = document.number;
  const seller = document.seller;
  const what = number === null ? typeWords : `${typeWords} ${number}`;
  const category = categoryOf(state);
  const paidFrom = accounts.paidFrom ? account(accounts.paidFrom) : null;
  const card = accounts.paidFrom?.accountType === 'Credit Card';
  const vendorPayee: Payee =
    vendor?.status === 'matched'
      ? { kind: 'vendor', id: vendor.id, name: vendor.displayName }
      : { kind: 'none' };
  const created = `Created by Autom8x Bills & Receipts, run ${runId}.`;
  const base = {
    credit: false,
    printStatus: null,
    amountCents: document.amountCents ?? 0,
    date: document.date ?? '',
    dueDate: null,
    docNumber: null,
    currencyRef: preferences.multiCurrencyEnabled ? ('USD' as const) : null,
    accounts: { category, paidFrom: null, liability: null, equity: null },
  };
  switch (route) {
    case 'bill': {
      const sent = document.numberUsable && !matches.numberTaken ? number : null;
      const fresh = newVendorName(state);
      const payee: Payee =
        vendor?.status === 'new'
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
        memo: number !== null && sent === null ? `${created} Number ${number}.` : created,
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
        memo: `${created} ${words} from ${seller}.`,
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
        memo: [created, ...notes].join(' '),
        lineDescription: `${number === null ? 'Credit note' : `Credit note ${number}`} from ${vendorPayee.kind === 'vendor' ? vendorPayee.name : seller}`,
      };
    }
    case 'employee':
    case 'owner':
    case 'contractor': {
      const name = payer?.name ?? '';
      const paid = `${name} paid ${seller}, ${what}`;
      if (route === 'contractor') {
        return {
          ...base,
          operation: 'bill.create',
          record: 'bill',
          paymentType: null,
          payee: vendorPayee,
          memo: `${created} ${paid}.`,
          lineDescription: `${seller}, ${what}`,
        };
      }
      const owed = payer?.account ? account(payer.account) : null;
      return {
        ...base,
        operation: 'journalEntry.create',
        record: 'journal_entry',
        paymentType: null,
        accounts: {
          ...base.accounts,
          liability: route === 'employee' ? owed : null,
          equity: route === 'owner' ? owed : null,
        },
        payee:
          route === 'employee'
            ? { kind: 'employee', id: payer?.employeeId ?? '', name }
            : { kind: 'owner', name },
        memo: `${created} ${paid}.`,
        lineDescription: route === 'owner' ? paid : `${seller}, ${what}`,
      };
    }
    case 'statement':
      throw new Error('a statement is compared, never recorded');
  }
}
