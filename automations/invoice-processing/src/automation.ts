import { systemClock, type Clock } from '@autom8x/automation-kit/quickbooks';
import {
  defineAutomation,
  jsonLogger,
  type Automation,
  type Logger,
  type Manifest,
  type RetryPolicy,
} from '@autom8x/automation-sdk';

import { noteThrows, withFixedSentences } from './failures.js';
import { findAccount } from './steps/find-account.js';
import { readCompany } from './steps/read-company.js';
import { readPreferences } from './steps/read-preferences.js';
import { receive } from './steps/receive.js';

/**
 * Invoice Processing — reads a supplier invoice from a PDF or photo and creates an
 * unpaid bill in QuickBooks Online (platform BUILD-PLAN 25.4.1, the owner's design of
 * 2026-10-10). Built in groups, each appending its steps to the v1 manifest before it
 * is registered; this group is the first four, which spend nothing:
 *
 * - `receive` checks the file against the platform's measurements of it;
 * - `read-company` proves QuickBooks is connected and the company is in the US;
 * - `read-preferences` keeps the settings later steps read;
 * - `find-account` turns the Expense account setting into a QuickBooks account.
 *
 * One container serves v1 and nothing else (the platform's D2: one container per
 * manifest version for everything new).
 */
export const TEMPLATE_ID = 'invoice-processing';

/**
 * The four steps only read, so each is repeated after a TRANSIENT failure — no answer,
 * or a 502/503/504 naming no reason — at the SDK's floor and ceilings: three attempts,
 * 10 s then 20 s, never past the deadline. A repeat sends the same request under the
 * step's one key, which the platform answers from its record when it has one.
 */
const READ_RETRY: RetryPolicy = { attempts: 3, backoffMs: 10_000 };

export interface Dependencies {
  /** The QuickBooks reads' clock: a suite passes one that does not wait. */
  readonly clock?: Clock;
  readonly log?: Logger;
}

export function define(
  manifests: readonly Manifest[],
  dependencies: Dependencies = {},
): Automation {
  const clock = dependencies.clock ?? systemClock;
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests,
    steps: noteThrows({
      receive,
      'read-company': readCompany(clock),
      'read-preferences': readPreferences(clock),
      'find-account': findAccount(clock),
    }),
    retry: {
      receive: READ_RETRY,
      'read-company': READ_RETRY,
      'read-preferences': READ_RETRY,
      'find-account': READ_RETRY,
    },
    // Until the groups that create the bill: what the four steps found.
    result: (state) => ({
      output: {
        file: state.file,
        company: state.company,
        preferences: state.preferences,
        account: state.account,
      },
      summary:
        'Checked the invoice file, the QuickBooks company, its settings and the expense account',
    }),
  });
  return withFixedSentences(automation, dependencies.log ?? jsonLogger(TEMPLATE_ID));
}
