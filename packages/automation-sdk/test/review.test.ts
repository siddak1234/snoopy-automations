import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isContinuation, isInvokeRequest } from '../src/contract.js';
import { chosenOptions, type ManifestSetupField } from '../src/manifest.js';
import { boundedResult } from '../src/result.js';
import { answersOf, boundedDecisions, othersOf, type HeldDecision } from '../src/review.js';
import { held, type Step } from '../src/steps.js';
import { RecordingPlatform, answerReview } from '../src/testing.js';
import { define, invoke, ok } from './runner-fixtures.js';

/**
 * A review of each change (the platform round for ICD-10 Code Check, F2) and a setup dropdown that
 * picks several (F1), as the SDK carries them: `held({ decisions })` to the held result, bounded as
 * the platform takes them; the continuation's answers read back; `answerReview` answering as the
 * platform does; `chosenOptions` reading a `select` field's picks.
 */

const offered: HeldDecision[] = [
  { id: 'change-1', label: 'N18.4 → Remove', detail: 'From the note: “ESRD, previously stage 4.”' },
  { id: 'change-2', label: 'Add Z99.2' },
];

const holding: Step = ({ request }) =>
  Promise.resolve(
    request.continuation
      ? { outcome: 'ok', summary: 'resumed' }
      : held({
          summary: 'Review',
          heldReason: '2 changes need your review.',
          state: { n: 2 },
          decisions: offered,
        }),
  );

test('a held step offers its changes: the held result carries them, bounded', async () => {
  const result = await define({
    steps: { receive: ok('r'), validate: holding, post: ok('p') },
  }).execute(invoke(), new RecordingPlatform());
  assert.equal(result.outcome, 'held');
  assert.deepEqual(result.outcome === 'held' && result.held.decisions, offered);
  assert.deepEqual(result.outcome === 'held' && result.held.stepId, 'validate');
});

test('decisions are bounded as the platform takes them, or refused when bounding would change the review', () => {
  const long = 'x'.repeat(130);
  assert.deepEqual(
    boundedDecisions([{ id: 'a1', label: `  ${long}  `, detail: 'line <b>bold</b>' }]),
    [{ id: 'a1', label: 'x'.repeat(120) }],
  );
  assert.equal(boundedDecisions([]), undefined, 'none offered, none sent');
  assert.equal(boundedDecisions(undefined), undefined);
  assert.throws(
    () =>
      boundedDecisions([
        { id: 'a1', label: 'one' },
        { id: 'a1', label: 'two' },
      ]),
    /twice/u,
  );
  assert.throws(() => boundedDecisions([{ id: 'Bad Id', label: 'one' }]), /out of shape/u);
  assert.throws(() => boundedDecisions([{ id: 'a1', label: '<script>' }]), /not one plain line/u);
  const many = Array.from({ length: 401 }, (_, i) => ({ id: `c${i}`, label: `Change ${i}` }));
  assert.throws(() => boundedDecisions(many), /1 to 400/u);
  const result = boundedResult({
    outcome: 'held',
    held: {
      stepId: 'decide',
      reason: 'Review',
      state: {},
      decisions: [{ id: 'a1', label: `${long}` }],
    },
  });
  assert.equal(result.outcome === 'held' && result.held.decisions?.[0]?.label.length, 120);
});

test('a review answered continues approved with every answer, and the step reads them', async () => {
  const automation = define({ steps: { receive: ok('r'), validate: holding, post: ok('p') } });
  const first = new RecordingPlatform();
  const request = invoke();
  first.results.push({ runId: request.runId, result: await automation.execute(request, first) });
  assert.throws(
    () => answerReview(first, request, { 'change-1': 'accepted' }),
    /every change once/u,
  );
  assert.throws(
    () =>
      answerReview(first, request, {
        'change-1': 'accepted',
        'change-2': 'denied',
        other: 'denied',
      }),
    /every change once/u,
  );
  const continued = answerReview(first, request, { 'change-1': 'denied', 'change-2': 'denied' });
  assert.equal(continued.continuation?.decision, 'approved', 'all denied still continues');
  assert.ok(isInvokeRequest(continued) && isContinuation(continued.continuation));
  assert.deepEqual(
    [...answersOf(continued)],
    [
      ['change-1', 'denied'],
      ['change-2', 'denied'],
    ],
  );
  assert.equal(answersOf(request).size, 0, 'a first run carries no answers');
  const second = new RecordingPlatform();
  const result = await automation.execute(continued, second);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(
    second.steps.map((step) => step.stepId),
    ['post'],
  );
});

test('a continuation whose decisions are not answers is refused by the guard', () => {
  const base = { ofRunId: 'r', kind: 'approval', state: {} };
  assert.ok(isContinuation({ ...base, decisions: [{ id: 'a', decision: 'accepted' }] }));
  assert.ok(isContinuation({ ...base, decisions: [{ id: 'a', other: 'N18.32' }] }), 'an other');
  assert.equal(isContinuation({ ...base, decisions: [{ id: 'a', decision: 'approved' }] }), false);
  assert.equal(isContinuation({ ...base, decisions: 'a' }), false);
  for (const odd of [
    { id: 'a', decision: 'accepted', other: 'N18.32' },
    { id: 'a', other: '' },
    { id: 'a', other: 'x'.repeat(121) },
    { id: 'a', other: 7 },
  ]) {
    assert.equal(isContinuation({ ...base, decisions: [odd] }), false, JSON.stringify(odd));
  }
});

const choosing: HeldDecision[] = [
  {
    id: 'change-1',
    label: 'N18.30 → N18.31',
    options: [
      { value: 'N18.32', label: 'N18.32 · Chronic kidney disease, stage 3b' },
      { value: 'N18.4', label: 'N18.4 · Chronic kidney disease, stage 4 (severe)' },
    ],
  },
  { id: 'change-2', label: 'Add Z99.2' },
];

test("amendment 5: a change's options are bounded as the platform takes them, or refused when bounding would change the answer", () => {
  assert.deepEqual(boundedDecisions(choosing), choosing, 'kept as offered');
  const [change] = choosing as [HeldDecision];
  assert.deepEqual(
    boundedDecisions([
      { ...change, options: [{ value: 'N18.32', label: `  ${'x'.repeat(130)}` }] },
    ]),
    [{ ...change, options: [{ value: 'N18.32', label: 'x'.repeat(120) }] }],
    'a label cut whole at 120',
  );
  assert.deepEqual(boundedDecisions([{ ...change, options: [] }]), [
    { id: 'change-1', label: 'N18.30 → N18.31' },
  ]);
  const option = (value: string, label = value) => ({ value, label });
  const refused: [{ value: string; label: string }[], RegExp][] = [
    [['A', 'B', 'C', 'D'].map((v) => option(v)), /1 to 3/u],
    [[option('A'), option('A')], /twice/u],
    [[option(' A')], /not one plain line/u],
    [[option('x'.repeat(121))], /not one plain line/u],
    [[option('A', '<b>')], /no plain label/u],
  ];
  for (const [options, refusal] of refused) {
    assert.throws(() => boundedDecisions([{ ...change, options }]), refusal);
  }
});

test("amendment 5: an option picked in a change's place is answered, read back and refused when not offered", async () => {
  const offering: Step = ({ request }) =>
    Promise.resolve(
      request.continuation
        ? { outcome: 'ok', summary: 'resumed' }
        : held({ summary: 'Review', heldReason: 'r', state: {}, decisions: choosing }),
    );
  const automation = define({ steps: { receive: ok('r'), validate: offering, post: ok('p') } });
  const first = new RecordingPlatform();
  const request = invoke();
  first.results.push({ runId: request.runId, result: await automation.execute(request, first) });
  assert.throws(
    () => answerReview(first, request, { 'change-1': { other: 'N18.6' }, 'change-2': 'accepted' }),
    /decisions\[0\]\.other must be one of its change's options/u,
  );
  assert.throws(
    () => answerReview(first, request, { 'change-1': 'denied', 'change-2': { other: 'N18.32' } }),
    /decisions\[1\]\.other must be one of its change's options/u,
    'a change offering none',
  );
  const continued = answerReview(first, request, {
    'change-1': { other: 'N18.32' },
    'change-2': 'accepted',
  });
  assert.ok(isInvokeRequest(continued) && isContinuation(continued.continuation));
  assert.deepEqual(continued.continuation?.decisions, [
    { id: 'change-1', other: 'N18.32' },
    { id: 'change-2', decision: 'accepted' },
  ]);
  assert.deepEqual(
    [...answersOf(continued)],
    [
      ['change-1', 'other'],
      ['change-2', 'accepted'],
    ],
  );
  assert.deepEqual([...othersOf(continued)], [['change-1', 'N18.32']]);
  assert.equal(othersOf(request).size, 0);
  const result = await automation.execute(continued, new RecordingPlatform());
  assert.equal(result.outcome, 'success');
});

test("a select field's picks: a string or a list, kept to its options, in their order; else its default", () => {
  const field: ManifestSetupField = {
    key: 'specialties',
    control: 'select',
    options: ['Nephrology', 'Cardiology', 'Endocrinology'],
    multiple: true,
    defaultValue: ['Nephrology'],
  };
  assert.deepEqual(
    chosenOptions({ specialties: ['Endocrinology', 'Nephrology', 'Dentistry'] }, field),
    ['Nephrology', 'Endocrinology'],
  );
  assert.deepEqual(chosenOptions({ specialties: 'Cardiology' }, field), ['Cardiology']);
  assert.deepEqual(chosenOptions({}, field), ['Nephrology'], 'nothing saved: the default');
  assert.deepEqual(chosenOptions({ specialties: 7 }, field), ['Nephrology']);
});
