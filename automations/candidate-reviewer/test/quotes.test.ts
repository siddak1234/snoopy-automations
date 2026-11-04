import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FLOW_WORDS, type JsonObject, type RunResult } from '@autom8x/automation-sdk';

import { quoteLine } from '../src/quotes.js';
import {
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

/**
 * v3, the owner's Q1 and Q2 (2026-11-03, "continue with recommended"): the resume's read gives the
 * exact words of the name, email and phone, each shown under its value in Contact — a Word
 * resume's checked against its text, a value whose words its text does not hold shown with no
 * quote line — and an answer off its schema is asked once more, a second miss ending the run
 * "The AI's answer couldn't be used. Try a clearer file.", with no hold.
 */

type Success = Extract<RunResult, { outcome: 'success' }>;

async function contactOf(answers: Answers, file?: { contentType?: string; bytes?: Uint8Array }) {
  const { automation, platform } = world(answers, file);
  const result = await automation.execute(candidateRun(), platform);
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 300));
  const contact = (result as Success).sections?.find((each) => each.title === 'Contact');
  return (contact?.entries ?? []).filter((entry) => entry.subtitle !== 'Link');
}

const quoted = {
  name: 'JANE DOE, CPA',
  email: 'Email: jane.doe@example.com',
  phone: 'Tel. +1 555 0100',
};

test('Q1: a PDF resume — the exact words under the name, email and phone, as the model read them', async () => {
  const contact = await contactOf({
    resume: resumeAnswer({ quotes: quoted }),
    score: scoreAnswer(70),
  });
  assert.deepEqual(contact, [
    { title: 'Jane Doe', subtitle: 'Name', text: 'Exact words: "JANE DOE, CPA"' },
    {
      title: 'jane.doe@example.com',
      subtitle: 'Email',
      text: 'Exact words: "Email: jane.doe@example.com"',
    },
    { title: '+1 555 0100', subtitle: 'Phone', text: 'Exact words: "Tel. +1 555 0100"' },
    { title: 'Austin, TX', subtitle: 'Location' },
  ]);
});

test('Q1: a Word resume — only words its text holds are trusted; the others show the value with no quote line', async () => {
  const bytes = docx(
    [
      paragraph('JANE DOE, CPA'),
      paragraph('Email:   jane.doe@example.com'),
      paragraph('Senior Accountant, Acme Corp'),
    ].join(''),
  );
  const contact = await contactOf(
    { resume: resumeAnswer({ quotes: quoted }), score: scoreAnswer(70) },
    { ...WORD, bytes },
  );
  assert.deepEqual(
    contact.map((entry) => [entry.subtitle, entry.text ?? null]),
    [
      ['Name', 'Exact words: "JANE DOE, CPA"'],
      ['Email', 'Exact words: "Email: jane.doe@example.com"'],
      ['Phone', null],
      ['Location', null],
    ],
    'white space read as one space; the phone the text never printed is not trusted',
  );
});

test('Q1: no words, no line; the quote line within the section text bound', async () => {
  const contact = await contactOf({
    resume: resumeAnswer({ quotes: { name: '', email: '', phone: '' } }),
    score: scoreAnswer(70),
  });
  assert.ok(contact.every((entry) => entry.text === undefined));
  assert.ok(quoteLine('x'.repeat(580)).length <= 600);
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
