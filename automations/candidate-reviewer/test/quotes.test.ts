import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FLOW_WORDS, type JsonObject, type RunResult } from '@autom8x/automation-sdk';

import { candidateSteps } from '../src/steps/candidate.js';
import {
  NOW,
  WORD,
  candidateRun,
  docx,
  jobRun,
  paragraph,
  postingAnswer,
  promptOf,
  resumeAnswer,
  scoreAnswer,
  world,
  type Answers,
} from './fixtures.js';
import { rowsOf } from './results.js';

/**
 * v3, the owner's Q1 and Q2 (2026-11-03, "continue with recommended"): the resume's read gives the
 * exact words of the name, email and phone — a Word resume's checked against its text, a quote its
 * text does not hold dropped — and an answer off its schema is asked once more, a second miss
 * ending the run "The AI's answer couldn't be used. Try a clearer file.", with no hold. v4 (the
 * owner's items 11 and 13): the words are still read and checked into the run's step state, and
 * Contact shows none of them.
 */

type Success = Extract<RunResult, { outcome: 'success' }>;

/** The quotes `read-resume` keeps in the run's state, after `receive`, on this file. */
async function quotesKept(answers: Answers, file?: { contentType?: string; bytes?: Uint8Array }) {
  const { platform } = world(answers, file);
  const steps = candidateSteps(() => NOW);
  const request = candidateRun();
  const context = (state: JsonObject) =>
    ({
      request,
      stepId: 'read-resume',
      state,
      idempotencyKey: 'key',
      platform,
    }) as unknown as Parameters<NonNullable<(typeof steps)['receive']>>[0];
  const received = await steps.receive!(context({}));
  assert.ok(received.outcome === 'ok');
  const read = await steps['read-resume']!(context(received.state ?? {}));
  assert.ok(read.outcome === 'ok', JSON.stringify(read));
  return read.state?.quotes;
}

const quoted = {
  name: 'JANE DOE, CPA',
  email: 'Email: jane.doe@example.com',
  phone: 'Tel. +1 555 0100',
};

test('Q1: a PDF resume — the exact words kept as the model read them', async () => {
  assert.deepEqual(
    await quotesKept({ resume: resumeAnswer({ quotes: quoted }), score: scoreAnswer(70) }),
    quoted,
  );
});

test('Q1: a Word resume — only words its text holds are kept; the phone it never printed is dropped', async () => {
  const bytes = docx(
    [
      paragraph('JANE DOE, CPA'),
      paragraph('Email:   jane.doe@example.com'),
      paragraph('Senior Accountant, Acme Corp'),
    ].join(''),
  );
  assert.deepEqual(
    await quotesKept(
      { resume: resumeAnswer({ quotes: quoted }), score: scoreAnswer(70) },
      { ...WORD, bytes },
    ),
    { name: quoted.name, email: quoted.email },
    'white space read as one space; the phone the text never printed is not trusted',
  );
});

test('Q1: no words, none kept', async () => {
  assert.deepEqual(
    await quotesKept({
      resume: resumeAnswer({ quotes: { name: '', email: '', phone: '' } }),
      score: scoreAnswer(70),
    }),
    {},
  );
});

test("v4: Contact shows each value under its label, and no exact words (the owner's items 11 and 13)", async () => {
  const { automation, platform } = world({
    resume: resumeAnswer({ quotes: quoted }),
    score: scoreAnswer(70),
  });
  const result = (await automation.execute(candidateRun(), platform)) as Success;
  assert.equal(result.outcome, 'success');
  assert.deepEqual(rowsOf(result, 'Contact'), [
    { title: 'Name', text: 'Jane Doe' },
    { title: 'Email', text: 'jane.doe@example.com' },
    { title: 'Phone', text: '+1 555 0100' },
    { title: 'Location', text: 'Austin, TX' },
  ]);
  const shown = JSON.stringify(result.blocks);
  assert.ok(!shown.includes('Exact words'), 'no quote line');
  for (const words of Object.values(quoted)) assert.ok(!shown.includes(words), words);
});

/**
 * A model whose answer to `prompt` is off its schema for the first `misses` requests — every model
 * the platform tries for one, as it tries the next on a miss — then `answers`'.
 */
function missing(prompt: 'posting' | 'resume' | 'score', misses: number, answers: Answers) {
  const { automation, platform } = world(answers);
  const answer = platform.model;
  platform.model = (call, model) => {
    const asked = platform.modelCalls.filter((each) => promptOf(each) === prompt).length;
    if (promptOf(call) !== prompt || asked > misses) return answer(call, model);
    return Promise.resolve({
      text: JSON.stringify({ wrong: true }),
      model,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  };
  return { automation, platform };
}

const good: Answers = {
  posting: postingAnswer(),
  resume: resumeAnswer(),
  score: scoreAnswer(70),
};

test('Q2: an answer off its schema is asked once more with the fault line; a good one goes on', async () => {
  const { automation, platform } = missing('resume', 1, good);
  const result = await automation.execute(candidateRun(), platform);
  assert.equal(result.outcome, 'success');
  const reads = platform.modelCalls.filter((call) => promptOf(call) === 'resume');
  assert.equal(reads.length, 2, 'one more paid call');
  assert.match(reads[1]!.prompt, /\n\nYour last answer did not match the schema at \$/u);
});

test('Q2: a second miss at any AI step ends the run "The AI\'s answer couldn\'t be used": no hold, never a third call', async () => {
  for (const [prompt, request] of [
    ['resume', candidateRun()],
    ['score', candidateRun()],
    ['posting', jobRun()],
  ] as const) {
    const { automation, platform } = missing(prompt, 2, good);
    const result = await automation.execute(request, platform);
    assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.ai_unusable }, prompt);
    assert.equal(
      platform.modelCalls.filter((call) => promptOf(call) === prompt).length,
      2,
      `${prompt}: asked once more, never a third time`,
    );
    assert.equal(FLOW_WORDS.ai_unusable, "The AI's answer couldn't be used. Try a clearer file.");
  }
});

test('the quotes never reach the score: the resume it is sent carries no name, email or phone, nor their words', async () => {
  const { automation, platform } = world({
    resume: resumeAnswer({ quotes: quoted }),
    score: scoreAnswer(70),
  });
  await automation.execute(candidateRun(), platform);
  const scored = platform.modelCalls.find((call) => promptOf(call) === 'score');
  const sent = JSON.stringify(scored?.input as JsonObject);
  for (const words of Object.values(quoted)) assert.ok(!sent.includes(words), words);
});
