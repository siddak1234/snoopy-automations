import { CATEGORY_SETTINGS, type SpendType } from './spend-types.js';

/**
 * The flow's account settings — each a QuickBooks account typed as text — and the kind of
 * account each role must be (the owner's plan of 2026-10-11, §3 and D14, D15, D18, D27).
 * `find-accounts` resolves them all in one query; a setting filled in that does not resolve
 * stops the run there, before any model call (A1).
 */

/** What an account is for, which decides the kinds it may be. */
export type AccountRole = 'category' | 'paidFrom' | 'teamOwed' | 'ownerEquity';

export interface AccountSetting {
  readonly key: string;
  readonly title: string;
  readonly role: AccountRole;
  /** A category setting's spend type; none for the default category. */
  readonly spendType?: Exclude<SpendType, 'other'>;
}

/** The one required account setting: used whenever no category below applies. */
export const DEFAULT_CATEGORY: AccountSetting = {
  key: 'expenseAccount',
  title: 'Default category',
  role: 'category',
};

/** Every account setting but the owners' own accounts, in the manifest's order. */
export const ACCOUNT_SETTINGS: readonly AccountSetting[] = [
  DEFAULT_CATEGORY,
  { key: 'paidFromAccount', title: 'Paid from', role: 'paidFrom' },
  { key: 'teamOwedAccount', title: 'Owed to team members', role: 'teamOwed' },
  { key: 'ownerInvestmentAccount', title: "Owner's investment account", role: 'ownerEquity' },
  ...CATEGORY_SETTINGS.map(({ key, title, spendType }): AccountSetting => ({
    key,
    title,
    role: 'category',
    spendType,
  })),
];

/** "Owners and partners": one entry per person, each may name that person's own equity account. */
export const OWNERS_SETTING = { key: 'ownerNames', title: 'Owners and partners' } as const;

/**
 * The QuickBooks account types each role accepts, as Intuit spells them:
 * - a category: Expense, Other Expense or Cost of Goods Sold — whether QuickBooks takes the
 *   last two on a bill, an expense and a vendor credit is sandbox item S2;
 * - Paid from: Bank or Credit Card, as an expense needs ("Check must specify bank account,
 *   CreditCard must specify credit card account");
 * - Owed to team members: a liability but Accounts Payable or a credit card — an A/P line
 *   needs a vendor as its Name (sandbox S5 for an employee as Name on the rest);
 * - an owner's investment, shared or their own: Equity.
 */
export const ROLE_TYPES: Readonly<Record<AccountRole, readonly string[]>> = {
  category: ['Expense', 'Other Expense', 'Cost of Goods Sold'],
  paidFrom: ['Bank', 'Credit Card'],
  teamOwed: ['Other Current Liability', 'Long Term Liability'],
  ownerEquity: ['Equity'],
};

/** How a sentence names the kinds a role accepts. */
export const ROLE_KINDS: Readonly<Record<AccountRole, string>> = {
  category: 'an Expense, Other Expense or Cost of Goods Sold account',
  paidFrom: 'a bank or credit card account',
  teamOwed: 'a liability account other than Accounts Payable or a credit card',
  ownerEquity: 'an equity account',
};

/** Five levels of 100 characters, with room to spare: Intuit's own bounds on a full name. */
export const MAXIMUM_ACCOUNT_NAME_LENGTH = 1_000;

/**
 * An account setting as the name QuickBooks would show: an account name cannot hold a
 * colon, so trimming around each one only removes spaces a person typed. `undefined` for a
 * name with an empty part, or longer than any QuickBooks account's full name.
 */
export function accountNameOf(raw: string): string | undefined {
  const parts = raw.split(':').map((part) => part.trim());
  const name = parts.join(':');
  if (parts.some((part) => part === '') || name.length > MAXIMUM_ACCOUNT_NAME_LENGTH) {
    return undefined;
  }
  return name;
}
