import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PROVIDER_REFUSALS, QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import type { JsonObject } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { define } from '../src/automation.js';
import { QUICKBOOKS_STEPS } from '../src/failures.js';
import {
  FILE_ID,
  callsOf,
  everythingSaid,
  lines,
  manifests,
  manifestsRoot,
  setUp,
} from './fixtures.js';
import { LOOKUP_STEPS, seededCompany } from './lookups-world.js';

/**
 * The 24 steps as one run: their order, the lines and the result of a bill decided straight
 * through and created, the manifest that declares them, the retry each declares, and a fixed
 * sentence for a run that ends on a thrown error.
 */

/** A run where an employee paid with their own money. */
const EMPLOYEE_PAID = {
  config: { expenseAccount: 'Utilities:Electric', teamOwedAccount: 'Owed to Team Members' },
  input: { invoiceFile: FILE_ID, paidPersonally: true, paidBy: 'Robin Example' },
};

/** Too close to the deadline for the SDK's 10-second retry: the first throw is the last. */
const NO_RETRY_MS = 5_000;

/** The whole of v1, on a company that holds the sample bill's vendor. */
function wholeRun(options: Parameters<typeof setUp>[0] = {}) {
  const simulator = seededCompany(new QuickBooksSimulator({ refusal: refusalFixture }));
  simulator.expenseAmountSearchable = true;
  return setUp({ simulator, through: 'decide', ...options });
}

test('the steps run in order, each QuickBooks step under its own key, and a bill decided straight through is created and is the result', async () => {
  const world = wholeRun();
  const result = await world.run();
  assert.deepEqual(lines(world.platform), [
    ['receive', 'ok', 'Received a 2-page PDF, 184,203 bytes'],
    ['read-company', 'ok', 'QuickBooks company: Sample Bakery (US)'],
    [
      'read-preferences',
      'ok',
      'Home currency USD; multicurrency off; books closed through 2025-12-31',
    ],
    ['find-accounts', 'ok', 'Default category: Utilities:Electric (QuickBooks Id 57)'],
    ['extract', 'ok', 'Read the document with anthropic/claude-haiku-4.5: 2 lines, 0 unclear'],
    [
      'check-document',
      'ok',
      'Checks passed: a bill, $461.53, dated 2026-09-14, due 2026-10-14, HOS-1042, Harrowgate Office Supply',
    ],
    [
      'verify-read',
      'ok',
      'Read again by google/gemini-3.1-flash-lite: the 9 fields compared agree',
    ],
    [
      'find-vendor',
      'ok',
      "Found vendor 'Harrowgate Office Supply' in QuickBooks by its name (Id 7)",
    ],
    ['find-duplicate-number', 'ok', "Bills with number 'HOS-1042': none in QuickBooks"],
    [
      'find-duplicate-amount',
      'ok',
      'Bills from this vendor for $461.53 on 2026-09-14: none in QuickBooks',
    ],
    ['find-related', 'ok', "Expenses with number 'HOS-1042': none in QuickBooks"],
    ['find-other-record', 'ok', "Expenses for $461.53 near this bill's dates: none in QuickBooks"],
    [
      'decide',
      'ok',
      'No reason to hold: $461.53 within the $500 limit, Harrowgate Office Supply matched by display name, no duplicate; creating the bill; category Utilities:Electric (no category set for office supplies)',
    ],
    [
      'create-record',
      'ok',
      'Recorded bill 1001 from Harrowgate Office Supply, HOS-1042, $461.53, due 2026-10-14.',
    ],
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
        category: {
          id: '57',
          name: 'Utilities:Electric',
          why: 'no category set for office supplies',
        },
        paidFromAccount: null,
      },
      newVendor: null,
      payer: null,
      nextStep: null,
      holdReasons: [],
      decidedBy: 'automatically',
    },
    summary: 'Recorded bill 1001 from Harrowgate Office Supply, HOS-1042, $461.53, due 2026-10-14.',
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
  assert.equal(world.platform.modelCalls.length, 2, 'two model calls: extract, then verify-read');
});

test('an employee who paid: find-payer runs before the document is read, the vendor lookups are skipped, and decide holds naming them', async () => {
  const world = wholeRun(EMPLOYEE_PAID);
  const result = await world.run();
  assert.deepEqual(
    lines(world.platform).map(([stepId]) => stepId),
    [
      'receive',
      'read-company',
      'read-preferences',
      'find-accounts',
      'find-payer',
      'extract',
      'check-document',
      'verify-read',
      'find-duplicate-number',
      'find-duplicate-amount',
      'find-related',
      'decide',
    ],
  );
  assert.ok(result.outcome === 'held');
  assert.equal(result.held.stepId, 'decide');
  assert.equal(
    result.held.reason,
    'Paid personally: Robin Example paid Harrowgate Office Supply, $461.53',
  );
  assert.deepEqual((result.held.state as JsonObject).payer, {
    route: 'employee',
    id: '55',
    name: 'Robin Example',
    vendor1099: null,
  });
});

test('the v1 manifest declares the 24 steps in order, with neutral words, extract and verify-read the AI steps', () => {
  const manifest = JSON.parse(
    readFileSync(join(manifestsRoot, 'invoice-processing.v1.json'), 'utf8'),
  ) as { pipeline: { id: string; kicker: string; title: string; description: string }[] };
  assert.deepEqual(
    manifest.pipeline.map((step) => [step.id, step.kicker, step.title]),
    [
      ['receive', 'TRIGGER', 'Document received'],
      ['read-company', 'ACTION', 'Check the QuickBooks company'],
      ['read-preferences', 'ACTION', 'Read QuickBooks settings'],
      ['find-accounts', 'ACTION', "Find the accounts in this flow's settings"],
      ['find-payer', 'ACTION', 'Find who paid'],
      ['extract', 'AI STEP', 'Read the document'],
      ['check-document', 'ACTION', 'Check what the AI read'],
      ['verify-read', 'AI STEP', 'Read it a second time'],
      ['find-vendor', 'ACTION', 'Find the vendor in QuickBooks'],
      ['find-vendor-company', 'ACTION', 'Find the vendor by company name'],
      ['find-similar-vendors', 'ACTION', 'Look for similar vendor names'],
      ['find-customer-name', 'ACTION', 'Check customer names'],
      ['find-employee-name', 'ACTION', 'Check employee names'],
      ['find-duplicate-number', 'ACTION', 'Look for this number in QuickBooks'],
      ['find-duplicate-amount', 'ACTION', 'Look for this amount in QuickBooks'],
      ['find-related', 'ACTION', 'Look for a related record'],
      ['find-other-record', 'ACTION', 'Look for the same purchase recorded another way'],
      ['decide', 'ACTION', 'Decide: record it or hold it for approval'],
      ['confirm-company', 'ACTION', 'Check it is still the same QuickBooks company'],
      ['confirm-vendor', 'ACTION', 'Check whether the new vendor was added'],
      ['create-vendor', 'ACTION', 'Add the new vendor to QuickBooks'],
      ['confirm-no-duplicate', 'ACTION', 'Check no copy was added while it waited'],
      ['create-record', 'ACTION', 'Record it in QuickBooks'],
      ['notify', 'ACTION', 'Email a summary'],
    ],
  );
  assert.deepEqual(manifest.pipeline.slice(5, 8), [
    {
      id: 'extract',
      kicker: 'AI STEP',
      title: 'Read the document',
      description:
        'The AI reads the document: its type, the seller, its number, dates, amounts and lines.',
    },
    {
      id: 'check-document',
      kicker: 'ACTION',
      title: 'Check what the AI read',
      description:
        'Cleans what the AI read, chooses the record the document becomes, and stops when none can be recorded correctly, before anything else is spent.',
    },
    {
      id: 'verify-read',
      kicker: 'AI STEP',
      title: 'Read it a second time',
      description:
        'A second AI, by another maker, reads the type and what will be recorded without seeing the first reading; code compares the two.',
    },
  ]);
  assert.equal(
    manifest.pipeline.find((step) => step.id === 'decide')?.description,
    'Decides in code from everything found: record it, hold it once with every reason for an owner or admin, or stop with one plain sentence. Statements are compared only.',
  );
  for (const step of manifest.pipeline) {
    assert.ok(!/invoice|bill\b/iu.test(`${step.title} ${step.description}`), step.id);
    assert.ok(step.title.length <= 80 && step.description.length <= 200, step.id);
  }
});

test("the reads repeat a transient failure at the SDK's floor and ceilings; each model call only what never reached the platform; decide, the writes and notify none", () => {
  const policy = { attempts: 3, backoffMs: 10_000 };
  const model = { attempts: 2, backoffMs: 10_000, when: 'unsent' };
  const recheck = ['confirm-company', 'confirm-vendor', 'confirm-no-duplicate'];
  assert.deepEqual(define(manifests).retry, {
    receive: policy,
    'read-company': policy,
    'read-preferences': policy,
    'find-accounts': policy,
    'find-payer': policy,
    extract: model,
    'verify-read': model,
    ...Object.fromEntries(LOOKUP_STEPS.map((stepId) => [stepId, policy])),
    ...Object.fromEntries(recheck.map((stepId) => [stepId, policy])),
  });
  // No write is ever repeated in v1 (until sandbox S6): no policy on create-vendor or create-record.
  for (const write of ['create-vendor', 'create-record', 'notify', 'decide']) {
    assert.equal(define(manifests).retry[write], undefined, write);
  }
  // A throw at every step that reads QuickBooks ends with QuickBooks' sentence.
  assert.deepEqual(
    [...QUICKBOOKS_STEPS],
    [
      'read-company',
      'read-preferences',
      'find-accounts',
      'find-payer',
      ...LOOKUP_STEPS,
      ...recheck,
    ],
  );
});

test('a reasonless 502 thrown at a QuickBooks step ends with the could-not-reach sentence, and the raw problem nowhere', async () => {
  const throwing = [
    ['companyInfo.get', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]],
    ['preferences.get', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]],
    ['query.run', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]],
    // find-accounts answered, then find-payer's employee lookup.
    ['query.run', [{ status: 200 }, { refuse: PROVIDER_REFUSALS.noAnswer() }]],
  ] as const;
  for (const [operation, script] of throwing) {
    const world = setUp({ deadlineInMs: NO_RETRY_MS, ...EMPLOYEE_PAID });
    world.simulator.script(operation, script);
    const result = await world.run();
    assert.deepEqual(result, {
      outcome: 'failed',
      failureReason:
        'Autom8x could not reach QuickBooks. Run it again in a few minutes; nothing was created.',
    });
    const stepId = lines(world.platform).at(-1)?.[0];
    assert.deepEqual(lines(world.platform).at(-1), [stepId, 'failed', `The ${stepId} step failed`]);
    const said = everythingSaid(world.platform, result);
    assert.ok(!said.includes('callback provider refused') && !said.includes('urn:autom8x'), said);
    // One log line: the step, the status, the code — never the message.
    assert.deepEqual(world.logs, [
      [
        'error',
        'run_failed_on_a_throw',
        {
          runId: world.request.runId,
          stepId,
          error: 'CallbackRefusedError',
          status: 502,
          code: 'DEPENDENCY_FAILURE',
          reason: null,
        },
      ],
    ]);
  }
});

test("a throw at receive ends with the file sentence; past the deadline at a read, QuickBooks' sentence", async () => {
  const thrown = [
    [new TypeError('fetch failed'), { error: 'TypeError' }],
    [
      refusalFixture('artifact', PROVIDER_REFUSALS.noAnswer()),
      { error: 'CallbackRefusedError', status: 502, code: 'DEPENDENCY_FAILURE', reason: null },
    ],
  ] as const;
  for (const [error, logged] of thrown) {
    const world = setUp({ deadlineInMs: NO_RETRY_MS });
    world.platform.readArtifact = () => Promise.reject(error);
    assert.deepEqual(await world.run(), {
      outcome: 'failed',
      failureReason:
        'The document file could not be read. Run it again in a few minutes; if it repeats, upload the file again.',
    });
    assert.deepEqual(world.platform.providerCalls, []);
    // The error's name, and for a refusal its status, code and reason: never its message.
    assert.deepEqual(world.logs, [
      [
        'error',
        'run_failed_on_a_throw',
        { runId: world.request.runId, stepId: 'receive', ...logged },
      ],
    ]);
  }
  const late = setUp();
  late.simulator.script('query.run', [
    {
      refuse: {
        status: 403,
        code: 'FORBIDDEN',
        detail: 'The run deadline has passed',
        details: { reason: 'deadline_exceeded' },
      },
    },
  ]);
  assert.deepEqual(await late.run(), {
    outcome: 'failed',
    failureReason:
      'Autom8x could not reach QuickBooks. Run it again in a few minutes; nothing was created.',
  });
});

test("the Edge's flood valve (a callback refused 429) ends with Autom8x is busy, at any step", async () => {
  const flood = { status: 429, code: 'TOO_MANY_REQUESTS', detail: 'Too many requests' };
  const quickbooks = setUp();
  quickbooks.simulator.script('preferences.get', [{ refuse: flood }]);
  const atRead = await quickbooks.run();
  const receiving = setUp();
  receiving.platform.readArtifact = () => Promise.reject(refusalFixture('artifact', flood));
  const atReceive = await receiving.run();
  for (const result of [atRead, atReceive]) {
    assert.deepEqual(result, {
      outcome: 'failed',
      failureReason: 'Autom8x is busy; run it again in a few minutes.',
    });
  }
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
  assert.deepEqual(await world.run(), {
    outcome: 'failed',
    failureReason:
      "Bills & Receipts stopped before it finished. Check the run's timeline before running it again.",
  });
  assert.equal(world.logs[0]?.[2]?.stepId, null);
});
