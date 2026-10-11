import {
  QUICKBOOKS_SENTENCES,
  lookupQuery,
  queryRowsOf,
  readQuickBooks,
  type Clock,
} from '@autom8x/automation-kit/quickbooks';
import { truncateText, type Step } from '@autom8x/automation-sdk';

import { failedWith, quickBooksFailed } from '../outcome.js';
import type { AccountState } from '../state.js';

/**
 * `find-account` — turn the flow's "Expense account" setting, typed as text, into the
 * QuickBooks account the bill's line posts to: exactly one active account of type
 * Expense whose full name is the setting, else a sentence that names the setting,
 * before any model call is spent. One `query.run`.
 */

export const FIND_ACCOUNT_SENTENCES = {
  account_setting_missing: "Set the Expense account in this flow's settings, then run it again.",
  account_setting_invalid:
    'The Expense account setting is not a QuickBooks account name. Type the full name, such as Utilities:Electric, then run it again.',
  account_not_found:
    'No QuickBooks account matches the Expense account setting. Type the full name as QuickBooks shows it, without its number, then run it again.',
  account_not_found_number:
    'No QuickBooks account matches the Expense account setting. Type the name without the account number in front, then run it again.',
  account_ambiguous:
    'Two QuickBooks accounts match the Expense account setting. Type the full Parent:Child name, or rename one in QuickBooks, then run it again.',
  account_inactive:
    'The account in the Expense account setting is inactive in QuickBooks. Make it active or choose another, then run it again.',
  account_not_expense:
    'The account in the Expense account setting is not an Expense account in QuickBooks. Choose an Expense account, then run it again.',
} as const;

/** Five levels of 100 characters, with room to spare: Intuit's own bounds on a full name. */
const MAXIMUM_NAME_LENGTH = 1_000;

export function findAccount(clock: Clock): Step {
  return async ({ request, state, platform }) => {
    const raw = request.config.expenseAccount;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return failedWith(
        'Expense account not set',
        'account_setting_missing',
        FIND_ACCOUNT_SENTENCES.account_setting_missing,
      );
    }
    // An account name cannot hold a colon, so trimming around each one only removes
    // spaces a person typed; it cannot change which account is meant.
    const parts = raw.split(':').map((part) => part.trim());
    const name = parts.join(':');
    // The typed value may name the setting in the timeline, cut; never in the reason.
    const what = `Expense account "${truncateText(name, 80)}" not resolved`;
    if (parts.some((part) => part === '') || name.length > MAXIMUM_NAME_LENGTH) {
      const reason = 'account_setting_invalid';
      return failedWith(what, reason, FIND_ACCOUNT_SENTENCES[reason]);
    }

    const read = await readQuickBooks({
      platform,
      deadline: request.deadline,
      clock,
      operation: 'query.run',
      // Built once: every attempt sends exactly these bytes under the step's one key.
      input: { query: lookupQuery('Account', 'FullyQualifiedName', name, 2) },
      purpose: 'looking up the Expense account setting',
      advice: 'Remove unusual characters from it, then run it again.',
    });
    if (!read.ok) return quickBooksFailed(what, read);
    const rows = queryRowsOf(read.body, 'Account');
    if (!rows) return failedWith(what, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);

    // Intuit compares values without case; so does this re-check of what came back.
    const matches = rows.filter(
      (row) =>
        typeof row.FullyQualifiedName === 'string' &&
        row.FullyQualifiedName.toLowerCase() === name.toLowerCase(),
    );
    const [match] = matches;
    if (!match) {
      // An account number is not part of the full name; one typed in front gets a hint.
      const reason = /^\d+ /u.test(name) ? 'account_not_found_number' : 'account_not_found';
      return failedWith(what, reason, FIND_ACCOUNT_SENTENCES[reason]);
    }
    if (matches.length > 1) {
      return failedWith(what, 'account_ambiguous', FIND_ACCOUNT_SENTENCES.account_ambiguous);
    }
    // A missing Active is Intuit's default, true.
    if (match.Active === false) {
      return failedWith(what, 'account_inactive', FIND_ACCOUNT_SENTENCES.account_inactive);
    }
    if (match.AccountType !== 'Expense') {
      return failedWith(what, 'account_not_expense', FIND_ACCOUNT_SENTENCES.account_not_expense);
    }
    if (typeof match.Id !== 'string' || match.Id.trim() === '') {
      return failedWith(what, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
    }
    const account: AccountState = {
      id: match.Id,
      fullyQualifiedName: String(match.FullyQualifiedName),
    };
    return {
      outcome: 'ok',
      summary: `Expense account: ${truncateText(account.fullyQualifiedName, 100)} (QuickBooks Id ${truncateText(account.id, 20)})`,
      state: { ...state, account },
    };
  };
}
