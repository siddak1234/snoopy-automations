import {
  QUICKBOOKS_SENTENCES,
  lookupInQuery,
  queryRowsOf,
  readQuickBooks,
  type Clock,
} from '@autom8x/automation-kit/quickbooks';
import { isObject, truncateText, type JsonObject, type Step } from '@autom8x/automation-sdk';

import {
  ACCOUNT_SETTINGS,
  DEFAULT_CATEGORY,
  OWNERS_SETTING,
  ROLE_KINDS,
  ROLE_TYPES,
  accountNameOf,
  type AccountRole,
  type AccountSetting,
} from '../account-settings.js';
import { failedWith, quickBooksFailed } from '../outcome.js';
import { readOwners, type Owner } from '../owners.js';
import type { AccountRef, AccountsState } from '../state.js';

/**
 * `find-accounts` — turn every account the flow's settings name, typed as text, into the
 * QuickBooks account it means, in ONE query (a step makes one QuickBooks call):
 * `FullyQualifiedName IN (…)` over the default category, Paid from, Owed to team members,
 * Owner's investment account, each owner's own account and each category setting
 * (whether IN works on that field is sandbox item S1). Each is then held to its role: exactly
 * one account by that name, active, of a kind the role accepts, and — with multicurrency on —
 * holding USD. The first setting that fails, in the manifest's order, stops the run with
 * find-account's sentences naming that setting (A1), before any model call. An optional
 * setting left empty fails only when a document needs it, later; an empty category setting
 * means the default category.
 */

/** Where a sentence says an account was named. */
export interface Place {
  /** The setting's title, as the timeline line names it. */
  readonly title: string;
  /** What an account matches: "the 'Paid from' setting". */
  readonly object: string;
  /** What is inactive or of the wrong kind: "The account in the 'Paid from' setting". */
  readonly subject: string;
  /** What is not an account name: "The 'Paid from' setting". */
  readonly named: string;
  /** A full name to show as an example. */
  readonly example: string;
}

export function placeOf(title: string): Place {
  return {
    title,
    object: `the '${title}' setting`,
    subject: `The account in the '${title}' setting`,
    named: `The '${title}' setting`,
    example: 'Utilities:Electric',
  };
}

/** An owner's own account, written after "=" in "Owners and partners". */
export const OWNER_PLACE: Place = {
  title: OWNERS_SETTING.title,
  object: `an account in the '${OWNERS_SETTING.title}' setting`,
  subject: `An account in the '${OWNERS_SETTING.title}' setting`,
  named: `An account in the '${OWNERS_SETTING.title}' setting`,
  example: 'Partner investments:Jane',
};

export type AccountReason =
  | 'account_setting_missing'
  | 'account_setting_invalid'
  | 'account_not_found'
  | 'account_not_found_number'
  | 'account_ambiguous'
  | 'account_inactive'
  | 'account_wrong_kind'
  | 'account_not_usd';

/** A1's sentences: find-account's, each naming its setting; fixed, never the value typed. */
export function accountSentence(reason: AccountReason, place: Place, role: AccountRole): string {
  switch (reason) {
    case 'account_setting_missing':
      return `Set '${place.title}' in this flow's settings, then run it again.`;
    case 'account_setting_invalid':
      return `${place.named} is not a QuickBooks account name. Type the full name, such as ${place.example}, then run it again.`;
    case 'account_not_found':
      return `No QuickBooks account matches ${place.object}. Type the full name as QuickBooks shows it, without its number, then run it again.`;
    case 'account_not_found_number':
      return `No QuickBooks account matches ${place.object}. Type the name without the account number in front, then run it again.`;
    case 'account_ambiguous':
      return `Two QuickBooks accounts match ${place.object}. Type the full Parent:Child name, or rename one in QuickBooks, then run it again.`;
    case 'account_inactive':
      return `${place.subject} is inactive in QuickBooks. Make it active or choose another, then run it again.`;
    case 'account_wrong_kind':
      return `${place.subject} is not ${ROLE_KINDS[role]} in QuickBooks. Choose one that is, then run it again.`;
    case 'account_not_usd':
      return `${place.subject} is not in USD in QuickBooks, and this automation records USD only. Choose a USD account, then run it again.`;
  }
}

export const OWNERS_UNREADABLE =
  "The 'Owners and partners' setting could not be read. Write one entry per person, separated by semicolons, such as Jane Doe = Partner investments:Jane; Sam Lee, then run it again.";

/** The timeline's words for a failure of the one query, or of its answer. */
const WHAT = "The accounts in this flow's settings were not looked up";

/** One account the settings ask for. */
interface Asked {
  readonly place: Place;
  readonly role: AccountRole;
  /** The full name as typed, spaces around colons removed. */
  readonly name: string;
  readonly setting?: AccountSetting;
  readonly owner?: Owner;
}

function refused(asked: Pick<Asked, 'place' | 'role'>, name: string, reason: AccountReason) {
  // The typed value may name the setting in the timeline, cut; never in the reason.
  return failedWith(
    `${asked.place.title} "${truncateText(name, 80)}" not resolved`,
    reason,
    accountSentence(reason, asked.place, asked.role),
  );
}

/** The names to ask for, each once: Intuit compares without case, and IN refuses a repeat. */
function distinctNames(asked: readonly Asked[]): string[] {
  const names = new Map<string, string>();
  for (const { name } of asked) {
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return [...names.values()];
}

function currencyOf(row: JsonObject): string | undefined {
  const value = isObject(row.CurrencyRef) ? row.CurrencyRef.value : undefined;
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : undefined;
}

export function findAccounts(clock: Clock): Step {
  return async ({ request, state, platform }) => {
    const asked: Asked[] = [];
    for (const setting of ACCOUNT_SETTINGS) {
      const raw = request.config[setting.key];
      const place = placeOf(setting.title);
      if (typeof raw !== 'string' || raw.trim() === '') {
        if (setting !== DEFAULT_CATEGORY) continue;
        const reason = 'account_setting_missing';
        return failedWith(
          `${setting.title} not set`,
          reason,
          accountSentence(reason, place, setting.role),
        );
      }
      const name = accountNameOf(raw);
      if (name === undefined) {
        const typed = raw
          .split(':')
          .map((part) => part.trim())
          .join(':');
        return refused({ place, role: setting.role }, typed, 'account_setting_invalid');
      }
      asked.push({ place, role: setting.role, name, setting });
    }
    const owners = readOwners(request.config[OWNERS_SETTING.key]);
    if (!owners) {
      return failedWith(
        `${OWNERS_SETTING.title} not read`,
        'owners_setting_invalid',
        OWNERS_UNREADABLE,
      );
    }
    for (const owner of owners) {
      if (owner.accountName === null) continue;
      asked.push({ place: OWNER_PLACE, role: 'ownerEquity', name: owner.accountName, owner });
    }

    // Built once: every attempt sends exactly these bytes under the step's one key. Two rows
    // a name tell one account from two.
    const names = distinctNames(asked);
    const maxResults = Math.min(1_000, names.length * 2);
    const read = await readQuickBooks({
      platform,
      deadline: request.deadline,
      clock,
      operation: 'query.run',
      input: { query: lookupInQuery('Account', 'FullyQualifiedName', names, maxResults) },
      purpose: "looking up the accounts in this flow's settings",
      advice: 'Remove unusual characters from them, then run it again.',
    });
    if (!read.ok) return quickBooksFailed(WHAT, read);
    const rows = queryRowsOf(read.body, 'Account');
    if (!rows) return failedWith(WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);

    const multicurrency =
      isObject(state.preferences) && state.preferences.multiCurrencyEnabled === true;
    // A full answer may hold another name's rows in place of this one's: no verdict on it.
    const full = rows.length >= maxResults;
    let undecided = false;
    const found = new Map<Asked, AccountRef>();
    for (const one of asked) {
      // Intuit compares values without case; so does this re-check of what came back.
      const matches = rows.filter(
        (row) =>
          typeof row.FullyQualifiedName === 'string' &&
          row.FullyQualifiedName.toLowerCase() === one.name.toLowerCase(),
      );
      const [match] = matches;
      if (!match) {
        if (full) {
          undecided = true;
          continue;
        }
        // An account number is not part of the full name; one typed in front gets a hint.
        const reason = /^\d+ /u.test(one.name) ? 'account_not_found_number' : 'account_not_found';
        return refused(one, one.name, reason);
      }
      if (matches.length > 1) return refused(one, one.name, 'account_ambiguous');
      // A missing Active is Intuit's default, true.
      if (match.Active === false) return refused(one, one.name, 'account_inactive');
      const type = match.AccountType;
      if (typeof type !== 'string' || !ROLE_TYPES[one.role].includes(type)) {
        return refused(one, one.name, 'account_wrong_kind');
      }
      if (multicurrency) {
        // "The currency in which this account holds amounts", which QuickBooks always gives.
        const currency = currencyOf(match);
        if (currency === undefined) {
          return failedWith(WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
        }
        if (currency !== 'USD') return refused(one, one.name, 'account_not_usd');
      }
      if (typeof match.Id !== 'string' || match.Id.trim() === '') {
        return failedWith(WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
      }
      found.set(one, {
        id: match.Id,
        fullyQualifiedName: String(match.FullyQualifiedName),
        accountType: type,
      });
    }
    if (undecided) {
      return failedWith(WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
    }

    const accounts = stateOf(asked, found, owners);
    const { defaultCategory } = accounts;
    const more = asked.length - 1;
    return {
      outcome: 'ok',
      summary: `Default category: ${truncateText(defaultCategory.fullyQualifiedName, 100)} (QuickBooks Id ${truncateText(defaultCategory.id, 20)})${more > 0 ? `; ${more} more account${more === 1 ? '' : 's'} found` : ''}`,
      state: { ...state, accounts: accounts as unknown as JsonObject },
    };
  };
}

/** One account per role, as `AccountsState` keeps them. */
function stateOf(
  asked: readonly Asked[],
  found: ReadonlyMap<Asked, AccountRef>,
  owners: readonly Owner[],
): AccountsState {
  const bySetting = (key: string): AccountRef | null => {
    const one = asked.find((each) => each.setting?.key === key);
    return one ? (found.get(one) ?? null) : null;
  };
  const categories: Partial<Record<string, AccountRef>> = {};
  for (const one of asked) {
    const account = found.get(one);
    if (one.setting?.spendType && account) categories[one.setting.spendType] = account;
  }
  const defaultCategory = bySetting(DEFAULT_CATEGORY.key);
  if (!defaultCategory) throw new Error('the default category resolved to no account');
  return {
    defaultCategory,
    categories,
    paidFrom: bySetting('paidFromAccount'),
    teamOwed: bySetting('teamOwedAccount'),
    ownerInvestment: bySetting('ownerInvestmentAccount'),
    owners: owners.map((owner) => {
      const one = asked.find((each) => each.owner === owner);
      return { name: owner.name, account: one ? (found.get(one) ?? null) : null };
    }),
  };
}
