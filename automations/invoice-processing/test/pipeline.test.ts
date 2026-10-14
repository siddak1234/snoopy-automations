import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_REFUSALS, QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import type { JsonObject, StepContext } from '@autom8x/automation-sdk';
import { invokeFixture, refusalFixture } from '@autom8x/automation-sdk/testing';

import { EXPENSE_SEARCH } from '../src/lookups/expense-search.js';
import { TEMPLATE_ID, define, pipelineSteps } from '../src/automation.js';
import { QUICKBOOKS_STEPS, WRITE_STEPS, recoverQuickBooks } from '../src/failures.js';
import { RUN_FAILS } from '../src/words.js';
import { FILE_ID, NONE, QUICKBOOKS, callsOf, lines, manifests, setUp } from './fixtures.js';
import { LOOKUP_STEPS, seededCompany } from './lookups-world.js';

/**
 * v2's 24 steps as one run, QuickBooks chosen: their order, the lines and the result of a bill
 * decided straight through and created — one AI read, the first showing no problem (decision 3) —
 * the code's steps against the manifest's, the retry each declares, and how a run ends on a
 * thrown error: a QuickBooks step that never answers saves the details instead (decision 6); any
 * other ends in one of the spec's sentences (§3.F), never the error's own words.
 */

/** The whole of v2, on a company that holds the sample bill's vendor. */
function wholeRun(options: Parameters<typeof setUp>[0] = {}) {
  const simulator = seededCompany(new QuickBooksSimulator({ refusal: refusalFixture }));
  simulator.expenseAmountSearchable = true;
  return setUp({ simulator, through: 'all', ...options });
}

test('the steps run in order, each QuickBooks step under its own key, one AI read, and a bill decided straight through is created and is the result', async () => {
  const world = wholeRun();
  const result = await world.run();
  assert.deepEqual(lines(world.platform), [
    ['receive', 'ok', 'PDF, 2 pages'],
    ['read-company', 'ok', 'QuickBooks: Sample Bakery'],
    ['read-preferences', 'ok', 'Settings read'],
    ['find-accounts', 'ok', '18 accounts read'],
    ['extract', 'ok', 'Read: bill from Harrowgate Office Supply, $461.53'],
    ['check-document', 'ok', 'Checks passed'],
    ['find-vendor', 'ok', 'Vendor found'],
    ['find-duplicate-number', 'ok', 'No duplicate'],
    ['find-duplicate-amount', 'ok', 'No duplicate'],
    ['find-related', 'ok', 'No duplicate'],
    ['find-other-record', 'ok', 'No duplicate'],
    ['decide', 'ok', 'Ready to record'],
    ['create-record', 'ok', 'Recorded: bill HOS-1042, $461.53'],
  ]);
  assert.deepEqual(result, {
    outcome: 'success',
    output: {
      outcome: 'recorded',
      documentType: 'bill',
      route: 'bill',
      record: {
        type: 'bill',
        id: '1001',
        operation: 'bill.create',
        paymentType: null,
        amountCents: 46153,
        quickBooksTotalCents: 46153,
        date: '2026-09-14',
        dueDate: '2026-10-14',
        docNumber: 'HOS-1042',
        documentNumber: 'HOS-1042',
        payee: { kind: 'vendor', id: '7', name: 'Harrowgate Office Supply' },
        category: { id: '64', name: 'Office Supplies', why: 'its name' },
        paidFromAccount: null,
      },
      newVendor: null,
      nextStep: null,
      holdReasons: [],
      decidedBy: 'automatically',
    },
    summary: 'Recorded in QuickBooks: bill from Harrowgate Office Supply, $461.53.',
    details: [
      { label: 'Recorded as', value: 'Bill' },
      { label: 'Vendor', value: 'Harrowgate Office Supply' },
      { label: 'Number', value: 'HOS-1042' },
      { label: 'Date', value: 'Sep 14, 2026' },
      { label: 'Due', value: 'Oct 14, 2026' },
      { label: 'Total', value: '$461.53' },
      { label: 'Category', value: 'Office Supplies' },
      { label: 'Decided', value: 'Automatically' },
    ],
  });
  for (const [stepId, operation] of [
    ['read-company', 'companyInfo.get'],
    ['read-preferences', 'preferences.get'],
    ['find-accounts', 'query.run'],
    ['find-vendor', 'query.run'],
    ['find-duplicate-number', 'query.run'],
    ['find-duplicate-amount', 'query.run'],
    ['find-related', 'query.run'],
    ['find-other-record', 'query.run'],
    ['create-record', 'bill.create'],
  ] as const) {
    assert.deepEqual(
      callsOf(world.platform, world.request, stepId).map((call) => call.operation),
      [operation],
      stepId,
    );
  }
  assert.equal(world.platform.providerCalls.length, 9, 'no step called QuickBooks twice');
  assert.deepEqual(world.platform.artifactReads, [FILE_ID]);
  assert.equal(world.platform.modelCalls.length, 1, 'one AI read: the first showed no problem');
});

test("the code's steps are the v2 manifest's, in its order: find-payer gone, save-details in", () => {
  const [manifest] = manifests;
  const ids = manifest?.pipeline.map((step) => step.id) ?? [];
  const clock = { now: () => 0, sleep: () => Promise.resolve() };
  assert.deepEqual(Object.keys(pipelineSteps(clock, EXPENSE_SEARCH, () => undefined)), ids);
  assert.equal(ids.length, 24);
  assert.ok(!ids.includes('find-payer') && ids.includes('save-details'));
});

test("the reads and the two writes repeat a transient failure at the SDK's floor and ceilings; each model call only what never reached the platform; decide, save-details and notify none", () => {
  const policy = { attempts: 3, backoffMs: 10_000 };
  const model = { attempts: 2, backoffMs: 10_000, when: 'unsent' };
  const recheck = ['confirm-company', 'confirm-vendor', 'confirm-no-duplicate'];
  assert.deepEqual(define(manifests).retry, {
    receive: policy,
    'read-company': policy,
    'read-preferences': policy,
    'find-accounts': policy,
    extract: model,
    'verify-read': model,
    ...Object.fromEntries(LOOKUP_STEPS.map((stepId) => [stepId, policy])),
    ...Object.fromEntries(recheck.map((stepId) => [stepId, policy])),
    // Sandbox S6: Intuit answers a repeated request id with its first answer, never a second record.
    'create-vendor': policy,
    'create-record': policy,
  });
  for (const step of ['notify', 'decide', 'save-details', 'check-document']) {
    assert.equal(define(manifests).retry[step], undefined, step);
  }
  // Every step that calls QuickBooks saves the details when its attempts are spent.
  assert.deepEqual(
    [...QUICKBOOKS_STEPS].sort(),
    [
      'read-company',
      'read-preferences',
      'find-accounts',
      ...LOOKUP_STEPS,
      ...recheck,
      'create-vendor',
      'create-record',
    ].sort(),
  );
  assert.deepEqual([...WRITE_STEPS], ['create-vendor', 'create-record']);
});

test('QuickBooks failing at a read saves the details instead (decision 6): not recorded, nothing more asked of QuickBooks', async () => {
  for (const [operation, stepId] of [
    ['companyInfo.get', 'read-company'],
    ['preferences.get', 'read-preferences'],
    ['query.run', 'find-accounts'],
  ] as const) {
    const world = wholeRun();
    world.simulator.script(operation, [{ refuse: PROVIDER_REFUSALS.notConnected() }]);
    const result = await world.run();
    assert.equal(result.outcome, 'success', stepId);
    assert.equal(
      (result as { summary?: string }).summary,
      "Saved. Not recorded in QuickBooks: QuickBooks isn't connected.",
    );
    const said = lines(world.platform);
    const at = said.findIndex(([id]) => id === stepId);
    assert.deepEqual(said[at], [
      stepId,
      'failed',
      "Not recorded in QuickBooks: QuickBooks isn't connected",
    ]);
    assert.deepEqual(said.slice(at + 1), [
      ['extract', 'ok', 'Read: bill from Harrowgate Office Supply, $461.53'],
      ['check-document', 'ok', 'Checks passed'],
      ['save-details', 'ok', 'Saved: Harrowgate Office Supply, $461.53'],
    ]);
    assert.equal(world.platform.providerCalls.length, at, 'one call each, up to the one refused');
  }
});

test("a QuickBooks step that THREW until its attempts were spent: the run's recover ends it not recorded — a write, unconfirmed — and logs the step, never the message", () => {
  const logs: unknown[][] = [];
  const recoverOf = recoverQuickBooks((...line) => logs.push(line));
  const error = refusalFixture('provider', PROVIDER_REFUSALS.noAnswer());
  const context = (config: JsonObject, state: JsonObject = {}) =>
    ({
      request: invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 2, config }),
      state,
    }) as unknown as StepContext;
  assert.deepEqual(recoverOf('find-vendor', error, context(QUICKBOOKS)), {
    outcome: 'failed',
    summary: "Not recorded in QuickBooks: QuickBooks didn't answer",
    state: { quickBooks: { notRecorded: "QuickBooks didn't answer" } },
  });
  assert.deepEqual(recoverOf('create-record', error, context(QUICKBOOKS)), {
    outcome: 'failed',
    summary: "QuickBooks didn't confirm. Check QuickBooks before you run it again.",
    state: { quickBooks: { unconfirmed: true } },
  });
  // Not a QuickBooks step, the vendor "None", or QuickBooks already stopped: the run ends as before.
  assert.equal(recoverOf('extract', error, context(QUICKBOOKS)), undefined);
  assert.equal(recoverOf('find-vendor', error, context(NONE)), undefined);
  assert.equal(
    recoverOf('find-vendor', error, context(QUICKBOOKS, { quickBooks: { notRecorded: 'x' } })),
    undefined,
  );
  assert.deepEqual(logs, [
    [
      'info',
      'quickbooks_step_gave_up',
      {
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'find-vendor',
        error: 'CallbackRefusedError',
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        reason: null,
      },
    ],
    [
      'info',
      'quickbooks_step_gave_up',
      {
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'create-record',
        error: 'CallbackRefusedError',
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        reason: null,
      },
    ],
  ]);
});

test('a throw at receive ends with the file sentence, its error never in the log beyond its name and status', async () => {
  const thrown = [
    [new TypeError('fetch failed'), { error: 'TypeError' }],
    [
      refusalFixture('artifact', PROVIDER_REFUSALS.noAnswer()),
      { error: 'CallbackRefusedError', status: 502, code: 'DEPENDENCY_FAILURE', reason: null },
    ],
  ] as const;
  for (const [error, logged] of thrown) {
    const world = setUp({ deadlineInMs: 5_000 });
    world.platform.readArtifact = () => Promise.reject(error);
    assert.deepEqual(await world.run(), { outcome: 'failed', failureReason: RUN_FAILS.file });
    assert.deepEqual(world.platform.providerCalls, []);
    assert.deepEqual(world.logs, [
      [
        'error',
        'run_failed_on_a_throw',
        { runId: world.request.runId, stepId: 'receive', ...logged },
      ],
    ]);
  }
});

test("the Edge's flood valve (a callback refused 429): at receive, the general sentence; at a QuickBooks step, the details saved", async () => {
  const flood = { status: 429, code: 'TOO_MANY_REQUESTS', detail: 'Too many requests' };
  const receiving = setUp();
  receiving.platform.readArtifact = () => Promise.reject(refusalFixture('artifact', flood));
  assert.deepEqual(await receiving.run(), { outcome: 'failed', failureReason: RUN_FAILS.other });
  const quickBooks = wholeRun();
  quickBooks.simulator.script('preferences.get', [{ refuse: flood }]);
  const atRead = await quickBooks.run();
  assert.equal(atRead.outcome, 'success');
  assert.equal(
    (atRead as { summary?: string }).summary,
    "Saved. Not recorded in QuickBooks: QuickBooks didn't answer.",
  );
});

test('a throw outside any step ends with the general sentence', async () => {
  const world = setUp();
  world.platform.reportStep = () =>
    Promise.reject(
      refusalFixture('step', {
        status: 422,
        code: 'BAD_REQUEST',
        detail: 'x',
        details: { reason: 'step_not_declared' },
      }),
    );
  assert.deepEqual(await world.run(), { outcome: 'failed', failureReason: RUN_FAILS.other });
  assert.equal(world.logs[0]?.[2]?.stepId, null);
});
