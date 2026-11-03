import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import {
  RESULT_BODY_LIMIT_BYTES,
  type EmittedBlock,
  type HeldDecision,
  type JsonObject,
  type RunResult,
  type StepContext,
} from '@autom8x/automation-sdk';

import { ACCEPTED_KEY, EXAMPLES_KEY } from '../src/v2/memory.js';
import { reviewVisit } from '../src/v2/review-steps.js';
import { WORDS_V3 } from '../src/v2/words.js';
import { loadTable } from '../src/tables.js';
import { reading } from './fixtures.js';
import { reviewChild, runChild, type ChildRan } from './v2-fixtures.js';

/**
 * v3's "Other code" (the spec's "v3", row 3; the platform's amendment 5): each Change offers up to
 * 3 other codes from its diagnosis's own choice list, kept at match time and counted in the held
 * result's body bound; the answer `other` makes that code final, and the clinic learns it as an
 * accepted example and the suggestion as a denied one. v2 offers none.
 */

const note = reading(
  ['I10', 'N18.30'],
  [
    { statement: 'Hypertension', categories: ['I10'] },
    { statement: 'CKD stage 3a, eGFR 52 today', categories: ['N18'] },
    { statement: 'Type 2 diabetes with hyperglycemia', categories: ['E11'] },
  ],
);
const picks = {
  'CKD stage 3a': { code: 'N18.31' },
  'Type 2 diabetes': { code: 'E11.65' },
};
const { codes } = loadTable('2027-oct');

const heldOf = (ran: ChildRan) => {
  assert.equal(ran.result.outcome, 'held');
  return (ran.result as Extract<RunResult, { outcome: 'held' }>).held;
};
const done = (ran: ChildRan) => {
  assert.equal(ran.result.outcome, 'success', JSON.stringify(ran.result).slice(0, 300));
  return ran.result as Extract<RunResult, { outcome: 'success' }>;
};

/** The choice list the match call sent for a statement: the diagnosis's own, in its order. */
function listSent(ran: ChildRan, statement: string): string[] {
  const sent = ran.platform.modelCalls
    .filter((call) => call.capability === 'classification')
    .flatMap(
      (call) => call.input.diagnoses as { statement: string; candidates: { code: string }[] }[],
    );
  return sent.find((d) => d.statement === statement)!.candidates.map((c) => c.code);
}

test("each Change offers up to 3 other codes from its own diagnosis's list, kept at match time; an Add, and v2, none", async () => {
  const v3 = await runChild(note, picks, { version: 3 });
  const decisions = heldOf(v3).decisions as HeldDecision[];
  assert.deepEqual(
    decisions.map((d) => [d.id, d.label]),
    [
      ['v1-n1', 'I10 → I12.9'],
      ['v1-n2', 'N18.30 → N18.31'],
      ['v1-a1', 'Add E11.65'],
    ],
  );
  const list = listSent(v3, 'CKD stage 3a, eGFR 52 today');
  const expected = list.filter((code) => !['N18.31', 'I10', 'N18.30'].includes(code)).slice(0, 3);
  assert.equal(expected.length, 3);
  assert.deepEqual(
    decisions[1]!.options,
    expected.map((code) => ({ value: code, label: `${code} · ${codes[code]}` })),
    'the first 3 of its list but its match and the note’s codes, each "{code} · {title}"',
  );
  assert.equal(
    decisions[0]!.options,
    undefined,
    "the L1 change: Hypertension's list holds no other",
  );
  assert.equal(decisions[2]!.options, undefined, 'an Add offers none');
  const kept = (heldOf(v3).state as JsonObject).others as Record<string, { code: string }[]>;
  assert.ok(
    Object.values(kept).every((others) => others.length <= 3),
    'at most 3 kept a diagnosis',
  );
  assert.equal(
    (heldOf(v3).state as JsonObject).candidates,
    undefined,
    'the lists themselves dropped',
  );
  const v2 = await runChild(note, picks);
  assert.ok(
    (heldOf(v2).decisions ?? []).every((d) => d.options === undefined),
    'v2 offers none',
  );
  assert.equal((heldOf(v2).state as JsonObject).others, undefined);
});

test('the answer other makes that code final, "Changed to {code}"; the clinic learns it accepted and the suggestion denied; edited counted', async () => {
  const v3 = await runChild(note, picks, { version: 3 });
  const other = (heldOf(v3).decisions as HeldDecision[])[1]!.options![0]!.value;
  const ran = await reviewChild(
    v3,
    { 'v1-n1': 'accepted', 'v1-n2': { other }, 'v1-a1': 'denied' },
    note,
  );
  const { output, summary, blocks } = done(ran);
  assert.deepEqual(output!.finalCodes, ['I12.9', other], "in the note's code's place");
  assert.deepEqual(output!.decisions, [
    { id: 'n1', accepted: true },
    { id: 'n2', accepted: false, other },
    { id: 'a1', accepted: false },
  ]);
  const measures = output!.measures as JsonObject;
  assert.deepEqual([measures.accepted, measures.denied, measures.edited], [1, 1, 1]);
  assert.equal(
    summary,
    '3 codes · 2 accepted · 1 denied',
    "counted with the accepted, as the platform's run page",
  );
  const shown = JSON.stringify(blocks);
  assert.ok(
    shown.includes(`"${WORDS_V3.changedTo(other)}"`),
    'the codes table says what it became',
  );
  assert.ok(shown.includes(JSON.stringify([other, codes[other]])), 'entered with its title');
  const examples = (await ran.platform.memory.get(EXAMPLES_KEY)) as {
    families: Record<string, { code: string; verdict: string }[]>;
  };
  const learned = Object.values(examples.families).flat();
  assert.ok(
    learned.some((e) => e.code === other && e.verdict === 'accepted'),
    'its code accepted',
  );
  assert.ok(
    learned.some((e) => e.code === 'N18.31' && e.verdict === 'denied'),
    'the suggestion denied',
  );
  const remembered = (await ran.platform.memory.get(ACCEPTED_KEY)) as JsonObject;
  assert.ok(JSON.stringify(remembered).includes(`"${other}"`), "among the clinic's accepted codes");
});

test("the other codes are counted in the held result's body bound: past it none is offered and the review keeps its blocks", async () => {
  const v3 = await runChild(note, picks, { version: 3 });
  const state = heldOf(v3).state as JsonObject;
  const body = (
    result: { heldReason?: string; decisions?: unknown; blocks?: unknown },
    kept: JsonObject,
  ) =>
    Buffer.byteLength(
      JSON.stringify({
        runId: '00000000-0000-4000-8000-000000000000',
        outcome: 'held',
        held: {
          stepId: 'review-visit',
          reason: result.heldReason,
          state: kept,
          decisions: result.decisions,
        },
        blocks: result.blocks,
      }),
      'utf8',
    );
  const review = async (kept: JsonObject) =>
    (await reviewVisit({ state: kept } as unknown as StepContext)) as unknown as {
      heldReason: string;
      decisions: HeldDecision[];
      blocks: unknown[];
    };
  const plain = await review(state);
  const offered = (plain.decisions[1]!.options ?? []).length;
  assert.equal(offered, 3);
  const without = plain.decisions.map(({ options: _o, ...d }) => d);
  const room = body(plain, state);
  const extra = room - body({ ...plain, decisions: without }, state);
  // Padding that leaves room for the review without its options, but not with them.
  const pad = (n: number) => ({ ...state, padding: 'x'.repeat(n) });
  const at = RESULT_BODY_LIMIT_BYTES - body({ ...plain, decisions: without }, pad(0));
  const tight = await review(pad(at - Math.floor(extra / 2)));
  assert.ok(
    tight.decisions.every((d) => d.options === undefined),
    'none offered past the bound',
  );
  assert.ok(tight.blocks.length > 0, 'the blocks stay');
  assert.ok(body(tight, pad(at - Math.floor(extra / 2))) <= RESULT_BODY_LIMIT_BYTES);
  const roomy = await review(pad(at - extra - 1));
  assert.equal((roomy.decisions[1]!.options ?? []).length, 3, 'within it, offered');
});

test('past the bound the held state keeps no other codes either, so a visit just past it with them keeps its blocks; no edited measure', async () => {
  const v3 = await runChild(note, picks, { version: 3 });
  const state = heldOf(v3).state as JsonObject;
  const { others: _others, ...lean } = state;
  const review = async (kept: JsonObject) =>
    (await reviewVisit({ state: kept } as unknown as StepContext)) as unknown as {
      reason: string;
      state: JsonObject;
      decisions: HeldDecision[];
      blocks: EmittedBlock[];
    };
  const plain = await review(state);
  const without = plain.decisions.map(({ options: _o, ...d }) => d);
  // The held result as the runner sends it (`held.stepId`, its reason, state and decisions).
  const sent = (
    r: { reason: string; blocks: EmittedBlock[] },
    kept: JsonObject,
    decisions: unknown,
  ) => ({
    outcome: 'held' as const,
    held: { stepId: 'review-visit', reason: r.reason, state: kept, decisions },
    blocks: r.blocks,
  });
  const bytes = (body: object) =>
    Buffer.byteLength(JSON.stringify({ runId: '00000000-0000-4000-8000-000000000000', ...body }));
  const gap = bytes(sent(plain, state, without)) - bytes(sent(plain, lean, without));
  assert.ok(gap > 0, 'the kept other codes take room');
  // Padding that leaves room for the review held without its other codes, but not with them.
  const pad = (from: JsonObject, n: number) => ({ ...from, padding: 'x'.repeat(n) });
  const n =
    RESULT_BODY_LIMIT_BYTES - bytes(sent(plain, pad(lean, 0), without)) - Math.floor(gap / 2);
  assert.ok(bytes(sent(plain, pad(lean, n), without)) <= RESULT_BODY_LIMIT_BYTES);
  assert.ok(bytes(sent(plain, pad(state, n), without)) > RESULT_BODY_LIMIT_BYTES);
  const tight = await review(pad(state, n));
  assert.ok(
    tight.decisions.every((d) => d.options === undefined),
    'none offered',
  );
  assert.equal(tight.state.others, undefined, 'none kept');
  await v3.platform.reportResult(
    v3.request.runId,
    sent(tight, tight.state, tight.decisions) as RunResult,
  );
  const held = v3.platform.results.at(-1)!.result as Extract<RunResult, { outcome: 'held' }>;
  assert.deepEqual(held.blocks, tight.blocks, 'the review keeps its blocks');
  const ran = await reviewChild(
    v3,
    { 'v1-n1': 'accepted', 'v1-n2': 'accepted', 'v1-a1': 'denied' },
    note,
  );
  const measures = done(ran).output!.measures as JsonObject;
  assert.deepEqual([measures.accepted, measures.denied], [2, 1]);
  assert.equal('edited' in measures, false, 'no other code was offered, so none is counted');
});
