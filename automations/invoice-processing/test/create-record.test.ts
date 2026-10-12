import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FAULT_MARKER,
  PROVIDER_REFUSALS,
  faultAnswer,
  type ScriptedAnswer,
} from '@autom8x/automation-kit/testing';

import type { JsonObject, StepPlatform } from '@autom8x/automation-sdk';
import { invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { createRecord } from '../src/steps/create-record.js';
import { AFTER_APPROVAL_SENTENCES, INTUIT_CODES, intuitSentence } from '../src/writes/sentences.js';
import { bill, creditNote, receipt, sampleAnswer } from './check-world.js';
import { decide } from './decide-world.js';
import { PAID, type RouteRun } from './lookups-world.js';
import { approve, firstRun, writesOf } from './writes-world.js';

/**
 * create-record's failures (the plan's §5 "Error mapping"; ip-review design-after-approval-writes-
 * notify-tests.json steps[4]): each Intuit code in its own fixed sentence — 6200 beside 6210, 2290,
 * 2300, 6430 added — any other in the kit's; a write QuickBooks may have made (a 429, a 5xx, Intuit's
 * 600, an answer lost) "did not confirm"; ONE request whatever happens, never repeated; Intuit's
 * words nowhere; and the vendor this run added named in every sentence after it.
 */

/** The noun each path's sentences use: the kit's, so a refund is an expense there. */
const PATHS: readonly [string, RouteRun, string, string][] = [
  ['a bill', { answer: bill() }, 'bill.create', 'bill'],
  ['a company receipt', { answer: receipt() }, 'purchase.create', 'expense'],
  ['a card refund', { answer: sampleAnswer('card-refund') }, 'purchase.create', 'expense'],
  ['a vendor credit', { answer: creditNote() }, 'vendorCredit.create', 'vendor credit'],
  ['an employee', { answer: receipt(), ...PAID.employee }, 'journalEntry.create', 'journal entry'],
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

test("each Intuit code the plan maps, in its own sentence naming the record, Intuit's words nowhere; any other code, the kit's", async () => {
  const expected: Record<string, (noun: string) => string> = {
    '6140': (noun) =>
      `QuickBooks already has ${/^[aeiou]/u.test(noun) ? 'an' : 'a'} ${noun} with this number, so no ${noun} was created. Check QuickBooks before running this again.`,
    '6240': (noun) =>
      `QuickBooks reported a name conflict on this ${noun}, so no ${noun} was created.`,
    '610': (noun) =>
      `An account or name this ${noun} uses is inactive or missing in QuickBooks, so no ${noun} was created. Make it active, then run it again.`,
    '2500': (noun) =>
      `An account or name this ${noun} uses is inactive or missing in QuickBooks, so no ${noun} was created. Make it active, then run it again.`,
    '6190': (noun) =>
      `The QuickBooks subscription has ended or has a billing problem, so no ${noun} was created.`,
    '6200': (noun) =>
      `The document's date is in a period closed in QuickBooks, so no ${noun} was created.`,
    '6210': (noun) =>
      `The document's date is in a period closed in QuickBooks, so no ${noun} was created.`,
    '2050': (noun) =>
      `A value on this ${noun} is longer than QuickBooks allows, so no ${noun} was created. Enter it by hand in QuickBooks.`,
    '2290': (noun) =>
      `QuickBooks refused a negative amount on this ${noun}, so no ${noun} was created. Enter it by hand in QuickBooks.`,
    '2300': (noun) =>
      `QuickBooks found this ${noun}'s debits and credits unequal, so no ${noun} was created. Enter it by hand in QuickBooks.`,
    '6430': (noun) =>
      `An account in this flow's settings is the wrong kind for this ${noun}, so no ${noun} was created. Check the settings, then run it again.`,
    '6000': (noun) => `QuickBooks refused the ${noun}, so no ${noun} was created.`,
  };
  assert.deepEqual(
    [...INTUIT_CODES].sort(),
    Object.keys(expected)
      .filter((code) => code !== '6000')
      .sort(),
  );
  for (const [label, run, operation, noun] of PATHS) {
    for (const [code, sentence] of Object.entries(expected)) {
      const { result, calls } = await written(run, operation, [
        { status: 400, body: faultAnswer(code) },
      ]);
      assert.deepEqual(
        result,
        { outcome: 'failed', failureReason: sentence(noun) },
        `${label} ${code}`,
      );
      assert.ok(sentence(noun).length <= 200, `${label} ${code}`);
      assert.ok(!JSON.stringify(result).includes(FAULT_MARKER));
      assert.equal(writesOf(calls).length, 1, `${label} ${code}: one request`);
    }
  }
  // A Fault inside a 200 is a refusal too.
  const { result } = await written({ answer: bill() }, 'bill.create', [
    { status: 200, body: faultAnswer('6210') },
  ]);
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason:
      "The document's date is in a period closed in QuickBooks, so no bill was created.",
  });
  assert.equal(intuitSentence('1', 'bill'), undefined);
});

test('a lost answer, a 429, a 5xx or Fault 600: QuickBooks did not confirm it — one request, never repeated, the safe side', async () => {
  const cases: [string, ScriptedAnswer[]][] = [
    ['an answer lost after QuickBooks made it', [{ lost: 'before_record' }]],
    ['an answer lost after the platform recorded it', [{ lost: 'after_record' }]],
    ['a 429', [{ status: 429 }]],
    ['a 500', [{ status: 500 }]],
    ['a 503', [{ status: 503 }]],
    ['Fault 600', [{ status: 400, body: faultAnswer('600') }]],
    ['a reasonless 502 before QuickBooks', [{ refuse: PROVIDER_REFUSALS.noAnswer() }]],
    ['a 200 without the record', [{ status: 200, body: { time: 't' } }]],
  ];
  for (const [label, script] of cases) {
    const { result, calls, simulator } = await written({ answer: bill() }, 'bill.create', script);
    assert.deepEqual(
      result,
      {
        outcome: 'failed',
        failureReason:
          'QuickBooks did not confirm whether the bill was created. Check QuickBooks before running this again.',
      },
      label,
    );
    assert.equal(writesOf(calls).length, 1, `${label}: one request`);
    if (label.startsWith('an answer lost')) {
      assert.equal(simulator.company.bills.length, 1, `${label}: the bill QuickBooks made, once`);
    }
  }
});

test("the platform's certain refusals: nothing reached QuickBooks, so nothing was created", async () => {
  const cases: [string, ScriptedAnswer, string][] = [
    [
      'not connected',
      { refuse: PROVIDER_REFUSALS.notConnected() },
      'Reconnect QuickBooks in Connections, then run it again. No bill was created.',
    ],
    [
      'the scope missing',
      { refuse: PROVIDER_REFUSALS.badRequest('bill.create', 'insufficient_scope') },
      'QuickBooks was connected without accounting access, so no bill was created. Reconnect QuickBooks in Connections, then run it again.',
    ],
    [
      'a field the platform refuses',
      { refuse: PROVIDER_REFUSALS.badRequest('bill.create', 'refused_field') },
      'Autom8x could not send the bill to QuickBooks, so no bill was created.',
    ],
    [
      'QuickBooks 401',
      { status: 401 },
      'Reconnect QuickBooks in Connections, then run it again. No bill was created.',
    ],
  ];
  for (const [label, script, sentence] of cases) {
    const { result } = await written({ answer: bill() }, 'bill.create', [script]);
    assert.deepEqual(result, { outcome: 'failed', failureReason: sentence }, label);
  }
});

test('after create-vendor added the vendor: every create-record sentence says so, and its line names the vendor kept', async () => {
  for (const [script, sentence] of [
    [
      { status: 400, body: faultAnswer('6140') },
      'QuickBooks already has a bill with this number, so no bill was created. Check QuickBooks before running this again. The new vendor was added to QuickBooks.',
    ],
    [
      { lost: 'before_record' },
      'QuickBooks did not confirm whether the bill was created. Check QuickBooks before running this again. The new vendor was added to QuickBooks.',
    ],
  ] as const) {
    const first = await firstRun({ answer: bill(), bare: true });
    first.simulator.script('bill.create', [script]);
    const approved = await approve(first);
    assert.deepEqual(approved.result, { outcome: 'failed', failureReason: sentence });
    assert.ok(sentence.length <= 200);
    assert.match(
      approved.steps.at(-1)?.[2] ?? '',
      /^Not recorded; the new vendor stays \(Id 1001\) \(/u,
    );
  }
});

test('every sentence create-record can end with fits 200 characters, for every record, with the vendor named', () => {
  for (const noun of ['bill', 'expense', 'vendor credit', 'journal entry']) {
    for (const code of INTUIT_CODES) {
      const sentence = intuitSentence(code, noun) ?? '';
      assert.ok(
        `${sentence} The new vendor was added to QuickBooks.`.length <= 200,
        `${noun} ${code}`,
      );
    }
  }
});

test('a new vendor that was neither found nor added — a guard that should never fire — writes nothing: "could not finish its checks"', async () => {
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
    request: invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 1 }),
    stepId: 'create-record',
    state: saved as unknown as JsonObject,
    idempotencyKey: `create-record-${'a'.repeat(48)}`,
    platform,
  });
  assert.deepEqual(result, {
    outcome: 'failed',
    summary: 'Not recorded (state_incomplete)',
    failureReason: AFTER_APPROVAL_SENTENCES.state_incomplete,
  });
  assert.equal(calls, 0);
});
