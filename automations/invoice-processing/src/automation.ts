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
import { EXTRACT_DOCUMENT_V1 } from './prompts.js';
import { extract } from './steps/extract.js';
import { findAccounts } from './steps/find-accounts.js';
import { findPayer } from './steps/find-payer.js';
import { readCompany } from './steps/read-company.js';
import { readPreferences } from './steps/read-preferences.js';
import { receive } from './steps/receive.js';

/**
 * Bills & Receipts (template `invoice-processing`) — records a bill, a receipt or a credit
 * note from a PDF or photo in QuickBooks Online, and compares a supplier's statement with it
 * (platform BUILD-PLAN 25.4.1; the owner's design of 2026-10-10 and plan of 2026-10-11).
 * Built in groups, each appending its steps to the v1 manifest before it is registered. The
 * first five spend nothing; the sixth is the one model call so far:
 *
 * - `receive` checks the file against the platform's measurements of it;
 * - `read-company` proves QuickBooks is connected and the company is in the US;
 * - `read-preferences` keeps the settings later steps read;
 * - `find-accounts` turns every account the flow's settings name into a QuickBooks account;
 * - `find-payer` finds who paid, when someone paid with their own money;
 * - `extract` has the platform's model read the document into its fields.
 *
 * One container serves v1 and nothing else (the platform's D2: one container per
 * manifest version for everything new).
 */
export const TEMPLATE_ID = 'invoice-processing';

/**
 * The QuickBooks reads and the file's, each repeated after a TRANSIENT failure — no answer, or a 502/503/504
 * naming no reason — at the SDK's floor and ceilings: three attempts, 10 s then 20 s,
 * never past the deadline. A repeat sends the same request under the step's one key,
 * which the platform answers from its record when it has one.
 */
const READ_RETRY: RetryPolicy = { attempts: 3, backoffMs: 10_000 };

/**
 * The model call, repeated once, 10 s later, and only when it provably never reached the
 * platform (the owner's decision of 2026-10-10, and D8 for a 503 naming no code): a call
 * that reached it may have been made and billed, and nothing deduplicates a second one.
 */
const EXTRACT_RETRY: RetryPolicy = { attempts: 2, backoffMs: 10_000, when: 'unsent' };

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
    prompts: [EXTRACT_DOCUMENT_V1],
    steps: noteThrows({
      receive,
      'read-company': readCompany(clock),
      'read-preferences': readPreferences(clock),
      'find-accounts': findAccounts(clock),
      'find-payer': findPayer(clock),
      extract: extract(EXTRACT_DOCUMENT_V1),
    }),
    retry: {
      receive: READ_RETRY,
      'read-company': READ_RETRY,
      'read-preferences': READ_RETRY,
      'find-accounts': READ_RETRY,
      'find-payer': READ_RETRY,
      extract: EXTRACT_RETRY,
    },
    // Until the groups that record the document: what the steps found — and of the reading,
    // only the model that served. The answer itself restates the document and is never an
    // output. `payer` is absent when the company paid.
    result: (state) => ({
      output: {
        file: state.file,
        company: state.company,
        preferences: state.preferences,
        accounts: state.accounts,
        ...(state.payer === undefined ? {} : { payer: state.payer }),
        modelServed: state.modelServed,
      },
      summary:
        "Checked the file, the QuickBooks company, its settings and the accounts in this flow's settings, and read the document",
    }),
  });
  return withFixedSentences(automation, dependencies.log ?? jsonLogger(TEMPLATE_ID));
}
