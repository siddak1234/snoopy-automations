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

import { noteThrows, recoverQuickBooks, withFixedSentences } from './failures.js';
import { EXPENSE_SEARCH, type ExpenseSearch } from './lookups/expense-search.js';
import { EXTRACT_DOCUMENTS_V1, VERIFY_DOCUMENTS_V1 } from './prompts.js';
import { askApproval, confirmCompanyOnce, saveApproved, saveDocuments } from './run/approval.js';
import { checkDocuments } from './run/check.js';
import { decide } from './run/decide.js';
import { extract } from './run/extract.js';
import { fanOut, type FanOut } from './run/fan-out.js';
import { lookupSpecs } from './run/lookups.js';
import { onceForAll, withOwnCompany } from './run/quickbooks.js';
import { runResult } from './run/result.js';
import { verifyRead } from './run/verify.js';
import { writeSpecs } from './run/writes.js';
import { findAccounts } from './steps/find-accounts.js';
import { readCompany } from './steps/read-company.js';
import { readPreferences } from './steps/read-preferences.js';
import { receive } from './steps/receive.js';

/**
 * Invoice Processing (template `invoice-processing`), version 4 — reads EVERY bill, invoice,
 * receipt, credit note, statement and other financial document in a PDF or photo, each on its own,
 * then saves each one's details, or records or compares it in QuickBooks Online (the platform's
 * BUILD-PLAN 25.4.31–25.4.36; the session's spec of 2026-10-15, §3, as the owner's corrections
 * AM1–AM8 of that evening change it: no limit but size, every financial document goes through,
 * every document carries its numbers). v1, v2 and v3, under their own names, are registered and
 * immutable: their containers keep their pinned images until they are retired, and THIS code serves
 * v5 alone (`SERVED_VERSIONS`; the platform's D2, one container per manifest version). v5 (Build 23)
 * is v4 with step 5 named "Run completed" — done only when the run succeeds (the owner's build 22
 * feedback); nothing else changed.
 *
 * v4 (Build 22, the platform's BUILD-PLAN 25.4.54; the session's spec of 2026-10-17, §3) is v3's
 * code and v3's 22 steps, unchanged, shown in the five steps the owner asked for on build 21
 * (2026-10-17: "1. Upooad Invoice / 2. Connect integration … / 3. Then something about AI
 * Processing / 4. Quickbooks updated / 5. Email sent") — Upload invoice · Connect integration · AI
 * processing · QuickBooks updated, or Details saved with "None" · Email sent. The groups are the
 * manifest's alone: `receive` is step 1; step 2 holds no step, only the vendor choice; `extract`,
 * `check-documents` and `verify-read` are step 3; the other 18 are step 4; step 5 is the
 * platform's, which mails each run's results. This code reports every step by its id, as v3's did.
 *
 * Its 22 steps:
 *
 * - `receive` checks the file against the platform's measurements of it (v2's, unchanged);
 * - `extract` has the platform's model read every document, a part at a time, in ONE call for a
 *   few receipts; `check-documents` cleans and checks each; `verify-read`, ONE second read by
 *   another maker for every doubtful document, only when there is one;
 * - on the QuickBooks path: `read-company`, `read-preferences` and `find-accounts` once for all;
 *   the four lookups once per document; `decide` for each; then the vendors added and the records
 *   created, each document's writes under its own key;
 * - `save-documents`; `ask-approval`, ONE approval for every document that waits; and after it the
 *   checks an approval repeats, the writes, and `save-approved`.
 *
 * The vendor choice is the flow's `vendor` setting (`automations/invoice-processing/src/quickbooks-path.ts`): "None" reads and
 * saves, and calls QuickBooks for nothing. One document never fails another or the run; QuickBooks
 * failing mid-run saves the details instead (v2's decision 6, per document). The result is every
 * document, whole (`automations/invoice-processing/src/run/documents.ts`), the summary, and the structured output.
 */
export const TEMPLATE_ID = 'invoice-processing';

/** The manifest versions this code serves: v4 alone. v1's, v2's and v3's containers run their own images. */
export const SERVED_VERSIONS = [5] as const;

/**
 * The QuickBooks reads and the file's, each repeated after a TRANSIENT failure — no answer, or a
 * 502/503/504 naming no reason — at the SDK's floor and ceilings: three attempts, 10 s then 20 s,
 * never past the deadline. A repeat sends the same request under the same key, which the platform
 * answers from its record when it has one; a step done per document goes on from the document it
 * failed at (`automations/invoice-processing/src/run/fan-out.ts`).
 */
const READ_RETRY: RetryPolicy = { attempts: 3, backoffMs: 10_000 };

/**
 * Each model call, repeated once, 10 s later, and only when it provably never reached the
 * platform (the owner's decision of 2026-10-10, and D8 for a 503 naming no code): a call that
 * reached it may have been made and billed, and nothing deduplicates a second one. A file read in
 * parts goes on from the part it was reading.
 */
const MODEL_RETRY: RetryPolicy = { attempts: 2, backoffMs: 10_000, when: 'unsent' };

/**
 * The writes, repeated as the reads are, after a failure nothing answered (the owner's "Retry the
 * creates", 2026-10-12): every attempt carries the same key, so the same `requestid`, which Intuit
 * answers with its first answer — the same record and Id, never a second (sandbox S6).
 */
const WRITE_RETRY: RetryPolicy = { attempts: 3, backoffMs: 10_000 };

/** The prompts the steps send, each registered with the runner. */
export const PROMPTS: readonly PromptModule[] = [EXTRACT_DOCUMENTS_V1, VERIFY_DOCUMENTS_V1];

/**
 * The steps repeated after a transient failure: every QuickBooks read and the file's, the writes,
 * and each model call only when it never reached the platform. The steps that call nothing —
 * check-documents, decide, save-documents, ask-approval, save-approved — have none.
 */
export const RETRY: Readonly<Record<string, RetryPolicy>> = {
  receive: READ_RETRY,
  extract: MODEL_RETRY,
  'verify-read': MODEL_RETRY,
  'read-company': READ_RETRY,
  'read-preferences': READ_RETRY,
  'find-accounts': READ_RETRY,
  'find-vendors': READ_RETRY,
  'find-names': READ_RETRY,
  'find-duplicates': READ_RETRY,
  'find-related': READ_RETRY,
  'create-vendors': WRITE_RETRY,
  'create-records': WRITE_RETRY,
  'confirm-company': READ_RETRY,
  'confirm-vendors': READ_RETRY,
  'create-approved-vendors': WRITE_RETRY,
  'confirm-no-duplicates': READ_RETRY,
  'create-approved-records': WRITE_RETRY,
};

/** The steps done once per document, by id: the lookups and the writes. */
export function perDocumentSpecs(clock: Clock, how: ExpenseSearch): Record<string, FanOut> {
  return { ...lookupSpecs(clock, how), ...writeSpecs(clock) };
}

/**
 * Every step v4's pipeline declares — v3's, unchanged — in its order, each noting what it throws for the run's fixed
 * sentence and logging the reason code it ends with. `expenseSearch` is sandbox S4's answer
 * (`automations/invoice-processing/src/lookups/expense-search.ts`).
 */
export function pipelineSteps(
  clock: Clock,
  expenseSearch: ExpenseSearch,
  log: Logger,
): Record<string, Step> {
  const each = Object.fromEntries(
    Object.entries(perDocumentSpecs(clock, expenseSearch)).map(([id, spec]) => [id, fanOut(spec)]),
  );
  return noteThrows(
    {
      receive,
      extract: extract(EXTRACT_DOCUMENTS_V1),
      'check-documents': checkDocuments(clock),
      'verify-read': verifyRead(VERIFY_DOCUMENTS_V1, clock),
      'read-company': onceForAll(readCompany(clock), withOwnCompany),
      'read-preferences': onceForAll(readPreferences(clock)),
      'find-accounts': onceForAll(findAccounts(clock)),
      'find-vendors': each['find-vendors']!,
      'find-names': each['find-names']!,
      'find-duplicates': each['find-duplicates']!,
      'find-related': each['find-related']!,
      decide: decide(expenseSearch),
      'create-vendors': each['create-vendors']!,
      'create-records': each['create-records']!,
      'save-documents': saveDocuments,
      'ask-approval': askApproval,
      'confirm-company': confirmCompanyOnce(clock),
      'confirm-vendors': each['confirm-vendors']!,
      'create-approved-vendors': each['create-approved-vendors']!,
      'confirm-no-duplicates': each['confirm-no-duplicates']!,
      'create-approved-records': each['create-approved-records']!,
      'save-approved': saveApproved,
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

/** The manifests this code serves, of those given: v5's alone. None is a container that cannot start. */
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
  const clock = dependencies.clock ?? systemClock;
  const expenseSearch = dependencies.expenseSearch ?? EXPENSE_SEARCH;
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: servedManifests(manifests),
    prompts: PROMPTS,
    steps: pipelineSteps(clock, expenseSearch, log),
    retry: RETRY,
    recover: recoverQuickBooks(log, perDocumentSpecs(clock, expenseSearch)),
    // Every document, whole; the summary; and the structured output (`automations/invoice-processing/src/run/result.ts`).
    result: (state, request) => runResult(state, request),
  });
  return withFixedSentences(automation, log);
}
