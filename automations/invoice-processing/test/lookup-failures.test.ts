import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROVIDER_REFUSALS,
  QuickBooksSimulator,
  type ScriptedAnswer,
} from '@autom8x/automation-kit/testing';
import { defineAutomation, type RunResult } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture, refusalFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, pipelineSteps } from '../src/automation.js';
import { recoverQuickBooks, withFixedSentences } from '../src/failures.js';
import { RESULTS } from '../src/words.js';
import { bill, creditNote, statement } from './check-world.js';
import { QUICKBOOKS, callsOf, everythingSaid, lines } from './fixtures.js';
import { LOOKUP_STEPS, reported, routeRun, stateOf } from './lookups-world.js';

/**
 * QuickBooks failing inside each lookup of a new vendor's bill — the one document that runs all
 * nine: a 429 waited out twice and a 5xx repeated once inside the step; every connection, busy and
 * refusal case keeping the bill out of QuickBooks — no QuickBooks step after it, the details saved,
 * "Saved. Not recorded in QuickBooks: …" (the session's decision 6) — and a thrown 502 the same, once
 * the SDK's attempts are spent; never Intuit's words, a code, or the platform's raw problem.
 */

const NOT_CONNECTED = "QuickBooks isn't connected";
const NO_ANSWER = "QuickBooks didn't answer";
const summaryOf = (result: RunResult) =>
  result.outcome === 'success' ? result.summary : JSON.stringify(result);

/** The steps whose every failure keeps the bill out of QuickBooks. */
const STOPPING = [
  'find-vendor',
  'find-vendor-company',
  'find-customer-name',
  'find-duplicate-number',
  'find-duplicate-amount',
  'find-related',
  'find-other-record',
] as const;

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

const CASES: { name: string; answers: ScriptedAnswer[]; reason: string; calls: number }[] = [
  {
    name: 'no live connection',
    answers: [{ refuse: PROVIDER_REFUSALS.notConnected() }],
    reason: NOT_CONNECTED,
    calls: 1,
  },
  { name: 'QuickBooks 401', answers: [{ status: 401 }], reason: NOT_CONNECTED, calls: 1 },
  { name: 'QuickBooks 403', answers: [{ status: 403 }], reason: NOT_CONNECTED, calls: 1 },
  {
    name: '429 three times',
    answers: [{ status: 429 }, { status: 429 }, { status: 429 }],
    reason: NO_ANSWER,
    calls: 3,
  },
  { name: '500 twice', answers: [{ status: 500 }, { status: 500 }], reason: NO_ANSWER, calls: 2 },
  {
    name: 'Connections not configured',
    answers: [{ refuse: PROVIDER_REFUSALS.notConfigured('query.run') }],
    reason: NO_ANSWER,
    calls: 1,
  },
  {
    name: 'QuickBooks refusing the query',
    answers: [{ status: 400 }],
    reason: NO_ANSWER,
    calls: 1,
  },
];

test('every connection, busy and refusal case at a lookup: not recorded, its line, no QuickBooks step after it, the details saved', async () => {
  for (const stepId of STOPPING) {
    for (const { name, answers, reason, calls } of CASES) {
      const world = await routeRun(at(stepId, answers));
      const label = `${stepId}: ${name}`;
      assert.equal(summaryOf(world.result), RESULTS.notRecorded(reason), label);
      assert.deepEqual(
        lines(world.platform).slice(-2),
        [
          [stepId, 'failed', `Not recorded in QuickBooks: ${reason}`],
          ['save-details', 'ok', 'Saved: Harrowgate Office Supply, $413.34'],
        ],
        label,
      );
      const sent = callsOf(world.platform, world.request, stepId);
      assert.equal(sent.length, calls, label);
      assert.equal(new Set(sent.map((call) => JSON.stringify(call))).size, 1, 'one request');
      assert.ok(!everythingSaid(world.platform, world.result).includes('FAULT-TEXT'), label);
    }
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

test("QuickBooks refusing a statement's lookup, or a credit note's: not compared or recorded, the details saved", async () => {
  const cases: [string, boolean, number][] = [
    ['find-vendor', false, 1],
    ['find-vendor-company', true, 2],
    ['find-duplicate-number', false, 2],
    ['find-duplicate-amount', false, 3],
  ];
  for (const [stepId, bare, before] of cases) {
    const world = await routeRun({
      answer: statement(),
      bare,
      company: (sim) =>
        sim.script('query.run', [
          ...Array.from({ length: before }, () => ({ status: 200 })),
          { status: 400 },
        ]),
    });
    assert.equal(summaryOf(world.result), RESULTS.notRecorded(NO_ANSWER), stepId);
    assert.ok(world.result.outcome === 'success');
    assert.equal(world.result.output?.documentType, 'supplier_statement', stepId);
  }
  const credit = await routeRun({
    answer: creditNote(),
    company: (sim) =>
      sim.script('query.run', [{ status: 200 }, { status: 200 }, { status: 200 }, { status: 400 }]),
  });
  assert.equal(summaryOf(credit.result), RESULTS.notRecorded(NO_ANSWER));
});

test('the similar-names list goes on past what QuickBooks cannot answer; a connection gone, and the employee check busy, keep the bill out', async () => {
  const similar = await routeRun(at('find-similar-vendors', [{ status: 403 }]));
  assert.equal(similar.result.outcome, 'held');
  const notConnected = await routeRun(
    at('find-similar-vendors', [{ refuse: PROVIDER_REFUSALS.notConnected() }]),
  );
  assert.equal(summaryOf(notConnected.result), RESULTS.notRecorded(NOT_CONNECTED));
  const busy = await routeRun(
    at('find-employee-name', [{ status: 429 }, { status: 429 }, { status: 429 }]),
  );
  assert.equal(summaryOf(busy.result), RESULTS.notRecorded(NO_ANSWER));
  assert.deepEqual(reported(busy).slice(-2), ['find-employee-name', 'save-details']);
});

test('a body that is no query answer: not recorded, QuickBooks answered unusably', async () => {
  const world = await routeRun(at('find-duplicate-amount', [{ status: 200, body: { Bill: [] } }]));
  assert.equal(summaryOf(world.result), RESULTS.notRecorded(NO_ANSWER));
  assert.deepEqual(
    lines(world.platform).find(([stepId]) => stepId === 'find-duplicate-amount'),
    ['find-duplicate-amount', 'failed', `Not recorded in QuickBooks: ${NO_ANSWER}`],
  );
});

test("a reasonless 502 thrown at a lookup until the SDK's attempts are spent: the run's recover keeps the bill out — the raw problem nowhere", async () => {
  const seeded = stateOf(
    (await routeRun({ answer: bill(), bare: true, through: 'find-employee-name' })).result,
  );
  const simulator = new QuickBooksSimulator({ refusal: refusalFixture });
  simulator.script('query.run', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]);
  const platform = new RecordingPlatform();
  platform.provider = simulator.provider;
  const log = () => undefined;
  const steps = pipelineSteps(
    { now: () => Date.now(), sleep: () => Promise.resolve() },
    'amount',
    log,
  );
  const automation = withFixedSentences(
    defineAutomation({
      templateId: TEMPLATE_ID,
      manifests: [
        {
          templateId: TEMPLATE_ID,
          version: 2,
          requiredCapabilities: [],
          pipeline: [{ id: 'seed' }, { id: 'find-duplicate-number' }],
        },
      ],
      steps: {
        seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: seeded }),
        'find-duplicate-number': steps['find-duplicate-number']!,
      },
      recover: recoverQuickBooks(log),
      result: (state) => ({ output: state }),
    }),
    log,
  );
  const result = await automation.execute(
    invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 2, config: QUICKBOOKS }),
    platform,
  );
  assert.ok(result.outcome === 'success');
  assert.deepEqual(result.output?.quickBooks, { notRecorded: NO_ANSWER });
  assert.deepEqual(lines(platform).at(-1), [
    'find-duplicate-number',
    'failed',
    `Not recorded in QuickBooks: ${NO_ANSWER}`,
  ]);
  const said = everythingSaid(platform, result);
  assert.ok(!said.includes('callback provider refused') && !said.includes('urn:autom8x'));
});
