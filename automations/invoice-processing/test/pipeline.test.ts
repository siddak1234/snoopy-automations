import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PROVIDER_REFUSALS } from '@autom8x/automation-kit/testing';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { QUICKBOOKS_STEPS } from '../src/failures.js';
import { DEFAULT_ACCOUNTS } from './extract-world.js';
import { FILE_ID, callsOf, everythingSaid, lines, manifestsRoot, setUp } from './fixtures.js';

/**
 * The six steps as one run: their order, the state they leave, the retry they
 * declare, and a fixed sentence for a run that ends on a thrown error.
 */

/** A run where an employee paid with their own money. */
const EMPLOYEE_PAID = {
  config: { expenseAccount: 'Utilities:Electric', teamOwedAccount: 'Owed to Team Members' },
  input: { invoiceFile: FILE_ID, paidPersonally: true, paidBy: 'Robin Example' },
};

/** Too close to the deadline for the SDK's 10-second retry: the first throw is the last. */
const NO_RETRY_MS = 5_000;

test('the six steps run in order, each under its own key, and leave the whole state; find-payer is skipped when the company paid', async () => {
  const world = setUp();
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
  ]);
  assert.deepEqual(result, {
    outcome: 'success',
    output: {
      file: {
        artifactId: FILE_ID,
        kind: 'pdf',
        sizeBytes: 184_203,
        pages: 2,
        sha256: 'ab'.repeat(32),
      },
      company: {
        name: 'Sample Bakery',
        legalName: 'Sample Bakery LLC',
        country: 'USA',
        payrollFeature: false,
      },
      preferences: {
        homeCurrency: 'USD',
        multiCurrencyEnabled: false,
        customTxnNumbers: false,
        purchaseCustomTxnNumbers: null,
        warnDuplicateBillNumber: false,
        bookCloseDate: '2025-12-31',
      },
      accounts: DEFAULT_ACCOUNTS,
      modelServed: 'anthropic/claude-haiku-4.5',
    },
    summary:
      "Checked the file, the QuickBooks company, its settings and the accounts in this flow's settings, and read the document",
  });
  for (const [stepId, operation] of [
    ['read-company', 'companyInfo.get'],
    ['read-preferences', 'preferences.get'],
    ['find-accounts', 'query.run'],
  ] as const) {
    assert.deepEqual(
      callsOf(world.platform, world.request, stepId).map((call) => call.operation),
      [operation],
    );
  }
  assert.equal(world.platform.providerCalls.length, 3);
  assert.deepEqual(world.platform.artifactReads, [FILE_ID]);
  assert.equal(world.platform.modelCalls.length, 1, 'one model call, by extract');
});

test('an employee who paid: find-payer runs after find-accounts and before the document is read, and the result names them', async () => {
  const world = setUp(EMPLOYEE_PAID);
  const result = await world.run();
  assert.deepEqual(
    lines(world.platform).map(([stepId]) => stepId),
    ['receive', 'read-company', 'read-preferences', 'find-accounts', 'find-payer', 'extract'],
  );
  assert.ok(result.outcome === 'success');
  assert.deepEqual(result.output?.payer, {
    route: 'employee',
    name: 'Robin Example',
    employeeId: '55',
    account: {
      id: '120',
      fullyQualifiedName: 'Owed to Team Members',
      accountType: 'Other Current Liability',
    },
  });
  assert.equal(world.platform.providerCalls.length, 4);
});

test('the v1 manifest declares the six steps in order, with neutral words, extract the AI step', () => {
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
    ],
  );
  assert.deepEqual(manifest.pipeline.at(-1), {
    id: 'extract',
    kicker: 'AI STEP',
    title: 'Read the document',
    description:
      'The AI reads the document: its type, the seller, its number, dates, amounts and lines.',
  });
  for (const step of manifest.pipeline) {
    assert.ok(!/invoice|bill\b/iu.test(`${step.title} ${step.description}`), step.id);
  }
});

test("the reads repeat a transient failure at the SDK's floor and ceilings; the model call only what never reached the platform", () => {
  const policy = { attempts: 3, backoffMs: 10_000 };
  assert.deepEqual(setUp().automation.retry, {
    receive: policy,
    'read-company': policy,
    'read-preferences': policy,
    'find-accounts': policy,
    'find-payer': policy,
    extract: { attempts: 2, backoffMs: 10_000, when: 'unsent' },
  });
  // A throw at every step that calls QuickBooks ends with QuickBooks' sentence.
  assert.deepEqual(
    [...QUICKBOOKS_STEPS],
    ['read-company', 'read-preferences', 'find-accounts', 'find-payer'],
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
