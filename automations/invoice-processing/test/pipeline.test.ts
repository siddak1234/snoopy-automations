import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_REFUSALS } from '@autom8x/automation-kit/testing';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { FILE_ID, callsOf, everythingSaid, lines, setUp } from './fixtures.js';

/**
 * The four steps as one run: their order, the state they leave, the retry they
 * declare, and a fixed sentence for a run that ends on a thrown error.
 */

/** Too close to the deadline for the SDK's 10-second retry: the first throw is the last. */
const NO_RETRY_MS = 5_000;

test('the four steps run in order, each under its own key, and leave the whole state', async () => {
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
    ['find-account', 'ok', 'Expense account: Utilities:Electric (QuickBooks Id 57)'],
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
      company: { name: 'Sample Bakery', legalName: 'Sample Bakery LLC', country: 'USA' },
      preferences: {
        homeCurrency: 'USD',
        multiCurrencyEnabled: false,
        customTxnNumbers: false,
        warnDuplicateBillNumber: false,
        bookCloseDate: '2025-12-31',
      },
      account: { id: '57', fullyQualifiedName: 'Utilities:Electric' },
    },
    summary:
      'Checked the invoice file, the QuickBooks company, its settings and the expense account',
  });
  for (const [stepId, operation] of [
    ['read-company', 'companyInfo.get'],
    ['read-preferences', 'preferences.get'],
    ['find-account', 'query.run'],
  ] as const) {
    assert.deepEqual(
      callsOf(world.platform, world.request, stepId).map((call) => call.operation),
      [operation],
    );
  }
  assert.equal(world.platform.providerCalls.length, 3);
  assert.deepEqual(world.platform.artifactReads, [FILE_ID]);
  assert.deepEqual(world.platform.modelCalls, []);
});

test("the four reads repeat a transient failure at the SDK's floor and ceilings", () => {
  const policy = { attempts: 3, backoffMs: 10_000 };
  assert.deepEqual(setUp().automation.retry, {
    receive: policy,
    'read-company': policy,
    'read-preferences': policy,
    'find-account': policy,
  });
});

test('a reasonless 502 thrown at a QuickBooks step ends with the could-not-reach sentence, and the raw problem nowhere', async () => {
  for (const operation of ['companyInfo.get', 'preferences.get', 'query.run']) {
    const world = setUp({ deadlineInMs: NO_RETRY_MS });
    world.simulator.script(operation, [{ refuse: PROVIDER_REFUSALS.noAnswer() }]);
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
        'The invoice file could not be read. Run it again in a few minutes; if it repeats, upload the file again.',
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
      "Invoice Processing stopped before it finished. Check the run's timeline before running it again.",
  });
  assert.equal(world.logs[0]?.[2]?.stepId, null);
});
