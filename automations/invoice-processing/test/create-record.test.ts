import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FAULT_MARKER,
  PROVIDER_REFUSALS,
  faultAnswer,
  type ScriptedAnswer,
} from '@autom8x/automation-kit/testing';

import {
  defineAutomation,
  type JsonObject,
  type RunResult,
  type StepPlatform,
  type StepReport,
} from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  invokeFixture,
  refusalFixture,
  type ProblemInput,
} from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { noteThrows, withFixedSentences } from '../src/failures.js';
import { createRecord } from '../src/steps/create-record.js';
import { RESULTS, RUN_FAILS } from '../src/words.js';
import { bill, creditNote, receipt, sampleAnswer } from './check-world.js';
import { decide } from './decide-world.js';
import { PAID, type RouteRun } from './lookups-world.js';
import { approve, firstRun, noTimeToRepeat, writesOf, type Run } from './writes-world.js';

/**
 * create-record's failures (the plan's §5 "Error mapping", as decision 6 has it in v2): a write
 * QuickBooks certainly refused keeps the record out of QuickBooks — "Saved. Not recorded in
 * QuickBooks: …", in the nearest of §3.F's words — and a write QuickBooks may have made (its own 429
 * or 5xx, Intuit's 600, an answer lost once the SDK's repeat cannot wait) "didn't confirm"; either
 * way the details are saved and the run succeeds. One request a call, repeated only by the step's
 * retry (test/write-retry.test.ts); Intuit's words nowhere.
 */

const notRecorded = (reason: string) => RESULTS.notRecorded(reason);
const summaryOf = (result: RunResult) =>
  result.outcome === 'success' ? result.summary : JSON.stringify(result);

/** Each path, and the write it makes. */
const PATHS: readonly [string, RouteRun, string][] = [
  ['a bill', { answer: bill() }, 'bill.create'],
  ['a company receipt', { answer: receipt() }, 'purchase.create'],
  ['a card refund', { answer: sampleAnswer('card-refund') }, 'purchase.create'],
  ['a vendor credit', { answer: creditNote() }, 'vendorCredit.create'],
];

/** A whole run of a path — approved, when it held — its write answered as `script` says. */
async function written(run: RouteRun, operation: string, script: ScriptedAnswer[]) {
  const first = await firstRun({
    ...run,
    company: (sim) => {
      run.company?.(sim);
      sim.script(operation, script);
    },
  });
  if (first.result.outcome !== 'held') {
    return {
      result: first.result,
      calls: first.platform.providerCalls,
      simulator: first.simulator,
    };
  }
  const approved = await approve(first);
  return { result: approved.result, calls: approved.providerCalls, simulator: first.simulator };
}

test("each Intuit code, a certain refusal: not recorded, the nearest of §3.F's reasons, the details saved, Intuit's words nowhere", async () => {
  const expected: Record<string, string> = {
    '6140': 'may already be in QuickBooks',
    '6240': 'name used by a customer or employee',
    '6200': 'that date is in closed books',
    '6210': 'that date is in closed books',
    '610': "QuickBooks didn't answer",
    '2500': "QuickBooks didn't answer",
    '6190': "QuickBooks didn't answer",
    '2050': "QuickBooks didn't answer",
    '2290': "QuickBooks didn't answer",
    '6430': "QuickBooks didn't answer",
    '6000': "QuickBooks didn't answer",
  };
  for (const [label, run, operation] of PATHS) {
    for (const [code, reason] of Object.entries(expected)) {
      const { result, calls } = await written(run, operation, [
        { status: 400, body: faultAnswer(code) },
      ]);
      assert.equal(summaryOf(result), notRecorded(reason), `${label} ${code}`);
      assert.ok(result.outcome === 'success');
      assert.deepEqual(result.details?.at(-1), {
        label: 'QuickBooks',
        value: `Not recorded: ${reason}`,
      });
      assert.ok(!JSON.stringify(result).includes(FAULT_MARKER));
      assert.equal(writesOf(calls).length, 1, `${label} ${code}: one request`);
    }
  }
  // A Fault inside a 200 is a refusal too.
  const { result } = await written({ answer: bill() }, 'bill.create', [
    { status: 200, body: faultAnswer('6210') },
  ]);
  assert.equal(summaryOf(result), notRecorded('that date is in closed books'));
});

test("QuickBooks' own 429 or 5xx, Fault 600, or an answer without the record: QuickBooks didn't confirm it — one request, the details saved, the safe side", async () => {
  const cases: [string, ScriptedAnswer[]][] = [
    ['a 429', [{ status: 429 }]],
    ['a 500', [{ status: 500 }]],
    ['a 503', [{ status: 503 }]],
    ['Fault 600', [{ status: 400, body: faultAnswer('600') }]],
    ['a 200 without the record', [{ status: 200, body: { time: 't' } }]],
  ];
  for (const [label, script] of cases) {
    const { result, calls } = await written({ answer: bill() }, 'bill.create', script);
    assert.equal(summaryOf(result), RESULTS.unconfirmed, label);
    assert.ok(result.outcome === 'success');
    assert.deepEqual(result.details?.at(-1), { label: 'QuickBooks', value: "Didn't confirm" });
    assert.deepEqual(result.output?.notRecorded, null, label);
    assert.equal(writesOf(calls).length, 1, `${label}: one request`);
  }
});

test("the platform's certain refusals: nothing reached QuickBooks — not connected, or no usable answer", async () => {
  const cases: [string, ScriptedAnswer, string][] = [
    ['not connected', { refuse: PROVIDER_REFUSALS.notConnected() }, "QuickBooks isn't connected"],
    [
      'the scope missing',
      { refuse: PROVIDER_REFUSALS.badRequest('bill.create', 'insufficient_scope') },
      "QuickBooks isn't connected",
    ],
    [
      'a field the platform refuses',
      { refuse: PROVIDER_REFUSALS.badRequest('bill.create', 'refused_field') },
      "QuickBooks didn't answer",
    ],
    ['QuickBooks 401', { status: 401 }, "QuickBooks isn't connected"],
  ];
  for (const [label, script, reason] of cases) {
    const { result } = await written({ answer: bill() }, 'bill.create', [script]);
    assert.equal(summaryOf(result), notRecorded(reason), label);
  }
});

test('after create-vendor added the vendor: a refused bill keeps it, and an unconfirmed one says to check QuickBooks', async () => {
  const refused = await firstRun({ answer: bill(), bare: true });
  refused.simulator.script('bill.create', [{ status: 400, body: faultAnswer('6140') }]);
  const fault = await approve(refused);
  assert.equal(summaryOf(fault.result), notRecorded('may already be in QuickBooks'));
  assert.equal(refused.simulator.company.vendors.length, 1, 'the vendor stays');
  assert.deepEqual(
    fault.steps.find(([stepId]) => stepId === 'create-record'),
    ['create-record', 'failed', 'Not recorded in QuickBooks: may already be in QuickBooks'],
  );
  // An answer lost with no time to repeat it: the run's recover says QuickBooks did not confirm it.
  const lost = await firstRun({ answer: bill(), bare: true });
  lost.simulator.script('bill.create', [{ lost: 'before_record' }]);
  const unconfirmed = await approve(lost, { deadline: noTimeToRepeat() });
  assert.equal(summaryOf(unconfirmed.result), RESULTS.unconfirmed);
  assert.equal(
    unconfirmed.steps.find(([stepId]) => stepId === 'create-vendor')?.[2],
    'Vendor added',
  );
});

test('a new vendor that was neither found nor added — a guard that should never fire — writes nothing: "Something went wrong"', async () => {
  const decision = decide({ answer: bill(), vendor: { status: 'new' } });
  assert.equal(decision.outcome, 'held');
  const saved = (decision as Extract<typeof decision, { outcome: 'held' }>).saved;
  let calls = 0;
  const platform = {
    callProvider: () => {
      calls += 1;
      return Promise.resolve({ status: 200, body: {} });
    },
  } as unknown as StepPlatform;
  const result = await createRecord()({
    request: invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 2 }),
    stepId: 'create-record',
    state: saved as unknown as JsonObject,
    idempotencyKey: `create-record-${'a'.repeat(48)}`,
    platform,
  });
  assert.deepEqual(result, {
    outcome: 'failed',
    summary: RUN_FAILS.other,
    failureReason: RUN_FAILS.other,
  });
  assert.equal(calls, 0);
});

/** The Edge's flood valve, refusing a callback. */
const FLOOD: ProblemInput = { status: 429, code: 'TOO_MANY_REQUESTS', detail: 'Too many requests' };

/** The platform refusing the runner's report of `stepId` — a throw outside every step. */
function refuseReport(run: Run, stepId: string, problem: ProblemInput = FLOOD): void {
  const report = run.platform.reportStep.bind(run.platform);
  run.platform.reportStep = (line: StepReport) =>
    line.stepId === stepId ? Promise.reject(refusalFixture('step', problem)) : report(line);
}

const HOLD_ALL = { ...PAID.company.config, holdAboveAmount: 0 };
const RECORDED = 'Recorded in QuickBooks: expense from Tidewell Hardware, $60.63.';

test("once the record is made, a refused report — create-record's line or notify's, a 429 or any other — never says 'Try again': the run names the record", async () => {
  const cases: [string, string, ProblemInput][] = [
    ["create-record's line refused 429", 'create-record', FLOOD],
    [
      "create-record's line refused 502",
      'create-record',
      { status: 502, code: 'DEPENDENCY_FAILURE', detail: 'x' },
    ],
    ["notify's line refused 429", 'notify', FLOOD],
  ];
  for (const [label, stepId, problem] of cases) {
    const first = await firstRun({
      answer: receipt(),
      config: { ...HOLD_ALL, notifyEmail: 'books@example.com' },
    });
    refuseReport(first, stepId, problem);
    const approved = await approve(first);
    assert.deepEqual(approved.result, { outcome: 'failed', failureReason: RECORDED }, label);
    assert.deepEqual(
      first.simulator.company.purchases.map((row) => row.Id),
      ['1001'],
      label,
    );
  }
});

test("a write QuickBooks may have made stands when its line's report is refused: never 'Try again'", async () => {
  const first = await firstRun({ answer: receipt(), config: HOLD_ALL });
  first.simulator.script('purchase.create', [{ lost: 'before_record' }]);
  refuseReport(first, 'create-record');
  assert.deepEqual((await approve(first, { deadline: noTimeToRepeat() })).result, {
    outcome: 'failed',
    failureReason: "QuickBooks didn't confirm. Check QuickBooks before you run it again.",
  });
  // Before any write, a refused report is the Edge's flood valve: nothing was made.
  const early = await firstRun({ answer: receipt(), config: HOLD_ALL });
  refuseReport(early, 'confirm-company');
  assert.deepEqual((await approve(early)).result, {
    outcome: 'failed',
    failureReason: RUN_FAILS.other,
  });
});

test("a run's notes are its own: a record of a kind the run's end does not know is still named, and the same request run again starts with nothing done", async () => {
  // One step that makes a record and one after it, each report refusable.
  let made: JsonObject = { created: { record: 'payment', id: '77' } };
  const automation = withFixedSentences(
    defineAutomation({
      templateId: TEMPLATE_ID,
      manifests: [
        {
          templateId: TEMPLATE_ID,
          version: 2,
          requiredCapabilities: [],
          pipeline: [{ id: 'make' }, { id: 'after' }],
        },
      ],
      steps: noteThrows(
        {
          make: () => Promise.resolve({ outcome: 'ok', summary: 'Made', state: made }),
          after: () => Promise.resolve({ outcome: 'ok', summary: 'After' }),
        },
        () => undefined,
      ),
      result: () => ({}),
    }),
    () => undefined,
  );
  const request = invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 2 });
  const platform = new RecordingPlatform();
  platform.reportStep = (line: StepReport) =>
    line.stepId === 'after' ? Promise.reject(refusalFixture('step', FLOOD)) : Promise.resolve();
  assert.deepEqual(await automation.execute(request, platform), {
    outcome: 'failed',
    failureReason: 'Recorded in QuickBooks.',
  });
  // The same request again, nothing made this time: "Something went wrong".
  made = {};
  assert.deepEqual(await automation.execute(request, platform), {
    outcome: 'failed',
    failureReason: RUN_FAILS.other,
  });
});
