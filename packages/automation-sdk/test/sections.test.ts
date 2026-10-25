import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunResult } from '../src/contract.js';
import { boundedResult } from '../src/platform.js';
import {
  RUN_SECTION_LIMITS,
  RUN_VERDICTS,
  boundedScore,
  boundedSections,
  boundedTitle,
  boundedVerdict,
  isRunSectionUrl,
  type RunSection,
  type RunVerdict,
} from '../src/sections.js';
import { assertValid, validator } from './published-schemas.js';

/**
 * A succeeded run's `title`, `score` and `sections` (platform ADR-0046, Round 19): held to the
 * published `automation-run-result.json` — a title of 1–80 characters, an integer score from 0
 * to 100, 1–12 sections of 1–40 entries, each entry's url `http(s)` — and bounded by the client,
 * so a run whose work is done is never unreportable for a name that ran long or a bad link.
 */

const section = (title: string, count: number, entry = { title: 'Row' }): RunSection => ({
  title,
  entries: Array.from({ length: count }, () => entry),
});

test('a title, a score and sections within the bounds validate on a success, and nowhere else', () => {
  const validate = validator('automation-run-result');
  const sections = [
    {
      title: 'Experience',
      entries: [
        {
          title: 'Senior Accountant · Acme Corp',
          subtitle: '2021 – now · 4 years',
          text: 'Led month-end close.\nCut it to 4 days.',
          url: 'https://example.com/jane',
        },
      ],
    },
  ];
  const success = { outcome: 'success', title: 'Jane Doe', score: 82, sections };
  assertValid(validate, success, 'a success with a title, a score and sections');
  assertValid(validate, { runId: 'r', ...success, score: 0 }, 'a score of 0');
  assertValid(validate, { outcome: 'success', score: 100 }, 'a score of 100, alone');
  assertValid(validate, { outcome: 'success', title: 'x'.repeat(80) }, 'a title of 80');
  const url = (value: string) => [{ title: 'S', entries: [{ title: 'E', url: value }] }];
  assertValid(validate, { outcome: 'success', sections: url('HTTP://EXAMPLE.COM') }, 'any case');

  const refused: [string, Record<string, unknown>][] = [
    ['a failed run', { outcome: 'failed', failureReason: 'x', title: 'Jane' }],
    ['a held run', { outcome: 'held', held: { stepId: 's', reason: 'r', state: {} }, score: 1 }],
    ['an empty title', { outcome: 'success', title: '' }],
    ['a title of 81', { outcome: 'success', title: 'x'.repeat(81) }],
    ['a score of 101', { outcome: 'success', score: 101 }],
    ['a score of -1', { outcome: 'success', score: -1 }],
    ['a fraction', { outcome: 'success', score: 81.5 }],
    ['no section', { outcome: 'success', sections: [] }],
    ['13 sections', { outcome: 'success', sections: Array(13).fill(section('S', 1)) }],
    ['a section of no entry', { outcome: 'success', sections: [section('S', 0)] }],
    ['41 entries', { outcome: 'success', sections: [section('S', 41)] }],
    ['a section title of 41', { outcome: 'success', sections: [section('x'.repeat(41), 1)] }],
    [
      'an entry title of 121',
      { outcome: 'success', sections: [section('S', 1, { title: 'x'.repeat(121) })] },
    ],
    [
      'a text of 601',
      {
        outcome: 'success',
        sections: [{ title: 'S', entries: [{ title: 'E', text: 'x'.repeat(601) }] }],
      },
    ],
    ['an ftp url', { outcome: 'success', sections: url('ftp://example.com') }],
    ['a script url', { outcome: 'success', sections: url('javascript:alert(1)') }],
    ['a url of 2049', { outcome: 'success', sections: url(`https://e.com/${'x'.repeat(2035)}`) }],
    [
      'an entry key the schema names not',
      { outcome: 'success', sections: [{ title: 'S', entries: [{ title: 'E', more: 1 }] }] },
    ],
  ];
  for (const [what, value] of refused) assert.equal(validate(value), false, what);
});

test('the client bounds the title: one line, cut whole at 80, nothing left left off', () => {
  assert.equal(boundedTitle(undefined), undefined);
  assert.equal(boundedTitle('  \n '), undefined);
  assert.equal(boundedTitle('  Jane \n  Doe '), 'Jane Doe');
  assert.equal(boundedTitle('x'.repeat(79) + '😀'), 'x'.repeat(79));
  assert.equal(boundedTitle('y'.repeat(200))?.length, 80);
});

test('the client keeps a score only when it is an integer from 0 to 100, never moving one', () => {
  for (const kept of [0, 1, 59, 100]) assert.equal(boundedScore(kept), kept);
  for (const left of [-1, 101, 81.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.equal(boundedScore(left), undefined, String(left));
  }
});

test('a verdict of positive or negative validates on a success, and nowhere else (build 28)', () => {
  const validate = validator('automation-run-result');
  assert.deepEqual(RUN_VERDICTS, ['positive', 'negative']);
  for (const verdict of RUN_VERDICTS) {
    assertValid(validate, { outcome: 'success', score: 60, verdict }, verdict);
  }
  const refused: [string, Record<string, unknown>][] = [
    ['a third verdict', { outcome: 'success', verdict: 'neutral' }],
    ["the flow's word, not the verdict", { outcome: 'success', verdict: 'Advance' }],
    ['a verdict of null', { outcome: 'success', verdict: null }],
    ['a failed run', { outcome: 'failed', failureReason: 'x', verdict: 'negative' }],
    [
      'a held run',
      { outcome: 'held', held: { stepId: 's', reason: 'r', state: {} }, verdict: 'positive' },
    ],
  ];
  for (const [what, value] of refused) assert.equal(validate(value), false, what);
});

test('the client keeps a verdict only when it is positive or negative, never guessing one', () => {
  assert.equal(boundedVerdict('positive'), 'positive');
  assert.equal(boundedVerdict('negative'), 'negative');
  for (const left of ['Advance', 'Positive', ' positive', '', undefined]) {
    assert.equal(boundedVerdict(left), undefined, String(left));
  }
});

test('an entry keeps its url only when the platform would: http or https, at most 2,048', () => {
  assert.ok(isRunSectionUrl('https://example.com/jane'));
  assert.ok(isRunSectionUrl('HtTpS://example.com'));
  assert.ok(isRunSectionUrl(`https://e.com/${'x'.repeat(RUN_SECTION_LIMITS.urlLength - 14)}`));
  assert.equal(isRunSectionUrl(`https://e.com/${'x'.repeat(2035)}`), false, 'over 2,048');
  assert.equal(isRunSectionUrl('ftp://example.com'), false);
  assert.equal(isRunSectionUrl('javascript:alert(1)'), false);
  assert.equal(isRunSectionUrl('linkedin.com/in/jane'), false, 'no scheme');
  assert.equal(isRunSectionUrl('https://'), false, 'no host: a URL parser refuses it');
});

test('the client bounds the sections: cut whole, empty ones and bad links left out, 40 and 12 kept', () => {
  assert.equal(boundedSections(undefined), undefined);
  assert.equal(boundedSections([]), undefined);
  assert.equal(boundedSections([section('  ', 2), section('Empty', 0)]), undefined);
  const [contact] = boundedSections([
    {
      title: ' Contact \n details ',
      entries: [
        { title: '  ' },
        { title: 'jane@example.com', subtitle: ' \n', text: '  ' },
        { title: 'Profile', url: 'linkedin.com/in/jane' },
        { title: 'Site', url: ' https://jane.example.com ', text: ' Line one\nLine two ' },
        { title: 'x'.repeat(130), subtitle: 's'.repeat(130), text: 't'.repeat(700) },
      ],
    },
  ])!;
  assert.deepEqual(contact!.title, 'Contact details');
  assert.deepEqual(contact!.entries.slice(0, 3), [
    { title: 'jane@example.com' },
    { title: 'Profile' },
    { title: 'Site', text: 'Line one\nLine two', url: 'https://jane.example.com' },
  ]);
  const long = contact!.entries[3]!;
  assert.deepEqual([long.title.length, long.subtitle?.length, long.text?.length], [120, 120, 600]);
  const many = boundedSections(Array(14).fill(section('S', 45)))!;
  assert.equal(many.length, RUN_SECTION_LIMITS.sections);
  assert.ok(many.every((kept) => kept.entries.length === RUN_SECTION_LIMITS.entries));
});

test('every result the client bounds validates, whatever the automation returned', () => {
  const validate = validator('automation-run-result');
  const result: RunResult = {
    outcome: 'success',
    summary: 'Strong match · meets 3 of 3 must-haves',
    title: `  ${'Jane Doe '.repeat(20)} `,
    score: 82.5,
    verdict: 'Advance' as RunVerdict,
    sections: [
      section('x'.repeat(60), 50, { title: 'y'.repeat(200) }),
      { title: 'Links', entries: [{ title: 'Bad', url: 'mailto:jane@example.com' }] },
      section('Empty', 0),
    ],
  };
  const bounded = boundedResult(result);
  assertValid(validate, { runId: 'r', ...bounded }, 'the bounded result');
  assert.equal('score' in bounded, false, 'a fraction is left out, not rounded');
  assert.equal('verdict' in bounded, false, 'a word that is no verdict is left out');
  assert.equal((bounded as { title?: string }).title?.length, 80);
  const sent = (bounded as { sections?: RunSection[] }).sections!;
  assert.deepEqual(
    sent.map((kept) => [kept.title.length, kept.entries.length]),
    [
      [40, 40],
      [5, 1],
    ],
  );
  assert.deepEqual(sent[1]!.entries, [{ title: 'Bad' }]);
  assert.deepEqual(
    boundedResult({ outcome: 'success', summary: 'Saved' }),
    { outcome: 'success', summary: 'Saved' },
    'a result without them sends none',
  );
  assert.deepEqual(
    boundedResult({ outcome: 'success', score: 59, verdict: 'negative' }),
    { outcome: 'success', score: 59, verdict: 'negative' },
    'a verdict is sent as given',
  );
});
