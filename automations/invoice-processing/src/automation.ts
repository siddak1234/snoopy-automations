import { systemClock, type Clock } from '@autom8x/automation-kit/quickbooks';
import {
  defineAutomation,
  isObject,
  jsonLogger,
  type Automation,
  type JsonObject,
  type Logger,
  type Manifest,
  type RetryPolicy,
} from '@autom8x/automation-sdk';

import { noteThrows, withFixedSentences } from './failures.js';
import { EXTRACT_DOCUMENT_V1, VERIFY_DOCUMENT_V1 } from './prompts.js';
import { checkDocument } from './steps/check-document.js';
import { extract } from './steps/extract.js';
import { findAccounts } from './steps/find-accounts.js';
import { findPayer } from './steps/find-payer.js';
import { readCompany } from './steps/read-company.js';
import { readPreferences } from './steps/read-preferences.js';
import { receive } from './steps/receive.js';
import { verifyRead } from './steps/verify-read.js';

/**
 * Bills & Receipts (template `invoice-processing`) — records a bill, a receipt or a credit
 * note from a PDF or photo in QuickBooks Online, and compares a supplier's statement with it
 * (platform BUILD-PLAN 25.4.1; the owner's design of 2026-10-10 and plan of 2026-10-11).
 * Built in groups, each appending its steps to the v1 manifest before it is registered. The
 * first five spend nothing; the sixth and the eighth are its two model calls:
 *
 * - `receive` checks the file against the platform's measurements of it;
 * - `read-company` proves QuickBooks is connected and the company is in the US;
 * - `read-preferences` keeps the settings later steps read;
 * - `find-accounts` turns every account the flow's settings name into a QuickBooks account;
 * - `find-payer` finds who paid, when someone paid with their own money;
 * - `extract` has the platform's model read the document into its fields;
 * - `check-document` cleans what it read, routes it, and stops what can never be recorded;
 * - `verify-read` has another maker's model read it again, blind, and compares the two.
 *
 * `decide` (`src/decide/`) is built and tested, and joins the pipeline with the lookups it reads
 * (the plan's Group 4).
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
 * Each model call, repeated once, 10 s later, and only when it provably never reached the
 * platform (the owner's decision of 2026-10-10, and D8 for a 503 naming no code): a call
 * that reached it may have been made and billed, and nothing deduplicates a second one.
 */
const MODEL_RETRY: RetryPolicy = { attempts: 2, backoffMs: 10_000, when: 'unsent' };

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
    prompts: [EXTRACT_DOCUMENT_V1, VERIFY_DOCUMENT_V1],
    steps: noteThrows({
      receive,
      'read-company': readCompany(clock),
      'read-preferences': readPreferences(clock),
      'find-accounts': findAccounts(clock),
      'find-payer': findPayer(clock),
      extract: extract(EXTRACT_DOCUMENT_V1),
      'check-document': checkDocument(clock),
      'verify-read': verifyRead(VERIFY_DOCUMENT_V1),
    }),
    retry: {
      receive: READ_RETRY,
      'read-company': READ_RETRY,
      'read-preferences': READ_RETRY,
      'find-accounts': READ_RETRY,
      'find-payer': READ_RETRY,
      extract: MODEL_RETRY,
      'verify-read': MODEL_RETRY,
    },
    // Until the groups that record the document: what the steps found — of the readings, the
    // models that served, the document's type and route, and whether the second read agreed.
    // The values read restate the document and are never an output. `payer` is absent when the
    // company paid.
    result: (state) => ({
      output: {
        file: state.file,
        company: state.company,
        preferences: state.preferences,
        accounts: state.accounts,
        ...(state.payer === undefined ? {} : { payer: state.payer }),
        modelServed: state.modelServed,
        ...readingsOf(state),
      },
      summary:
        "Checked the file, the QuickBooks company, its settings and the accounts in this flow's settings, and read the document twice",
    }),
  });
  return withFixedSentences(automation, dependencies.log ?? jsonLogger(TEMPLATE_ID));
}

/** The type and route the document took, and the second read's outcome, for the run's output. */
function readingsOf(state: JsonObject): JsonObject {
  const document = isObject(state.document) ? state.document : {};
  const verification = isObject(state.verification) ? state.verification : {};
  return {
    documentType: document.type ?? null,
    route: document.route ?? null,
    secondRead:
      verification.status === 'made'
        ? {
            status: 'made',
            modelServed: verification.modelServed ?? null,
            agreed:
              Array.isArray(verification.differences) && verification.differences.length === 0,
          }
        : { status: 'not_made', reason: verification.reason ?? null },
  };
}
