import { isObject, type JsonObject } from '@autom8x/automation-sdk';

/**
 * The company's chart of accounts as `find-accounts` reads it (v2, the platform's BUILD-PLAN
 * 25.4.19 and 25.4.20): no setting names an account any more — the owner's "If already have oauth
 * why cant we intake this info from the existing quickbooks app" (build 19, 2026-10-14) — so one
 * query reads every active account a purchase is recorded to or paid from, and decide picks from
 * them (`src/decide/picks.ts`). Kept in `state.chart` until decide has made its plan.
 */

/** The QuickBooks account types each role accepts, as Intuit spells them. */
export const ROLE_TYPES = {
  /**
   * Where the cost goes: Expense, Other Expense or Cost of Goods Sold — whether QuickBooks takes
   * the last two on a bill, an expense and a vendor credit is sandbox item S2.
   */
  category: ['Expense', 'Other Expense', 'Cost of Goods Sold'],
  /** What pays, as an expense needs ("Check must specify bank account, CreditCard must specify credit card account"). */
  bank: ['Bank'],
  card: ['Credit Card'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** One account, as the picks read it. */
export interface ChartAccount {
  readonly id: string;
  /** Its own name, the last part of its full name: `Electric` of `Utilities:Electric`. */
  readonly name: string;
  /** `FullyQualifiedName`, as QuickBooks spells it. */
  readonly fullName: string;
  /** Intuit's `AccountType`. */
  readonly type: string;
  /** Intuit's `AccountSubType` — its detail type; null when QuickBooks gives none. */
  readonly detailType: string | null;
}

/** The chart, split by what each account can be. */
export interface ChartState {
  /** Expense, Other Expense and Cost of Goods Sold accounts. */
  readonly categories: readonly ChartAccount[];
  readonly banks: readonly ChartAccount[];
  readonly cards: readonly ChartAccount[];
  /**
   * The Expense account whose full name, trimmed, is "Uncategorized Expense" in any capitals —
   * the one QuickBooks Online makes in every company (its type is sandbox read S13) — else null.
   */
  readonly uncategorized: ChartAccount | null;
  /** How many accounts the answer held, the inactive and other currencies' included. */
  readonly read: number;
}

/** The name QuickBooks Online gives its catch-all expense account. */
export const UNCATEGORIZED_EXPENSE = 'Uncategorized Expense';

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

function currencyOf(row: JsonObject): string | null {
  const value = isObject(row.CurrencyRef) ? row.CurrencyRef.value : undefined;
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : null;
}

/** One row as the picks read it, or undefined for a row that is no account they could use. */
function accountOf(row: JsonObject): ChartAccount | undefined {
  const id = text(row.Id);
  const fullName = text(row.FullyQualifiedName) ?? text(row.Name);
  const type = text(row.AccountType);
  if (id === null || fullName === null || type === null) return undefined;
  return {
    id,
    name: text(row.Name) ?? fullName.split(':').at(-1)!.trim(),
    fullName,
    type,
    detailType: text(row.AccountSubType),
  };
}

/**
 * The chart from the query's rows: each ACTIVE account — a missing `Active` is Intuit's default,
 * true — and, with multicurrency on, only one holding USD (this automation records USD only),
 * split by role. An account of any other type is left out.
 */
export function chartOf(rows: readonly JsonObject[], multicurrency: boolean): ChartState {
  const categories: ChartAccount[] = [];
  const banks: ChartAccount[] = [];
  const cards: ChartAccount[] = [];
  for (const row of rows) {
    if (row.Active === false) continue;
    if (multicurrency && currencyOf(row) !== 'USD') continue;
    const account = accountOf(row);
    if (!account) continue;
    if ((ROLE_TYPES.category as readonly string[]).includes(account.type)) categories.push(account);
    else if ((ROLE_TYPES.bank as readonly string[]).includes(account.type)) banks.push(account);
    else if ((ROLE_TYPES.card as readonly string[]).includes(account.type)) cards.push(account);
  }
  const uncategorized =
    categories.find(
      (account) =>
        account.type === 'Expense' &&
        account.fullName.trim().toLowerCase() === UNCATEGORIZED_EXPENSE.toLowerCase(),
    ) ?? null;
  return { categories, banks, cards, uncategorized, read: rows.length };
}

const isAccount = (value: unknown): value is ChartAccount =>
  isObject(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.fullName === 'string' &&
  typeof value.type === 'string' &&
  (value.detailType === null || typeof value.detailType === 'string');

/** `state.chart` read back, or undefined when it is missing or malformed. */
export function chartStateOf(value: unknown): ChartState | undefined {
  if (!isObject(value)) return undefined;
  const lists = [value.categories, value.banks, value.cards];
  if (!lists.every((list) => Array.isArray(list) && list.every(isAccount))) return undefined;
  if (value.uncategorized !== null && !isAccount(value.uncategorized)) return undefined;
  if (typeof value.read !== 'number') return undefined;
  return value as unknown as ChartState;
}
