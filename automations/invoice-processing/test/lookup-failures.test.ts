import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROVIDER_REFUSALS,
  QuickBooksSimulator,
  type ScriptedAnswer,
} from '@autom8x/automation-kit/testing';
import { defineAutomation } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture, refusalFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, pipelineSteps } from '../src/automation.js';
import { THROWN_SENTENCES, sentenceFor, withFixedSentences } from '../src/failures.js';
import { LOOKUP_SENTENCES, type LookupSentence } from '../src/lookups/read.js';
import { bill } from './check-world.js';
import { callsOf, everythingSaid, lines } from './fixtures.js';
import { LOOKUP_STEPS, reported, routeRun, stateOf } from './lookups-world.js';

/**
 * QuickBooks failing inside each lookup (steps 9–17) of a new vendor's bill — the one document that
 * runs all nine: a 429 waited out twice and a 5xx repeated once inside the step, every connection
 * and busy case ending with the kit's sentence and nothing after it, QuickBooks refusing a query
 * with the step's own, a body that is no answer, and a thrown 502 with the could-not-reach
 * sentence — never Intuit's words or the platform's raw problem.
 */

const RECONNECT = 'Reconnect QuickBooks in Connections, then run it again.';
const BUSY = 'QuickBooks is busy; run it again in a few minutes.';
const FORBIDDEN =
  'QuickBooks refused access to this company. Reconnect QuickBooks in Connections as a company admin, then run it again.';

/** The steps whose every failure ends the run, with the sentence of a refused query. */
const FAILING: readonly [string, LookupSentence, string][] = [
  ['find-vendor', 'vendor_refused', 'Vendor not looked up'],
  ['find-vendor-company', 'vendor_company_refused', 'Vendor not looked up by company name'],
  ['find-customer-name', 'customer_refused', 'Customer names not checked'],
  ['find-duplicate-number', 'number_refused', 'Number not searched'],
  ['find-duplicate-amount', 'amount_refused', 'Amount not searched'],
  ['find-related', 'related_refused', 'Related record not searched'],
  ['find-other-record', 'other_record_refused', 'Other records not searched'],
];

/** QuickBooks answers the steps before `stepId` — find-accounts', then each lookup's — then `answers`. */
function at(stepId: string, answers: ScriptedAnswer[]) {
  const before = 1 + LOOKUP_STEPS.indexOf(stepId as (typeof LOOKUP_STEPS)[number]);
  return {
    answer: bill(),
    bare: true,
    company: (sim: { script: (operation: string, answers: readonly ScriptedAnswer[]) => void }) =>
      sim.script('query.run', [
        ...Array.from({ length: before }, () => ({ status: 200 })),
        ...answers,
      ]),
  };
}

const CASES: {
  name: string;
  answers: ScriptedAnswer[];
  sentence: string;
  reason: string;
  calls: number;
}[] = [
  {
    name: 'no live connection',
    answers: [{ refuse: PROVIDER_REFUSALS.notConnected() }],
    sentence: RECONNECT,
    reason: 'qb_not_connected',
    calls: 1,
  },
  {
    name: 'QuickBooks 401',
    answers: [{ status: 401 }],
    sentence: RECONNECT,
    reason: 'qb_reauthorize',
    calls: 1,
  },
  {
    name: 'QuickBooks 403',
    answers: [{ status: 403 }],
    sentence: FORBIDDEN,
    reason: 'qb_forbidden',
    calls: 1,
  },
  {
    name: '429 three times',
    answers: [{ status: 429 }, { status: 429 }, { status: 429 }],
    sentence: BUSY,
    reason: 'qb_busy 429',
    calls: 3,
  },
  {
    name: '500 twice',
    answers: [{ status: 500 }, { status: 500 }],
    sentence: BUSY,
    reason: 'qb_busy 500',
    calls: 2,
  },
  {
    name: 'Connections not configured',
    answers: [{ refuse: PROVIDER_REFUSALS.notConfigured('query.run') }],
    sentence:
      'QuickBooks calls are not available on Autom8x right now. Nothing was created; run it again later.',
    reason: 'qb_not_configured',
    calls: 1,
  },
];

test('every connection and busy case at a lookup that ends the run: its sentence, its line, nothing after it', async () => {
  for (const [stepId, , what] of FAILING) {
    for (const { name, answers, sentence, reason, calls } of CASES) {
      const world = await routeRun(at(stepId, answers));
      assert.deepEqual(
        world.result,
        { outcome: 'failed', failureReason: sentence },
        `${stepId}: ${name}`,
      );
      assert.deepEqual(
        lines(world.platform).at(-1),
        [stepId, 'failed', `${what} (${reason})`],
        `${stepId}: ${name}`,
      );
      const sent = callsOf(world.platform, world.request, stepId);
      assert.equal(sent.length, calls, `${stepId}: ${name}`);
      assert.equal(new Set(sent.map((call) => JSON.stringify(call))).size, 1, 'one request');
    }
  }
});

test("QuickBooks refusing a lookup's query ends the run with that step's sentence, the code in its line, never Intuit's words", async () => {
  for (const [stepId, sentence, what] of FAILING) {
    const world = await routeRun(at(stepId, [{ status: 400 }]));
    assert.deepEqual(
      world.result,
      { outcome: 'failed', failureReason: LOOKUP_SENTENCES[sentence] },
      stepId,
    );
    assert.deepEqual(lines(world.platform).at(-1), [stepId, 'failed', `${what} (qb_error 400)`]);
    assert.ok(!everythingSaid(world.platform, world.result).includes('FAULT-TEXT'), stepId);
  }
  for (const sentence of Object.values(LOOKUP_SENTENCES)) {
    assert.ok(sentence.endsWith(' Nothing was created.') && sentence.length <= 200, sentence);
  }
});

test('a 429 is waited out twice and a 5xx repeated once inside the step, each the same request under its key; the run goes on', async () => {
  for (const stepId of LOOKUP_STEPS) {
    const throttled = await routeRun(
      at(stepId, [{ status: 429 }, { status: 429 }, { status: 200 }]),
    );
    assert.equal(
      throttled.result.outcome,
      'held',
      `${stepId}: held as a new vendor, as unthrottled`,
    );
    assert.deepEqual(throttled.waits, [60_000, 60_000], stepId);
    assert.equal(callsOf(throttled.platform, throttled.request, stepId).length, 3, stepId);
    const erred = await routeRun(at(stepId, [{ status: 503 }, { status: 200 }]));
    assert.equal(erred.result.outcome, 'held', stepId);
    assert.deepEqual(erred.waits, [], 'a 5xx is repeated at once');
    assert.equal(callsOf(erred.platform, erred.request, stepId).length, 2, stepId);
  }
});

test('the similar-names list and the employee check go on past what QuickBooks cannot answer, and fail on what the person must fix', async () => {
  const similar = await routeRun(at('find-similar-vendors', [{ status: 403 }]));
  assert.equal(similar.result.outcome, 'held');
  assert.equal(
    lines(similar.platform).find(([id]) => id === 'find-similar-vendors')?.[1],
    'failed',
  );
  const notConnected = await routeRun(
    at('find-similar-vendors', [{ refuse: PROVIDER_REFUSALS.notConnected() }]),
  );
  assert.deepEqual(notConnected.result, { outcome: 'failed', failureReason: RECONNECT });
  const busy = await routeRun(
    at('find-employee-name', [{ status: 429 }, { status: 429 }, { status: 429 }]),
  );
  assert.deepEqual(busy.result, { outcome: 'failed', failureReason: BUSY });
  assert.equal(reported(busy).at(-1), 'find-employee-name');
});

test('a body that is no query answer is the unexpected-answer sentence', async () => {
  const world = await routeRun(at('find-duplicate-amount', [{ status: 200, body: { Bill: [] } }]));
  assert.deepEqual(world.result, {
    outcome: 'failed',
    failureReason:
      'QuickBooks answered in an unexpected way. Run it again; if it repeats, reconnect QuickBooks.',
  });
  assert.deepEqual(lines(world.platform).at(-1), [
    'find-duplicate-amount',
    'failed',
    'Amount not searched (unexpected_answer)',
  ]);
});

test('a reasonless 502 thrown at a lookup ends with the could-not-reach sentence; the raw problem nowhere', async () => {
  const noAnswer = refusalFixture('provider', PROVIDER_REFUSALS.noAnswer());
  for (const stepId of LOOKUP_STEPS) {
    assert.equal(sentenceFor(stepId, noAnswer), THROWN_SENTENCES.quickbooks, stepId);
  }
  // Wired end to end: the step's throw, noted by the step table, becomes the run's sentence.
  const seeded = stateOf(
    (await routeRun({ answer: bill(), bare: true, through: 'find-employee-name' })).result,
  );
  const simulator = new QuickBooksSimulator({ refusal: refusalFixture });
  simulator.script('query.run', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]);
  const platform = new RecordingPlatform();
  platform.provider = simulator.provider;
  const steps = pipelineSteps({ now: () => Date.now(), sleep: () => Promise.resolve() }, 'amount');
  const automation = withFixedSentences(
    defineAutomation({
      templateId: TEMPLATE_ID,
      manifests: [
        {
          templateId: TEMPLATE_ID,
          version: 1,
          requiredCapabilities: [],
          pipeline: [{ id: 'seed' }, { id: 'find-duplicate-number' }],
        },
      ],
      steps: {
        seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: seeded }),
        'find-duplicate-number': steps['find-duplicate-number']!,
      },
      result: (state) => ({ output: state }),
    }),
    () => undefined,
  );
  const result = await automation.execute(
    invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 1 }),
    platform,
  );
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason: THROWN_SENTENCES.quickbooks,
  });
  assert.deepEqual(lines(platform).at(-1), [
    'find-duplicate-number',
    'failed',
    'The find-duplicate-number step failed',
  ]);
  const said = everythingSaid(platform, result);
  assert.ok(!said.includes('callback provider refused') && !said.includes('urn:autom8x'));
});
