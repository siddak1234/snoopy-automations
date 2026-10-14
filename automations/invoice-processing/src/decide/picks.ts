import type { ChartAccount, ChartState } from '../chart.js';
import type { SpendType } from '../spend-types.js';
import type { DocumentState } from '../state.js';

/**
 * The accounts decide picks from the company's chart (v2's §2.5; the platform's BUILD-PLAN
 * 25.4.19 and 25.4.20): no setting names one, and no setting can fail a run — a pick, a fallback,
 * a wait for approval showing the pick, or, when the company has no account that could take the
 * record, "not recorded in QuickBooks" with the details saved.
 */

/** The spend types an account is picked by: every one but `other`, which is Uncategorized Expense. */
export type PickedSpendType = Exclude<SpendType, 'other'>;

/**
 * The names an account may carry for each spend type, in the order they are tried — the spec's
 * S12 lists, each already normalized (`normalizedName`).
 */
export const CATEGORY_NAMES: Readonly<Record<PickedSpendType, readonly string[]>> = {
  meals: [
    'meals',
    'meals and entertainment',
    'business meals',
    'travel meals',
    'entertainment meals',
  ],
  travel: ['travel', 'travel expenses', 'travel expense', 'airfare', 'hotels'],
  vehicle_and_fuel: [
    'vehicle expenses',
    'car and truck',
    'auto',
    'automobile',
    'automobile expense',
    'vehicle',
    'fuel',
    'gas and fuel',
    'parking and tolls',
  ],
  office_supplies: [
    'office supplies',
    'office expenses',
    'office supplies and software',
    'supplies',
  ],
  software_and_subscriptions: [
    'software and apps',
    'software',
    'subscriptions',
    'dues and subscriptions',
    'memberships and subscriptions',
    'office supplies and software',
  ],
  utilities_and_phone: [
    'utilities',
    'phone service',
    'phone',
    'telephone',
    'telephone expense',
    'internet and tv services',
    'phone and internet',
  ],
  rent: ['rent', 'rent and lease', 'rent or lease', 'rent expense'],
  repairs_and_maintenance: [
    'repairs and maintenance',
    'repair and maintenance',
    'repairs',
    'maintenance and repairs',
  ],
  professional_services: [
    'legal and accounting services',
    'legal and professional services',
    'legal and professional fees',
    'professional fees',
    'accounting fees',
    'legal fees',
    'contract labor',
    'contractors',
  ],
  materials: ['supplies and materials', 'materials', 'job supplies'],
  advertising: [
    'advertising and marketing',
    'advertising',
    'marketing',
    'advertising and promotion',
  ],
};

/**
 * Each spend type's detail types, Intuit's `AccountSubType` names, tried in order when no name
 * picks (checked against Intuit's AccountSubTypeEnum).
 */
export const DETAIL_TYPES: Readonly<Record<PickedSpendType, readonly string[]>> = {
  meals: ['EntertainmentMeals', 'TravelMeals'],
  travel: ['Travel'],
  vehicle_and_fuel: ['Auto'],
  office_supplies: ['OfficeGeneralAdministrativeExpenses'],
  software_and_subscriptions: ['DuesSubscriptions'],
  utilities_and_phone: ['Utilities'],
  rent: ['RentOrLeaseOfBuildings'],
  repairs_and_maintenance: ['RepairMaintenance'],
  professional_services: ['LegalProfessionalFees'],
  materials: ['SuppliesMaterials', 'SuppliesMaterialsCogs'],
  advertising: ['AdvertisingPromotional'],
};

/**
 * A name as the lists compare it: lowercase; `&` is `and`; every character not a letter or a digit
 * a space; runs of spaces one; trimmed — "Car & Truck" is `car and truck`.
 */
export function normalizedName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll('&', 'and')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Why a category was picked, kept with the plan and in the run's output. */
export type CategoryWhy =
  'the original bill used it' | 'its name' | 'its detail type' | 'uncategorized';

export type CategoryPick =
  | { readonly kind: 'picked'; readonly account: ChartAccount; readonly why: CategoryWhy }
  /** No account could take it, not even Uncategorized Expense: not recorded (§2.6). */
  | { readonly kind: 'none' };

/** The one account of `accounts` that `matches`, or undefined when none or several do. */
function onlyOne(
  accounts: readonly ChartAccount[],
  matches: (account: ChartAccount) => boolean,
): ChartAccount | undefined {
  const found = accounts.filter(matches);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The category for a document's spend type — the original bill's account comes first, for a
 * credit, in decide (D25): (1) the first of the spend type's names that exactly one category
 * account's own name is, normalized (several with one name: the next name is tried); (2) else the
 * one category account of its detail type, each tried in order; (3) else Uncategorized Expense —
 * also for `other` and for a spend type unclear or disputed by the two reads; (4) else none.
 */
export function pickCategory(
  chart: ChartState,
  spendType: SpendType,
  uncertain: boolean,
): CategoryPick {
  const uncategorized = (): CategoryPick =>
    chart.uncategorized === null
      ? { kind: 'none' }
      : { kind: 'picked', account: chart.uncategorized, why: 'uncategorized' };
  if (uncertain || spendType === 'other') return uncategorized();
  for (const name of CATEGORY_NAMES[spendType]) {
    const account = onlyOne(chart.categories, (each) => normalizedName(each.name) === name);
    if (account) return { kind: 'picked', account, why: 'its name' };
  }
  for (const detailType of DETAIL_TYPES[spendType]) {
    const account = onlyOne(chart.categories, (each) => each.detailType === detailType);
    if (account) return { kind: 'picked', account, why: 'its detail type' };
  }
  return uncategorized();
}

export type PaidFromPick =
  | { readonly kind: 'picked'; readonly account: ChartAccount }
  /** Several could, and no rule picks: wait for approval, showing this one (S11). */
  | { readonly kind: 'ask'; readonly account: ChartAccount }
  /** None could: not recorded (§2.6). */
  | { readonly kind: 'none'; readonly reason: 'no_paying_account' | 'refund_needs_card' };

/** Whether a name holds the printed last four digits as a number of their own: "Visa 4417". */
export function namesDigits(name: string, last4: string): boolean {
  return new RegExp(`(?<!\\d)${last4}(?!\\d)`, 'u').test(name);
}

/** Accounts by full name, A to Z (S11): the one an approval shows when several could pay. */
export function firstByName(accounts: readonly ChartAccount[]): ChartAccount | undefined {
  return [...accounts].sort((a, b) => {
    const [x, y] = [a.fullName.toLowerCase(), b.fullName.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/**
 * What a receipt or a card refund was paid from (the session's decision 1, approved in advance):
 * paid by card — a refund always is — (a) the one card account whose name or full name holds the
 * printed last four digits, (b) else the only card account; otherwise, and for a card receipt when
 * the company has no card account, (c) the only bank account. Several could and no rule picks:
 * ask, showing the first by full name. None could: not recorded — a refund only ever from a card.
 */
export function pickPaidFrom(
  chart: ChartState,
  document: Pick<DocumentState, 'route' | 'paymentMethod' | 'cardLast4'>,
): PaidFromPick {
  const refund = document.route === 'card_refund';
  const { cards, banks } = chart;
  const ask = (accounts: readonly ChartAccount[]): PaidFromPick | undefined => {
    const first = firstByName(accounts);
    return first ? { kind: 'ask', account: first } : undefined;
  };
  if (refund || (document.paymentMethod === 'card' && cards.length > 0)) {
    const last4 = document.cardLast4;
    const byDigits =
      last4 === null
        ? undefined
        : onlyOne(
            cards,
            (card) => namesDigits(card.name, last4) || namesDigits(card.fullName, last4),
          );
    const picked = byDigits ?? (cards.length === 1 ? cards[0] : undefined);
    if (picked) return { kind: 'picked', account: picked };
    return ask(cards) ?? { kind: 'none', reason: 'refund_needs_card' };
  }
  if (banks.length === 1) return { kind: 'picked', account: banks[0]! };
  return ask(banks) ?? ask(cards) ?? { kind: 'none', reason: 'no_paying_account' };
}
