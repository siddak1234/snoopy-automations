import {
  chartQuery,
  queryRowsOf,
  readQuickBooks,
  type Clock,
} from '@autom8x/automation-kit/quickbooks';
import { isObject, type JsonObject, type Step } from '@autom8x/automation-sdk';

import { chartOf } from '../chart.js';
import { grouped } from '../outcome.js';
import { notRecorded, readFailed } from '../quickbooks-path.js';

/**
 * `find-accounts` (v2) — read the company's accounts from QuickBooks: ONE query, the step's one
 * key (`chartQuery`: every active Bank, Credit Card, Expense, Other Expense and Cost of Goods Sold
 * account), and no setting read at all. v1 resolved up to 17 accounts typed into the flow's
 * settings and failed the run on the first that did not resolve — the owner's build-19 run failed
 * on "Parent:Child" before any AI step. v2 keeps the chart (`src/chart.ts`) for decide, which picks
 * the category and what paid from it (`src/decide/picks.ts`), so no setting can fail a run (U6,
 * U7). A read that fails is "not recorded in QuickBooks", and the run goes on to save the details
 * (decision 6). On the QuickBooks path only.
 */
export function findAccounts(clock: Clock): Step {
  return async ({ request, state, platform }) => {
    // Built once: every attempt sends exactly these bytes under the step's one key.
    const read = await readQuickBooks({
      platform,
      deadline: request.deadline,
      clock,
      operation: 'query.run',
      input: { query: chartQuery() },
      purpose: 'reading the accounts',
    });
    if (!read.ok) return readFailed(state, read);
    // No accounts at all is an answer with none; one that is no query answer is unusable.
    const rows = queryRowsOf(read.body, 'Account');
    if (!rows) return notRecorded(state, 'no_answer');
    const multicurrency =
      isObject(state.preferences) && state.preferences.multiCurrencyEnabled === true;
    const chart = chartOf(rows, multicurrency);
    return {
      outcome: 'ok',
      summary: `${grouped(chart.read)} ${chart.read === 1 ? 'account' : 'accounts'} read`,
      state: { ...state, chart: chart as unknown as JsonObject },
    };
  };
}
