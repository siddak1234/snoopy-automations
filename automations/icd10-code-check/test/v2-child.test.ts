import assert from 'node:assert/strict';
import { test } from 'node:test';

import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { mergeReadings } from '../src/v2/child-steps.js';
import { ACCEPTED_KEY } from '../src/v2/memory.js';
import { readingOf } from '../src/reading.js';
import { NOTE_ID, platformFor, reading, rowsOf } from './fixtures.js';
import { reviewChild, runChild } from './v2-fixtures.js';

/**
 * A visit's child run (the spec's v2 section; one per batch unit): v1's chain on the unit's pages,
 * the NPI's specialties when none are picked, the preferences then the clinic's memory then the
 * words shared, the review grouped under the visit with each change's why, and the save writing
 * the accepted codes to the clinic's memory.
 */

const note = reading(
  ['I10'],
  [
    { statement: 'Hypertension', categories: ['I10'] },
    { statement: 'CKD stage 3a', categories: ['N18'] },
  ],
);
const picks = { Hypertension: { code: 'I10' }, 'CKD stage 3a': { code: 'N18.31' } };

test("the child runs v1's chain on its unit's pages: each step reported, read-note on the page range", async () => {
  const ran = await runChild(note, picks);
  assert.deepEqual(
    ran.platform.steps.map((s) => s.stepId),
    [
      'receive-visit',
      'read-visit',
      'check-visit',
      'rank-codes',
      'match-codes',
      'check-codes',
      'review-visit',
    ],
  );
  const read = ran.platform.modelCalls[0]!;
  assert.equal(read.artifactId, NOTE_ID);
  assert.deepEqual(read.pages, { from: 1, to: 2 });
  assert.match(read.prompt, /The clinic treats Nephrology Physician\./u);
  assert.deepEqual(rowsOf(ran.result), [
    ['I10', 'change', 'I12.9', 'L1'],
    ['N18.31', 'add', 'N18.31', 'G7'],
  ]);
});

test("the review: each change a decision grouped under the visit, its why in the screens' words", async () => {
  const { result } = await runChild(note, picks);
  assert.equal(result.outcome, 'held');
  const decisions = result.outcome === 'held' ? (result.held.decisions ?? []) : [];
  assert.deepEqual(
    decisions.map((d) => [d.id, d.label, d.group]),
    [
      ['v1-n1', 'I10 → I12.9', 'Jane Doe · Oct 12, 2026'],
      ['v1-a1', 'Add N18.31', 'Jane Doe · Oct 12, 2026'],
    ],
  );
  assert.match(decisions[1]!.detail!, /^From the note: "CKD stage 3a" · Rule: /u);
  const blocks = result.outcome === 'held' ? (result.blocks ?? []) : [];
  assert.equal(blocks[0]?.type === 'section' && blocks[0].title, 'Jane Doe · Oct 12, 2026');
});

test("save-visit: the save applies the answers and writes the accepted codes to the clinic's memory", async () => {
  const held = await runChild(note, picks);
  const done = await reviewChild(held, { 'v1-n1': 'accepted', 'v1-a1': 'denied' }, note);
  assert.equal(done.result.outcome, 'success');
  assert.deepEqual(done.result.outcome === 'success' && done.result.output?.finalCodes, ['I12.9']);
  assert.match(
    done.result.outcome === 'success' ? done.result.summary! : '',
    /1 accepted · 1 denied/u,
  );
  assert.deepEqual(done.platform.memory.values.get(ACCEPTED_KEY), { codes: { 'I12.9': 1 } });
});

test("the clinic's memory ranks a code it accepted before ahead of the words shared, after the preferences", async () => {
  const platform = platformFor(note, picks);
  await platform.memory.put(ACCEPTED_KEY, { codes: { 'N18.30': 3 } });
  await runChild(note, picks, { platform });
  const sent = platform.modelCalls[1]!.input.diagnoses as { candidates: { code: string }[] }[];
  const kidney = sent.find((d) => d.candidates.some((c) => c.code.startsWith('N18')))!;
  // Nephrology's preference families hold every N18 code; inside them, the remembered one first.
  assert.equal(kidney.candidates[0]!.code, 'N18.30');
});

test('no specialty picked: the NPI Registry fills them (the keyless nppes provider); a failed lookup goes on', async () => {
  const platform = platformFor(note, picks);
  platform.fixedQuery = { 'nppes npi.lookup': ['version'] };
  platform.provider = () =>
    Promise.resolve({
      status: 200,
      body: {
        results: [{ taxonomies: [{ code: '207RN0300X', desc: 'Nephrology', primary: true }] }],
      },
    });
  const ran = await runChild(note, picks, { config: { npi: '1234567893' }, platform });
  assert.deepEqual(
    platform.providerCalls.map((c) => [c.providerId, c.operation, c.input]),
    [['nppes', 'npi.lookup', { number: '1234567893' }]],
  );
  assert.match(platform.modelCalls[0]!.prompt, /The clinic treats Nephrology Physician\./u);
  assert.equal(ran.result.outcome, 'held');

  const refused = platformFor(note, picks);
  refused.provider = () =>
    Promise.reject(
      refusalFixture('provider', { status: 502, code: 'DEPENDENCY_FAILURE', detail: 'x' }),
    );
  const went = await runChild(note, picks, { config: { npi: '1234567893' }, platform: refused });
  assert.deepEqual(
    refused.steps.find((s) => s.stepId === 'look-up-npi'),
    {
      runId: went.request.runId,
      stepId: 'look-up-npi',
      outcome: 'failed',
      summary: 'Specialties not read from your NPI',
    },
  );
  assert.equal(went.result.outcome, 'held', 'the run went on');
  // A picked specialty, or no NPI: no lookup.
  const picked = platformFor(note, picks);
  await runChild(note, picks, {
    config: { npi: '1234567893', specialties: ['207RC0000X'] },
    platform: picked,
  });
  assert.equal(picked.providerCalls.length, 0);
});

test("a visit's pages read in several pieces are one visit's reading", () => {
  const a = readingOf(
    reading(['I10'], [{ statement: 'Hypertension', categories: ['I10'], unrelatedTo: [] }]),
  );
  const b = readingOf(
    reading(
      ['I10', 'N18.31'],
      [{ statement: 'CKD stage 3a', categories: ['N18'], unrelatedTo: [0] }],
      {
        patient: {
          name: null,
          birthDate: '1958-03-14',
          sex: null,
          recordNumber: null,
          provider: null,
        },
      },
    ),
  );
  const merged = mergeReadings([a, b]);
  assert.equal(merged.patient.name, 'Jane Doe');
  assert.equal(merged.patient.birthDate, '1958-03-14');
  assert.deepEqual(merged.codesOnNote, ['I10', 'N18.31']);
  assert.deepEqual(
    merged.diagnoses.map((d) => [d.statement, d.unrelatedTo]),
    [
      ['Hypertension', []],
      ['CKD stage 3a', [1]],
    ],
  );
});
