import {
  entityOf,
  nameValueOf,
  readQuickBooks,
  type Clock,
} from '@autom8x/automation-kit/quickbooks';
import { isObject, type Step } from '@autom8x/automation-sdk';

import { notRecorded, readFailed } from '../quickbooks-path.js';
import type { PreferencesState } from '../state.js';

/**
 * `read-preferences` — the company settings later steps need: the home currency and
 * the multicurrency flag (the currency rules and each record's `CurrencyRef`), the books'
 * closing date when QuickBooks returns one, the two duplicate-number settings, kept as
 * information only, and — from the same answer, OtherPrefs — whether a vendor credit may
 * carry its own number (`VendorAndPurchasesPrefs.UseCustomTxnNumbers`; Intuit's advice is to
 * check it before sending one). One `preferences.get`, on the QuickBooks path only; a failure is
 * "not recorded in QuickBooks", and the run goes on to save the details (decision 6).
 */

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
    if (!read.ok) return readFailed(state, read);
    const prefs = entityOf(read.body, 'Preferences');
    if (!prefs) return notRecorded(state, 'no_answer');

    const currency = objectAt(prefs, 'CurrencyPrefs');
    const home = objectAt(currency, 'HomeCurrency')?.value;
    const homeCurrency = typeof home === 'string' ? home.trim().toUpperCase() : '';
    // No home currency: the document cannot be checked against it, so QuickBooks answered unusably.
    if (!/^[A-Z]{3}$/u.test(homeCurrency)) return notRecorded(state, 'no_answer');
    const customTxnNumbers = objectAt(prefs, 'SalesFormsPrefs')?.CustomTxnNumbers;
    const other = objectAt(prefs, 'OtherPrefs')?.NameValue;
    const warning = nameValueOf(other, 'WarnDuplicateBillNumber');
    const purchaseNumbers = nameValueOf(other, 'VendorAndPurchasesPrefs.UseCustomTxnNumbers');
    const closing = objectAt(prefs, 'AccountingInfoPrefs')?.BookCloseDate;
    const preferences: PreferencesState = {
      homeCurrency,
      // Off unless QuickBooks says on: Intuit's default, and a wrong guess fails at the bill.
      multiCurrencyEnabled: currency?.MultiCurrencyEnabled === true,
      customTxnNumbers: typeof customTxnNumbers === 'boolean' ? customTxnNumbers : null,
      purchaseCustomTxnNumbers:
        purchaseNumbers === 'true' ? true : purchaseNumbers === 'false' ? false : null,
      warnDuplicateBillNumber: warning === 'true' ? true : warning === 'false' ? false : null,
      bookCloseDate: isCalendarDate(closing) ? closing : null,
    };
    return {
      outcome: 'ok',
      summary: 'Settings read',
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
