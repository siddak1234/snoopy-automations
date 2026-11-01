import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';
import { invokeFixture, unitFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';
import { CALLS_AT_ONCE, DIAGNOSES_A_CALL, MAX_CHOICES } from '../src/v2/child-steps.js';
import { lookUp, loadIndex, termWords } from '../src/v2/lookup.js';
import { EXAMPLES_KEY, deidentified, examplesOf } from '../src/v2/memory.js';
import { loadTable } from '../src/tables.js';
import { NOTE_ID, manifests, platformFor, reading } from './fixtures.js';
import { reviewChild, runChild } from './v2-fixtures.js';

/**
 * The owner's I1, I2 and L1–L5 and the audit fixes (2026-11-01) on a visit's run: code choices
 * from the official index verified in the Tabular, a printed code the index settles kept with no
 * AI, the match in calls of at most 8 diagnoses and 30 choices, 3 at once, the clinic's examples
 * learned and sent within gate B, cleared when learning is off, and each AI call's audit record.
 */

type Sent = { statement: string; candidates: { code: string }[] }[];
const matchCalls = (platform: {
  modelCalls: { capability: string; prompt: string; input: JsonObject }[];
}) => platform.modelCalls.filter((c) => c.capability === 'classification');
const output = (result: RunResult) => (result.outcome === 'success' ? result.output! : {});

test('I1: the index looks a statement up exact, by term, or by keyword, verified in the Tabular', () => {
  const { codes } = loadTable('2027-oct');
  const index = loadIndex('2027-oct');
  assert.deepEqual(termWords("CKD stage 3a, patient's eGFR"), [
    'chronic',
    'kidney',
    'disease',
    'stage',
    '3a',
    'patient',
    'egfr',
  ]);
  const ckd = lookUp('CKD stage 3a, eGFR 52 today', index, codes);
  assert.deepEqual([ckd.settled, ckd.via, ckd.codes[0]], ['N18.31', 'term', 'N18.31']);
  assert.deepEqual(lookUp('Hypertension', index, codes).settled, 'I10');
  // A code whose index entry stops short is completed from the Tabular, its side from the words.
  const knee = lookUp('Primary osteoarthritis, right knee', index, codes);
  assert.equal(
    knee.codes.every((code) => code in codes),
    true,
  );
  assert.equal(knee.codes[0], 'M17.11');
  assert.equal(lookUp('zzz qqq', index, codes).via, 'none');
});

test('I2: a printed code the index settles is kept with no AI; only the others are sent', async () => {
  const note = reading(
    ['I10', 'N18.30'],
    [
      { statement: 'Hypertension', categories: ['I10'] },
      { statement: 'CKD stage 3a', categories: ['N18'] },
    ],
  );
  const ran = await runChild(note, { 'CKD stage 3a': { code: 'N18.31' } }, { config: {} });
  const sent = matchCalls(ran.platform).flatMap((c) => c.input.diagnoses as Sent);
  assert.deepEqual(
    sent.map((d) => d.statement),
    ['CKD stage 3a'],
  );
  const settledOnly = await runChild(
    reading(['I10'], [{ statement: 'Hypertension', categories: ['I10'] }]),
    {},
    { config: {} },
  );
  assert.equal(matchCalls(settledOnly.platform).length, 0, 'no AI call when every one is settled');
  assert.deepEqual(output(settledOnly.result).finalCodes, ['I10']);
  assert.equal((output(settledOnly.result).measures as JsonObject).settled, 1);
});

test('the match: at most 8 diagnoses a call, at most 30 choices each, 3 calls at once', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    statement: `Type 2 diabetes mellitus with complication number ${i}`,
    categories: ['E11'],
  }));
  const platform = platformFor(reading([], many));
  const answer = platform.model;
  let inFlight = 0;
  let most = 0;
  platform.model = async (call, model) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return answer(call, model);
  };
  await runChild(reading([], many), {}, { platform, config: {} });
  const calls = matchCalls(platform).map((c) => c.input.diagnoses as Sent);
  assert.deepEqual(
    calls.map((c) => c.length),
    [8, 8, 4],
  );
  assert.equal(DIAGNOSES_A_CALL, 8);
  assert.ok(calls.flat().every((d) => d.candidates.length <= MAX_CHOICES && MAX_CHOICES === 30));
  assert.equal(most, CALLS_AT_ONCE);
  assert.equal(CALLS_AT_ONCE, 3);
});

const kidney = reading(
  ['N18.30'],
  [{ statement: 'CKD stage 3a per Dr. Lee, eGFR 52 on Oct 12', categories: ['N18'] }],
);
const picks = { 'CKD stage 3a': { code: 'N18.31', quote: 'CKD stage 3a' } };

test('L1–L4: a decision saved as a de-identified example; the next call gets it after the fixed ones, its id audited, gate B still applied', async () => {
  const held = await runChild(kidney, picks, { config: {} });
  const done = await reviewChild(held, { 'v1-n1': 'accepted' }, kidney);
  const kept = examplesOf(done.platform.memory.values.get(EXAMPLES_KEY));
  assert.deepEqual(
    kept.N18?.map(({ statement, code, verdict }) => [statement, code, verdict]),
    [['CKD stage #a per [name], eGFR # on #', 'N18.31', 'accepted']],
  );
  assert.equal((output(done.result).measures as JsonObject).examplesSaved, 1);
  assert.equal(
    deidentified('Seen Oct 12, 2026 by Dr. Lee; may recheck'),
    'Seen #, # by [name]; may recheck',
  );

  // The next visit: the example travels with the call; a quote not in its statement is dropped.
  const next = platformFor(kidney, {
    'CKD stage 3a': { code: 'N18.31', quote: 'stage 3a, stable' },
  });
  next.memory = done.platform.memory;
  const ran = await runChild(kidney, {}, { platform: next, config: {} });
  const call = matchCalls(next)[0]!;
  assert.deepEqual(call.input.clinicExamples, [
    { statement: 'CKD stage #a per [name], eGFR # on #', code: 'N18.31', verdict: 'accepted' },
  ]);
  assert.ok(
    !call.prompt.includes('[name]'),
    "the prompt's fixed text and examples; the clinic's in its input",
  );
  const records = (output(ran.result).audit ?? []) as JsonObject[];
  const match = records.find((r) => r.step === 'match-codes')!;
  assert.deepEqual(match.examples, [kept.N18![0]!.id]);
  assert.equal(match.gate, 'gate B kept 0 of 1');
});

test('L5: with "Learn from this clinic\'s reviews" off, nothing is read or kept, and what was learned is cleared', async () => {
  const held = await runChild(kidney, picks, { config: {} });
  const learned = await reviewChild(held, { 'v1-n1': 'denied' }, kidney);
  assert.ok(learned.platform.memory.values.has(EXAMPLES_KEY));
  const off = platformFor(kidney, picks);
  off.memory = learned.platform.memory;
  const again = await runChild(kidney, picks, { platform: off, config: { learn: false } });
  assert.deepEqual(matchCalls(off)[0]!.input.clinicExamples, []);
  const cleared = await reviewChild(again, { 'v1-n1': 'accepted' }, kidney);
  assert.equal(cleared.platform.memory.values.has(EXAMPLES_KEY), false);
  assert.equal((output(cleared.result).measures as JsonObject).examplesCleared, true);
});

test('a visit sharing a page with another patient is read for its patient only', async () => {
  const platform = platformFor(reading([], []));
  const request = invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 2,
    config: {},
    unit: unitFixture({
      label: 'Jane Doe · Oct 12, 2026',
      artifacts: [{ artifactId: NOTE_ID, pages: { from: 4, to: 4 } }],
      data: { patient: 'Jane Doe', visitDate: '2026-10-12', pages: 1, readOnly: 'Jane Doe' },
    }),
  });
  await define(manifests, { today: () => '2026-10-28' }).execute(request, platform);
  assert.equal(platform.modelCalls[0]!.input.readOnly, 'Jane Doe');
});

test("each AI call's audit record in the visit's output, and its measures", async () => {
  const note = reading(['N18.30'], [{ statement: 'CKD stage 3a', categories: ['N18'] }]);
  const held = await runChild(note, picks, { config: {} });
  const done = await reviewChild(held, { 'v1-n1': 'accepted' }, note);
  const { audit, measures } = output(done.result) as { audit: JsonObject[]; measures: JsonObject };
  assert.deepEqual(
    audit.map((r) => [
      r.step,
      r.prompt,
      r.model,
      r.file,
      r.pages,
      r.tokens,
      r.finishReason,
      r.gate,
    ]),
    [
      [
        'read-visit',
        'read-note v2',
        'anthropic/claude-haiku-4.5',
        NOTE_ID,
        { from: 1, to: 2 },
        { input: 1, output: 1 },
        'stop',
        'diagnoses read: 1',
      ],
      [
        'match-codes',
        'match-codes v2',
        'anthropic/claude-haiku-4.5',
        null,
        null,
        { input: 1, output: 1 },
        'stop',
        'gate B kept 1 of 1',
      ],
    ],
  );
  assert.deepEqual((audit[1]!.answer as { matches: unknown[] }).matches.length, 1);
  assert.deepEqual(measures, {
    diagnoses: 1,
    settled: 0,
    sent: 1,
    kept: 1,
    examplesUsed: 0,
    examplesSaved: 1,
    examplesCleared: false,
    verdicts: { change: 1 },
    accepted: 1,
    denied: 0,
  });
});
