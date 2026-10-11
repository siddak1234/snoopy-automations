import {
  QUICKBOOKS_SENTENCES,
  entityOf,
  nameValueOf,
  readQuickBooks,
  type Clock,
} from '@autom8x/automation-kit/quickbooks';
import { isObject, type Step } from '@autom8x/automation-sdk';

import { failedWith, quickBooksFailed } from '../outcome.js';
import type { PreferencesState } from '../state.js';

/**
 * `read-preferences` — the company settings later steps need: the home currency and
 * the multicurrency flag (the currency rules and the bill's `CurrencyRef`), the books'
 * closing date when QuickBooks returns one, and the two duplicate-number settings, kept
 * as information only. One `preferences.get`.
 */

export const READ_PREFERENCES_SENTENCES = {
  home_currency_missing:
    "QuickBooks did not return this company's home currency, so the bill cannot be checked. Run it again; if it repeats, contact support.",
} as const;

const WHAT = 'QuickBooks settings not read';

export function readPreferences(clock: Clock): Step {
  return async ({ request, state, platform }) => {
    const read = await readQuickBooks({
      platform,
      deadline: request.deadline,
      clock,
      operation: 'preferences.get',
      input: {},
      purpose: 'reading the company settings',
    });
    if (!read.ok) return quickBooksFailed(WHAT, read);
    const prefs = entityOf(read.body, 'Preferences');
    if (!prefs) {
      return failedWith(WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
    }

    const currency = objectAt(prefs, 'CurrencyPrefs');
    const home = objectAt(currency, 'HomeCurrency')?.value;
    const homeCurrency = typeof home === 'string' ? home.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/u.test(homeCurrency)) {
      return failedWith(
        WHAT,
        'home_currency_missing',
        READ_PREFERENCES_SENTENCES.home_currency_missing,
      );
    }
    const customTxnNumbers = objectAt(prefs, 'SalesFormsPrefs')?.CustomTxnNumbers;
    const warning = nameValueOf(
      objectAt(prefs, 'OtherPrefs')?.NameValue,
      'WarnDuplicateBillNumber',
    );
    const closing = objectAt(prefs, 'AccountingInfoPrefs')?.BookCloseDate;
    const preferences: PreferencesState = {
      homeCurrency,
      // Off unless QuickBooks says on: Intuit's default, and a wrong guess fails at the bill.
      multiCurrencyEnabled: currency?.MultiCurrencyEnabled === true,
      customTxnNumbers: typeof customTxnNumbers === 'boolean' ? customTxnNumbers : null,
      warnDuplicateBillNumber: warning === 'true' ? true : warning === 'false' ? false : null,
      bookCloseDate: isCalendarDate(closing) ? closing : null,
    };
    const books =
      preferences.bookCloseDate !== null
        ? `books closed through ${preferences.bookCloseDate}`
        : closing === undefined || closing === null
          ? 'no closing date from QuickBooks'
          : 'closing date unreadable';
    return {
      outcome: 'ok',
      summary: `Home currency ${homeCurrency}; multicurrency ${preferences.multiCurrencyEnabled ? 'on' : 'off'}; ${books}`,
      state: { ...state, preferences },
    };
  };
}

function objectAt(parent: Record<string, unknown> | undefined, key: string) {
  const value = parent?.[key];
  return isObject(value) ? value : undefined;
}

/** A real `YYYY-MM-DD` day of the calendar: `2026-02-30` and `12/31/2025` are not. */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
