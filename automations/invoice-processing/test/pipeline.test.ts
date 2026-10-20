import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_REFUSALS, QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import type { JsonObject, StepContext } from '@autom8x/automation-sdk';
import { invokeFixture, refusalFixture } from '@autom8x/automation-sdk/testing';

import { EXPENSE_SEARCH } from '../src/lookups/expense-search.js';
import { TEMPLATE_ID, define, perDocumentSpecs, pipelineSteps } from '../src/automation.js';
import { RUN_LEVEL_STEPS, recoverQuickBooks } from '../src/failures.js';
import { runStateOf } from '../src/run/state.js';
import { RUN_FAILS } from '../src/words.js';
import { FILE_ID, NONE, QUICKBOOKS, callsOf, lines, manifests, setUp } from './fixtures.js';
import { V3_LOOKUP_STEPS, seededCompany } from './lookups-world.js';

/**
 * v3's 22 steps as one run, QuickBooks chosen: their order, the lines and the result of a bill
 * decided straight through and created — one AI read, the first showing no problem (decision 3) —
 * the code's steps against the manifest's, the retry each declares, and how a run ends on a
 * thrown error: a QuickBooks step that never answers saves the details instead (decision 6), per
 * document; any other ends in one of the spec's sentences (§3.F), never the error's own words.
 */

const CLOCK = { now: () => 0, sleep: () => Promise.resolve() };

/** The whole of v3, on a company that holds the sample bill's vendor. */
function wholeRun(options: Parameters<typeof setUp>[0] = {}) {
  const simulator = seededCompany(new QuickBooksSimulator({ refusal: refusalFixture }));
  simulator.expenseAmountSearchable = true;
  return setUp({ simulator, through: 'all', ...options });
}

test('the steps run in order, each QuickBooks call under its own key, one AI read, and a bill decided straight through is created and is the result', async () => {
  const world = wholeRun();
  const result = await world.run();
  assert.deepEqual(lines(world.platform), [
    ['receive', 'ok', 'PDF, 2 pages'],
    ['extract', 'ok', 'Read: bill from Harrowgate Office Supply, $461.53'],
    ['check-documents', 'ok', 'Checks passed'],
    ['read-company', 'ok', 'QuickBooks: Sample Bakery'],
    ['read-preferences', 'ok', 'Settings read'],
    ['find-accounts', 'ok', '18 accounts read'],
    ['find-vendors', 'ok', 'Vendor found'],
    ['find-duplicates', 'ok', 'No duplicate'],
    ['find-related', 'ok', 'No duplicate'],
    ['decide', 'ok', 'Ready to record'],
    ['create-records', 'ok', 'Recorded: bill HOS-1042, $461.53'],
  ]);
  assert.ok(result.outcome === 'success');
  assert.deepEqual(result.output, {
    outcome: 'documents',
    documents: [
      {
        index: 1,
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
    ],
  });
  assert.equal(
    result.summary,
    'Recorded in QuickBooks: bill from Harrowgate Office Supply, $461.53.',
  );
  const [document] = result.documents ?? [];
  assert.deepEqual(
    [document?.status, document?.statusText, document?.recordedIn, document?.details],
    [
      'recorded',
      'Recorded in QuickBooks: bill',
      {
        providerId: 'quickbooks',
        recordType: 'bill',
        recordId: '1001',
        accountName: 'Sample Bakery',
      },
      [
        { label: 'Category', value: 'Office Supplies' },
        { label: 'Decided', value: 'Automatically' },
        { label: 'Due', value: 'Oct 14, 2026' },
        { label: 'Shipping', value: '$15.00' },
      ],
    ],
  );
  // The run-level reads under the step's key; each document's calls under its part of it.
  for (const [stepId, part, operation] of [
    ['read-company', undefined, 'companyInfo.get'],
    ['read-preferences', undefined, 'preferences.get'],
    ['find-accounts', undefined, 'query.run'],
    ['find-vendors', 'd1', 'query.run'],
    ['find-duplicates', 'd1', 'query.run'],
    ['find-duplicates', 'd1-a', 'query.run'],
    ['find-related', 'd1', 'query.run'],
    ['find-related', 'd1-a', 'query.run'],
    ['create-records', 'd1', 'bill.create'],
  ] as const) {
    assert.deepEqual(
      callsOf(world.platform, world.request, stepId, part).map((call) => call.operation),
      [operation],
      `${stepId} ${part ?? ''}`,
    );
  }
  assert.equal(world.platform.providerCalls.length, 9, 'no key used twice');
  assert.deepEqual(world.platform.artifactReads, [FILE_ID]);
  assert.equal(world.platform.modelCalls.length, 1, 'one AI read: the first showed no problem');
  assert.deepEqual(
    world.platform.mails,
    [],
    'the run sends no mail: the platform sends the results (AM3)',
  );
});

test("the code's steps are the v3 manifest's, in its order: v2's one-document steps gone", () => {
  const [manifest] = manifests;
  const ids = manifest?.pipeline.map((step) => step.id) ?? [];
  assert.deepEqual(Object.keys(pipelineSteps(CLOCK, EXPENSE_SEARCH, () => undefined)), ids);
  assert.equal(ids.length, 22);
  for (const gone of ['check-document', 'find-vendor', 'create-record', 'save-details', 'notify']) {
    assert.ok(!ids.includes(gone), gone);
  }
});

test("the reads and the writes repeat a transient failure at the SDK's floor and ceilings; each model call only what never reached the platform; the steps that call nothing, none", () => {
  const policy = { attempts: 3, backoffMs: 10_000 };
  const model = { attempts: 2, backoffMs: 10_000, when: 'unsent' };
  const recheck = ['confirm-company', 'confirm-vendors', 'confirm-no-duplicates'];
  const writes = [
    'create-vendors',
    'create-records',
    'create-approved-vendors',
    'create-approved-records',
  ];
  const { retry } = define(manifests);
  assert.deepEqual(
    Object.fromEntries(Object.entries(retry).sort(([a], [b]) => a.localeCompare(b))),
    Object.fromEntries(
      [
        ['receive', policy],
        ['extract', model],
        ['verify-read', model],
        ...[...RUN_LEVEL_STEPS, ...V3_LOOKUP_STEPS, ...recheck].map((id) => [id, policy] as const),
        // Sandbox S6: Intuit answers a repeated request id with its first answer, never a second record.
        ...writes.map((id) => [id, policy] as const),
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    ),
  );
  for (const step of [
    'check-documents',
    'decide',
    'save-documents',
    'ask-approval',
    'save-approved',
  ]) {
    assert.equal(retry[step], undefined, step);
  }
  // Every QuickBooks step done per document saves that document's details when its attempts are spent.
  assert.deepEqual(
    Object.keys(perDocumentSpecs(CLOCK, EXPENSE_SEARCH)).sort(),
    [...V3_LOOKUP_STEPS, 'confirm-vendors', 'confirm-no-duplicates', ...writes].sort(),
  );
  assert.deepEqual(
    Object.entries(perDocumentSpecs(CLOCK, EXPENSE_SEARCH))
      .filter(([, spec]) => spec.writes === true)
      .map(([id]) => id)
      .sort(),
    [...writes].sort(),
  );
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
    assert.ok(result.outcome === 'success', stepId);
    assert.equal(result.summary, "Saved. Not recorded in QuickBooks: QuickBooks isn't connected.");
    assert.deepEqual(
      result.documents?.map((document) => document.status),
      ['not_recorded'],
    );
    const said = lines(world.platform);
    const at = said.findIndex(([id]) => id === stepId);
    assert.deepEqual(said.slice(at), [
      [stepId, 'failed', "Not recorded in QuickBooks: QuickBooks isn't connected"],
      ['decide', 'ok', "Not recorded in QuickBooks: QuickBooks isn't connected"],
      ['save-documents', 'ok', 'Saved: Harrowgate Office Supply, $461.53'],
    ]);
    assert.equal(
      world.platform.providerCalls.length,
      at - 2,
      'one call each, up to the one refused',
    );
  }
});

/** The run's state after `through`, for a bill on the made-up company. */
async function stateAfter(through: string): Promise<JsonObject> {
  const world = wholeRun({ through });
  const result = await world.run();
  assert.ok(result.outcome === 'success' && result.output, JSON.stringify(result).slice(0, 300));
  return result.output;
}

test("a QuickBooks step that THREW until its attempts were spent: the run's recover ends it for the documents it had not finished — a write unconfirmed — and logs the step, never the message", async () => {
  const logs: unknown[][] = [];
  const recoverOf = recoverQuickBooks(
    (...line) => logs.push(line),
    perDocumentSpecs(CLOCK, EXPENSE_SEARCH),
  );
  const error = refusalFixture('provider', PROVIDER_REFUSALS.noAnswer());
  const context = (stepId: string, config: JsonObject, state: JsonObject) =>
    ({
      request: invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 3, config }),
      stepId,
      state,
    }) as unknown as StepContext;
  const checked = await stateAfter('check-documents');
  const decided = await stateAfter('decide');
  const stopOf = (state: JsonObject | undefined) =>
    runStateOf(state ?? {})?.documents.map((entry) => entry.engine.quickBooks);
  // A run-level read: every document, for the whole run.
  const read = recoverOf('read-company', error, context('read-company', QUICKBOOKS, checked));
  assert.ok(read?.outcome === 'failed');
  assert.deepEqual(
    [read.summary, read.state?.quickBooks],
    [
      "Not recorded in QuickBooks: QuickBooks didn't answer",
      { notRecorded: "QuickBooks didn't answer" },
    ],
  );
  // A lookup: each document it had not finished, not recorded.
  const lookup = recoverOf('find-vendors', error, context('find-vendors', QUICKBOOKS, checked));
  assert.ok(lookup?.outcome === 'failed');
  assert.equal(lookup.summary, "Not recorded in QuickBooks: QuickBooks didn't answer");
  assert.deepEqual(stopOf(lookup.state), [{ notRecorded: "QuickBooks didn't answer" }]);
  // A write: QuickBooks may hold it — never "not recorded".
  const write = recoverOf('create-records', error, context('create-records', QUICKBOOKS, decided));
  assert.ok(write?.outcome === 'failed');
  assert.equal(
    write.summary,
    "QuickBooks didn't confirm. Check QuickBooks before you run it again.",
  );
  assert.deepEqual(stopOf(write.state), [{ unconfirmed: true }]);
  // Not a QuickBooks step, the vendor "None", or QuickBooks already stopped: the run ends as before.
  assert.equal(recoverOf('extract', error, context('extract', QUICKBOOKS, checked)), undefined);
  assert.equal(recoverOf('read-company', error, context('read-company', NONE, checked)), undefined);
  assert.equal(
    recoverOf(
      'read-company',
      error,
      context('read-company', QUICKBOOKS, { ...checked, quickBooks: { notRecorded: 'x' } }),
    ),
    undefined,
  );
  const logged = (stepId: string) => [
    'info',
    'quickbooks_step_gave_up',
    {
      runId: '11111111-1111-4111-8111-111111111111',
      stepId,
      error: 'CallbackRefusedError',
      status: 502,
      code: 'DEPENDENCY_FAILURE',
      reason: null,
    },
  ];
  assert.deepEqual(logs, [
    logged('read-company'),
    logged('find-vendors'),
    logged('create-records'),
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
