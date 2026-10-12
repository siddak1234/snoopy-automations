import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineAutomation, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { decideRun } from '../src/decide/decide.js';
import type { SavedState } from '../src/decide/saved.js';
import { THROWN_SENTENCES, withFixedSentences } from '../src/failures.js';
import { runResult } from '../src/output.js';
import { bill, creditNote, paidBy, receipt, sampleAnswer, statement } from './check-world.js';
import { RUN_ID, VENDOR, billRow, decideState, found, type DecideSetUp } from './decide-world.js';
import { PAID, routeRun } from './lookups-world.js';

/**
 * The run's result from decide's outcome (`src/output.ts`; the plan's §2.6, §5 "Output"): a
 * statement's comparison with its full list of missing invoice numbers, and decide's line; a
 * record planned — its type, payment type, payer and Paid from account — and a summary that says
 * nothing was written; anything else a fault, never a made-up output.
 */

/** decide's saved plan for a path decided straight through. */
function savedOf(setUp: DecideSetUp): SavedState {
  const decision = decideRun({
    state: decideState(setUp),
    config: {},
    switchOn: false,
    runId: RUN_ID,
  });
  if (decision.outcome === 'ok') return decision.saved;
  assert.equal(decision.outcome, 'held', JSON.stringify(decision).slice(0, 200));
  return (decision as Extract<typeof decision, { outcome: 'held' }>).saved;
}

test('each record planned, as the summary says it: what it is, and that nothing was written yet', () => {
  const cases: [DecideSetUp, string][] = [
    [
      { answer: bill() },
      'Ready to record a bill from Harrowgate Office Supply, $413.34; this version stops before writing to QuickBooks. Nothing was created.',
    ],
    [
      { answer: receipt() },
      'Ready to record an expense of $60.63 from Company Visa; this version stops before writing to QuickBooks. Nothing was created.',
    ],
    [
      { answer: sampleAnswer('card-refund') },
      'Ready to record a refund of $23.72 to Company Visa; this version stops before writing to QuickBooks. Nothing was created.',
    ],
    [
      { answer: creditNote() },
      'Ready to record a vendor credit from Harrowgate Office Supply, $203.20; this version stops before writing to QuickBooks. Nothing was created.',
    ],
    [
      { answer: receipt(), check: paidBy('employee', { paidFrom: null }) },
      'Ready to record a journal entry for what Robin Example paid, $60.63; this version stops before writing to QuickBooks. Nothing was created.',
    ],
  ];
  for (const [setUp, summary] of cases) {
    const result = runResult(savedOf(setUp) as unknown as JsonObject);
    assert.equal(result.summary, summary);
    assert.ok(result.summary.length <= 200);
    assert.equal(result.output.outcome, 'planned');
  }
  const long = runResult(
    savedOf({
      answer: bill(),
      vendor: { ...VENDOR, displayName: 'Harrowgate '.repeat(40) },
    }) as unknown as JsonObject,
  );
  assert.ok(
    long.summary.length <= 200 && long.summary.endsWith('Nothing was created.'),
    long.summary,
  );
});

test('a held record approved: the output carries why it was held, the plan as saved', async () => {
  const saved = savedOf({ answer: receipt(), check: paidBy('employee', { paidFrom: null }) });
  const { output } = runResult(saved as unknown as JsonObject);
  assert.deepEqual(output, {
    outcome: 'planned',
    documentType: 'receipt',
    route: 'employee',
    record: {
      type: 'journal_entry',
      operation: 'journalEntry.create',
      paymentType: null,
      amountCents: 6063,
      date: '2026-09-27',
      dueDate: null,
      docNumber: null,
      payee: { kind: 'employee', id: '55', name: 'Robin Example' },
      category: {
        id: '57',
        name: 'Utilities:Electric',
        why: 'no category set for repairs and maintenance',
      },
      paidFromAccount: null,
    },
    payer: { route: 'employee', id: '55', name: 'Robin Example', vendor1099: null },
    holdReasons: ['paid_personally'],
  });
  // Through the whole run: held at decide, then the approval's continuation ends with this output.
  const first = await routeRun({ answer: receipt(), ...PAID.employee });
  assert.ok(first.result.outcome === 'held');
  const resumed = await first.automation.execute(
    {
      ...first.request,
      runId: '88888888-8888-4888-8888-888888888888',
      continuation: {
        ofRunId: first.request.runId,
        kind: 'approval',
        stepId: 'decide',
        decision: 'approved',
        decidedAt: new Date().toISOString(),
        state: first.result.held.state,
      },
    },
    first.platform,
  );
  assert.ok(resumed.outcome === 'success');
  assert.equal(resumed.output?.route, 'employee');
  assert.deepEqual(resumed.output?.holdReasons, ['paid_personally']);
});

test("a statement's output holds every listed invoice number QuickBooks lacks, its summary decide's line", () => {
  const decision = decideRun({
    state: decideState({
      answer: statement(),
      vendor: { ...VENDOR, balanceCents: 68_654 },
      lookups: { numberLookup: found(billRow({ docNumber: 'HOS-1042' })) },
    }),
    config: {},
    switchOn: true,
    runId: RUN_ID,
  });
  assert.ok(decision.outcome === 'compared');
  const { output, summary } = runResult(decision.result as unknown as JsonObject);
  assert.equal(summary, decision.summary);
  assert.deepEqual(output, {
    outcome: 'compared',
    documentType: 'supplier_statement',
    route: 'statement',
    vendor: { id: '7', displayName: 'Harrowgate Office Supply' },
    statement: {
      closingCents: 68654,
      ownSum: 'adds_up',
      ownSumDifferenceCents: null,
      listedNotInQuickBooks: ['HOS-1031', 'HOS-1050'],
      listedCheckable: true,
      openBillsNotListed: { count: 0, totalCents: 0 },
      openBillsCheckable: true,
      quickBooksOpenCents: 68654,
      differenceCents: 0,
    },
    secondCheck: 'made',
    switchIgnored: true,
  });
});

test("a statement's open-bills lookup at its maximum: the output keeps the count and says it may be short (D6)", () => {
  const output = (reachedMax: boolean) => {
    const decision = decideRun({
      state: decideState({
        answer: statement(),
        lookups: {
          amountLookup: {
            reachedMax,
            records: [billRow({ id: '9', docNumber: 'HOS-0999', balanceCents: 1_000 })],
          },
        },
      }),
      config: {},
      switchOn: false,
      runId: RUN_ID,
    });
    assert.ok(decision.outcome === 'compared');
    return runResult(decision.result as unknown as JsonObject).output.statement as JsonObject;
  };
  for (const reachedMax of [false, true]) {
    const { openBillsNotListed, openBillsCheckable, listedCheckable } = output(reachedMax);
    assert.deepEqual(
      [openBillsNotListed, openBillsCheckable, listedCheckable],
      [{ count: 1, totalCents: 1_000 }, !reachedMax, true],
    );
  }
});

test('a state decide did not leave is a fault — the run fails with the general sentence, never a made-up output', async () => {
  assert.throws(() => runResult({ file: { artifactId: 'x' } }), /without a decision/u);
  assert.throws(() => runResult({ v: 1, route: 'statement' }), /without a decision/u);
  const automation = withFixedSentences(
    defineAutomation({
      templateId: TEMPLATE_ID,
      manifests: [
        {
          templateId: TEMPLATE_ID,
          version: 1,
          requiredCapabilities: [],
          pipeline: [{ id: 'seed' }],
        },
      ],
      steps: {
        seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: { file: {} } }),
      },
      result: (state) => runResult(state),
    }),
    () => undefined,
  );
  assert.deepEqual(
    await automation.execute(
      invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 1 }),
      new RecordingPlatform(),
    ),
    { outcome: 'failed', failureReason: THROWN_SENTENCES.other },
  );
});
