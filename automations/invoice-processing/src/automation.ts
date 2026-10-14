import { systemClock, type Clock } from '@autom8x/automation-kit/quickbooks';
import {
  defineAutomation,
  jsonLogger,
  type Automation,
  type Logger,
  type Manifest,
  type PromptModule,
  type RetryPolicy,
  type Step,
} from '@autom8x/automation-sdk';

import { decide } from './decide/step.js';
import { noteThrows, recoverQuickBooks, withFixedSentences } from './failures.js';
import { EXPENSE_SEARCH, type ExpenseSearch } from './lookups/expense-search.js';
import { runResult } from './output.js';
import { EXTRACT_DOCUMENT_V1, VERIFY_DOCUMENT_V1 } from './prompts.js';
import { onQuickBooksPath } from './quickbooks-path.js';
import { checkDocument } from './steps/check-document.js';
import { confirmCompany } from './steps/confirm-company.js';
import { confirmNoDuplicate } from './steps/confirm-no-duplicate.js';
import { confirmVendor, createVendor } from './steps/confirm-vendor.js';
import { createRecord } from './steps/create-record.js';
import { extract } from './steps/extract.js';
import { findAccounts } from './steps/find-accounts.js';
import {
  findCustomerName,
  findEmployeeName,
  findSimilarVendors,
} from './steps/find-name-checks.js';
import {
  findDuplicateAmount,
  findDuplicateNumber,
  findOtherRecord,
  findRelated,
} from './steps/find-records.js';
import { findVendor, findVendorCompany } from './steps/find-vendor.js';
import { notify } from './steps/notify.js';
import { readCompany } from './steps/read-company.js';
import { readPreferences } from './steps/read-preferences.js';
import { receive } from './steps/receive.js';
import { saveDetails } from './steps/save-details.js';
import { verifyRead } from './steps/verify-read.js';

/**
 * Invoice Processing (template `invoice-processing`), version 2 — reads a bill, a receipt, a credit
 * note or a statement from a PDF or photo, then saves its details for the team, or records it in
 * QuickBooks Online (the platform's BUILD-PLAN 25.4.13–25.4.26; the owner's build-19 feedback and
 * "continue and complete", 2026-10-14). v1, under its first name, is registered and immutable: its
 * container keeps its pinned image until it is retired, and THIS code serves v2 alone
 * (`SERVED_VERSIONS`; the platform's D2, one container per manifest version).
 *
 * Its 24 steps, in five groups a person sees (Received · Read · Checked · Done · Emailed):
 *
 * - `receive` checks the file against the platform's measurements of it;
 * - on the QuickBooks path: `read-company`, `read-preferences`, and `find-accounts`, which reads the
 *   company's accounts in one query — no setting names an account;
 * - `extract` has the platform's model read the document — the one AI step every run takes;
 * - `check-document` cleans what it read, routes it, and stops a document that cannot be used;
 * - `verify-read`, a second AI read by another maker, ONLY when the first shows a problem;
 * - on the QuickBooks path: nine lookups, `decide` (record, hold, compare, or not record), after an
 *   approval the checks it calls for, and `create-record`, the one write;
 * - `save-details`, when the vendor is "None" or QuickBooks did not record it;
 * - `notify` — the optional email to the "Also email" address.
 *
 * The vendor choice is the flow's `vendor` setting (`src/quickbooks-path.ts`): "None" reads and
 * saves, and calls QuickBooks for nothing. No setting can fail a run, and QuickBooks failing mid-run
 * saves the details instead (decision 6). Its result is the details saved, the record made, or a
 * statement's comparison (`src/output.ts`), each with the `details` a person reads.
 */
export const TEMPLATE_ID = 'invoice-processing';

/** The manifest versions this code serves: v2 alone. v1's container runs its own pinned image. */
export const SERVED_VERSIONS = [2] as const;

/**
 * The QuickBooks reads and the file's, each repeated after a TRANSIENT failure — no answer, or a
 * 502/503/504 naming no reason — at the SDK's floor and ceilings: three attempts, 10 s then 20 s,
 * never past the deadline. A repeat sends the same request under the step's one key, which the
 * platform answers from its record when it has one.
 */
const READ_RETRY: RetryPolicy = { attempts: 3, backoffMs: 10_000 };

/**
 * Each model call, repeated once, 10 s later, and only when it provably never reached the
 * platform (the owner's decision of 2026-10-10, and D8 for a 503 naming no code): a call that
 * reached it may have been made and billed, and nothing deduplicates a second one.
 */
const MODEL_RETRY: RetryPolicy = { attempts: 2, backoffMs: 10_000, when: 'unsent' };

/**
 * The two writes — create-vendor, create-record — repeated as the reads are, after a failure
 * nothing answered (the owner's "Retry the creates", 2026-10-12). Every attempt carries the step's
 * one key, so the platform sends the same `requestid`, and Intuit answers a repeated `requestid`
 * with its first answer — the same record and Id, never a second (sandbox S6). Once an attempt went
 * unanswered, a refusal of a later one is "didn't confirm", never "nothing was created" (Gate 25's
 * AUT-38-1): the kit judges every attempt after one it threw on.
 */
const WRITE_RETRY: RetryPolicy = { attempts: 3, backoffMs: 10_000 };

/** The prompts the steps send, each registered with the runner. */
export const PROMPTS: readonly PromptModule[] = [EXTRACT_DOCUMENT_V1, VERIFY_DOCUMENT_V1];

/**
 * The steps repeated after a transient failure: every QuickBooks read and the file's, both writes,
 * and each model call only when it never reached the platform. decide and save-details call
 * nothing, so they have none. notify catches its own failure, so a policy there would never fire.
 */
export const RETRY: Readonly<Record<string, RetryPolicy>> = {
  receive: READ_RETRY,
  'read-company': READ_RETRY,
  'read-preferences': READ_RETRY,
  'find-accounts': READ_RETRY,
  extract: MODEL_RETRY,
  'verify-read': MODEL_RETRY,
  'find-vendor': READ_RETRY,
  'find-vendor-company': READ_RETRY,
  'find-similar-vendors': READ_RETRY,
  'find-customer-name': READ_RETRY,
  'find-employee-name': READ_RETRY,
  'find-duplicate-number': READ_RETRY,
  'find-duplicate-amount': READ_RETRY,
  'find-related': READ_RETRY,
  'find-other-record': READ_RETRY,
  'confirm-company': READ_RETRY,
  'confirm-vendor': READ_RETRY,
  'create-vendor': WRITE_RETRY,
  'confirm-no-duplicate': READ_RETRY,
  'create-record': WRITE_RETRY,
};

/**
 * A step that runs on the QuickBooks path alone — QuickBooks chosen, and nothing has stopped it
 * (`onQuickBooksPath`) — and is skipped, with no line and no call, otherwise.
 */
function quickBooksOnly(step: Step): Step {
  return (context) =>
    onQuickBooksPath(context.request, context.state)
      ? step(context)
      : Promise.resolve({ outcome: 'skipped' });
}

/**
 * Every step v2's pipeline declares, in its order, each noting what it throws for the run's fixed
 * sentence and logging the reason code it ends with. `expenseSearch` is sandbox S4's answer
 * (`src/lookups/expense-search.ts`).
 */
export function pipelineSteps(
  clock: Clock,
  expenseSearch: ExpenseSearch,
  log: Logger,
): Record<string, Step> {
  return noteThrows(
    {
      receive,
      'read-company': quickBooksOnly(readCompany(clock)),
      'read-preferences': quickBooksOnly(readPreferences(clock)),
      'find-accounts': quickBooksOnly(findAccounts(clock)),
      extract: extract(EXTRACT_DOCUMENT_V1),
      'check-document': checkDocument(clock),
      'verify-read': verifyRead(VERIFY_DOCUMENT_V1),
      'find-vendor': quickBooksOnly(findVendor(clock)),
      'find-vendor-company': quickBooksOnly(findVendorCompany(clock)),
      'find-similar-vendors': quickBooksOnly(findSimilarVendors(clock)),
      'find-customer-name': quickBooksOnly(findCustomerName(clock)),
      'find-employee-name': quickBooksOnly(findEmployeeName(clock)),
      'find-duplicate-number': quickBooksOnly(findDuplicateNumber(clock, expenseSearch)),
      'find-duplicate-amount': quickBooksOnly(findDuplicateAmount(clock, expenseSearch)),
      'find-related': quickBooksOnly(findRelated(clock, expenseSearch)),
      'find-other-record': quickBooksOnly(findOtherRecord(clock, expenseSearch)),
      decide: quickBooksOnly(decide(expenseSearch)),
      'confirm-company': quickBooksOnly(confirmCompany(clock)),
      'confirm-vendor': quickBooksOnly(confirmVendor(clock)),
      'create-vendor': quickBooksOnly(createVendor()),
      'confirm-no-duplicate': quickBooksOnly(confirmNoDuplicate(clock)),
      'create-record': quickBooksOnly(createRecord()),
      'save-details': saveDetails,
      notify: notify(),
    },
    log,
  );
}

export interface Dependencies {
  /** The QuickBooks reads' clock: a suite passes one that does not wait. */
  readonly clock?: Clock;
  readonly log?: Logger;
  /** How expenses are searched (sandbox S4): `EXPENSE_SEARCH` unless a suite runs the other. */
  readonly expenseSearch?: ExpenseSearch;
}

/** The manifests this code serves, of those given: v2's alone. None is a container that cannot start. */
export function servedManifests(manifests: readonly Manifest[]): Manifest[] {
  const served = manifests.filter((manifest) =>
    (SERVED_VERSIONS as readonly number[]).includes(manifest.version),
  );
  if (served.length === 0) {
    throw new Error(
      `${TEMPLATE_ID} serves v${SERVED_VERSIONS.join(', v')}, and no such manifest was given`,
    );
  }
  return served;
}

export function define(
  manifests: readonly Manifest[],
  dependencies: Dependencies = {},
): Automation {
  const log = dependencies.log ?? jsonLogger(TEMPLATE_ID);
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: servedManifests(manifests),
    prompts: PROMPTS,
    steps: pipelineSteps(
      dependencies.clock ?? systemClock,
      dependencies.expenseSearch ?? EXPENSE_SEARCH,
      log,
    ),
    retry: RETRY,
    recover: recoverQuickBooks(log),
    // The details saved, a statement compared, or the record made (`src/output.ts`).
    result: (state, request) => {
      const { output, summary, details } = runResult(state, request);
      return { output, summary, details };
    },
  });
  return withFixedSentences(automation, log);
}
