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
import { noteThrows, withFixedSentences } from './failures.js';
import { EXPENSE_SEARCH, type ExpenseSearch } from './lookups/expense-search.js';
import { runResult } from './output.js';
import { EXTRACT_DOCUMENT_V1, VERIFY_DOCUMENT_V1 } from './prompts.js';
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
import { findPayer } from './steps/find-payer.js';
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
import { verifyRead } from './steps/verify-read.js';

/**
 * Bills & Receipts (template `invoice-processing`) — records a bill, a receipt or a credit
 * note from a PDF or photo in QuickBooks Online, and compares a supplier's statement with it
 * (platform BUILD-PLAN 25.4.1; the owner's design of 2026-10-10 and plan of 2026-10-11).
 * Built in groups, each appending its steps to the v1 manifest: 24 of the 24 steps the platform
 * allows. v1 is registered (the platform's #205, 2026-10-12), so its manifest is immutable and a
 * change to it is a v2. The first five spend nothing; the sixth and the eighth are its two model
 * calls:
 *
 * - `receive` checks the file against the platform's measurements of it;
 * - `read-company` proves QuickBooks is connected and the company is in the US;
 * - `read-preferences` keeps the settings later steps read;
 * - `find-accounts` turns every account the flow's settings name into a QuickBooks account;
 * - `find-payer` finds who paid, when someone paid with their own money;
 * - `extract` has the platform's model read the document into its fields;
 * - `check-document` cleans what it read, routes it, and stops what can never be recorded;
 * - `verify-read` has another maker's model read it again, blind, and compares the two;
 * - the nine lookups (steps 9–17), one QuickBooks query each or skipped, per document type:
 *   `find-vendor` and `find-vendor-company` (the seller, or a contractor who paid),
 *   `find-similar-vendors`, `find-customer-name` and `find-employee-name` (a new vendor's checks),
 *   `find-duplicate-number`, `find-duplicate-amount`, `find-related` and `find-other-record`;
 * - `decide` (`src/decide/`) — one result: the record planned, one hold for every reason, a
 *   statement compared, or a fixed sentence;
 * - after an approval only, the checks a wait calls for (steps 19–22): `confirm-company`,
 *   `confirm-vendor`, `create-vendor` and `confirm-no-duplicate`;
 * - `create-record` — the one write, exactly the record decide saved (`src/writes/`);
 * - `notify` — the optional email to the "Also email" address.
 *
 * Its result is the record made, or a statement's comparison (`src/output.ts`).
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

/**
 * The two writes — create-vendor, create-record — repeated as the reads are, after a failure
 * nothing answered: no answer, or a 502/503/504 naming no reason (the owner's "Retry the
 * creates", 2026-10-12). Every attempt carries the step's one key, so the platform sends the same
 * `requestid`, and Intuit answers a repeated `requestid` with its first answer — the same record
 * and Id, never a second, for every record these steps make, two copies in flight and 75 minutes
 * later alike (sandbox S6). The kit's write throws those failures on (`writeQuickBooks`), and the
 * step registers its "did not confirm" sentence on them for when the attempts are spent; QuickBooks'
 * own 429 or 5xx, inside an answer, stays "did not confirm" at once. And once an attempt went
 * unanswered — it may have made the record — a refusal of a later one (no live connection, the
 * flood valve, a 400, a 403 at the deadline) is "did not confirm" too, never "nothing was created"
 * (Gate 25's AUT-38-1): the kit judges every attempt after one it threw on.
 */
const WRITE_RETRY: RetryPolicy = { attempts: 3, backoffMs: 10_000 };

/** The prompts the steps send, each registered with the runner. */
export const PROMPTS: readonly PromptModule[] = [EXTRACT_DOCUMENT_V1, VERIFY_DOCUMENT_V1];

/**
 * The steps repeated after a transient failure: every QuickBooks read and the file's, both writes
 * — the sandbox (S6) showed a repeated request id answered with the first answer, never Intuit's
 * Fault 600 nor a second record — and each model call only when it never reached the platform.
 * decide calls nothing, so it has none. notify catches its own failure, so a policy there would
 * never fire.
 */
export const RETRY: Readonly<Record<string, RetryPolicy>> = {
  receive: READ_RETRY,
  'read-company': READ_RETRY,
  'read-preferences': READ_RETRY,
  'find-accounts': READ_RETRY,
  'find-payer': READ_RETRY,
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
 * Every step v1's pipeline declares, in its order, each noting what it throws for the run's fixed
 * sentence. `expenseSearch` is sandbox S4's answer (`src/lookups/expense-search.ts`).
 */
export function pipelineSteps(clock: Clock, expenseSearch: ExpenseSearch): Record<string, Step> {
  return noteThrows({
    receive,
    'read-company': readCompany(clock),
    'read-preferences': readPreferences(clock),
    'find-accounts': findAccounts(clock),
    'find-payer': findPayer(clock),
    extract: extract(EXTRACT_DOCUMENT_V1),
    'check-document': checkDocument(clock),
    'verify-read': verifyRead(VERIFY_DOCUMENT_V1),
    'find-vendor': findVendor(clock),
    'find-vendor-company': findVendorCompany(clock),
    'find-similar-vendors': findSimilarVendors(clock),
    'find-customer-name': findCustomerName(clock),
    'find-employee-name': findEmployeeName(clock),
    'find-duplicate-number': findDuplicateNumber(clock, expenseSearch),
    'find-duplicate-amount': findDuplicateAmount(clock, expenseSearch),
    'find-related': findRelated(clock, expenseSearch),
    'find-other-record': findOtherRecord(clock, expenseSearch),
    decide: decide(expenseSearch),
    'confirm-company': confirmCompany(clock),
    'confirm-vendor': confirmVendor(clock),
    'create-vendor': createVendor(),
    'confirm-no-duplicate': confirmNoDuplicate(clock),
    'create-record': createRecord(),
    notify: notify(),
  });
}

export interface Dependencies {
  /** The QuickBooks reads' clock: a suite passes one that does not wait. */
  readonly clock?: Clock;
  readonly log?: Logger;
  /** How expenses are searched (sandbox S4): `EXPENSE_SEARCH` unless a suite runs the other. */
  readonly expenseSearch?: ExpenseSearch;
}

export function define(
  manifests: readonly Manifest[],
  dependencies: Dependencies = {},
): Automation {
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests,
    prompts: PROMPTS,
    steps: pipelineSteps(
      dependencies.clock ?? systemClock,
      dependencies.expenseSearch ?? EXPENSE_SEARCH,
    ),
    retry: RETRY,
    // A statement compared, or the record made (`src/output.ts`).
    result: (state, request) => runResult(state, request),
  });
  return withFixedSentences(automation, dependencies.log ?? jsonLogger(TEMPLATE_ID));
}
