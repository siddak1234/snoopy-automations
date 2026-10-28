import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type Any,
  compile,
  finding,
  lensOut,
  BRIEF,
  skepticInput,
  skepticSays,
  normalWith,
  normal,
  run,
  render,
  has,
} from './flow-research.js';

/**
 * `.claude/workflows/flow-research.js` under stand-in agents (`test/flow-research.ts`): its parse
 * and result, and its gates — the frame, the code gate, the skeptic's verdicts, the defaults. Each
 * case is one outcome the research-stage design, its re-check or its review names.
 */

test('the file parses as the Workflow tool runs it: an async function body, its return the result', async () => {
  assert.doesNotThrow(compile);
  const { result } = await run(normal);
  assert.deepEqual(Object.keys(result), [
    'research',
    'djb2',
    'length',
    'stopped',
    'gaps',
    'notResearched',
    'sources',
  ]);
});

test('a normal run: three agents at most, the gates drop and name, the checksum is returned', async () => {
  const r = await run(normal);
  assert.ok(r.peak <= 3, `peak ${r.peak}`);
  const streamlining = r.calls.find((c) => c.label === 'streamlining lens')!;
  assert.ok(streamlining.startedAt > r.finishedAt['practice lens']!, 'streamlining after practice');
  assert.equal(r.data.stopped, '');
  assert.equal(r.data.framing.decision, null, 'an invented frame field is dropped');
  assert.equal(r.data.framing.job, 'Check each supplier invoice against its purchase order');
  for (const start of ['vendors-3: its page tried', 'rules-3: a tier 4', 'practice-2: not_on_page'])
    assert.ok(has(r.data.gaps, start), start);
  assert.ok(r.data.gaps.some((g: string) => g.includes('"invented step" — no source')));
  assert.ok(!r.data.sources.some((s: Any) => ['vendors-3', 'practice-2'].includes(s.id)));
  assert.ok(
    r.logs.some((l) => l.includes('evil.example.org')),
    'the flagged URL is logged',
  );
  assert.deepEqual(
    [r.result.research, r.result.stopped, r.result.gaps, r.result.notResearched],
    [join(r.runDir, 'research.json'), '', r.data.gaps, r.data.notResearched],
  );
  assert.ok(r.logs.includes(`research.json: djb2 ${r.result.djb2} length ${r.result.length}`));
  assert.equal(render(r.runDir, r.result).code, 0);
  assert.ok(existsSync(join(r.runDir, 'research.md')));
  const file = join(r.runDir, 'research.json');
  writeFileSync(file, JSON.stringify(r.data, null, 2));
  assert.equal(render(r.runDir, r.result).code, 0, 'pretty-printing is not a mismatch');
  writeFileSync(file, readFileSync(file, 'utf8').replace('for practice 1', 'for practice one'));
  assert.equal(render(r.runDir, r.result).code, 1, 'a reworded quote is');
  assert.ok(r.logs.at(-1)!.startsWith('research: done'), r.logs.at(-1));
});

test('every unsourced default, of either kind, is "a person decides" unless the owner keeps it', async () => {
  const { data } = await run(normal);
  const qs = Object.fromEntries(data.brief.openQuestions.map((q: Any) => [q.question, q]));
  assert.equal(qs['Tolerance on price?'].proposedDefault, 'a person decides');
  assert.equal(qs['Which department?'].proposedDefault, 'a person decides');
  assert.equal(qs['Which department?'].proposal, 'Finance');
  assert.equal(qs['Tax rule?'].proposedDefault, 'as the statute says');
  assert.deepEqual(data.notResearched, [
    'Tolerance on price? (domain_fact, not researched): a person decides, unless the owner keeps "2 percent"',
    'Which department? (our_choice, not researched): a person decides, unless the owner keeps "Finance"',
  ]);
});

test('the skeptic judges every line against its quotes; only a supported line stays', async () => {
  const notCarried = new Set(['line by line', 'invented invoice → mismatch on line 2']);
  const judge = (text: string) =>
    text === 'keep records'
      ? null
      : notCarried.has(text) || text.startsWith('Tax rule?')
        ? 'not_supported'
        : 'supported';
  const { data, calls } = await run(normalWith(skepticSays(judge)));
  const { lines } = skepticInput(calls.find((c) => c.label === 'skeptic')!.prompt);
  const refs = lines.map((l) => l.ref);
  assert.ok(
    refs.includes('goldenCases.0') && refs.includes('openQuestions.1') && refs.includes('rubric.0'),
  );
  assert.deepEqual(lines.find((l) => l.ref === 'rubric.0').cites[0], {
    id: 'practice-1',
    quote: 'the exact words for practice 1',
  });
  assert.deepEqual(data.brief.rubric, []);
  assert.deepEqual(data.brief.goldenCases, []);
  assert.deepEqual(data.brief.rules, [], 'a line with no verdict is not kept');
  assert.ok(
    data.gaps.includes('rubric: "line by line" — the skeptic: not_supported — read; dropped'),
  );
  assert.ok(data.gaps.includes('rules: "keep records" — the skeptic: no verdict; dropped'));
  const tax = data.brief.openQuestions.find((q: Any) => q.question === 'Tax rule?');
  assert.deepEqual(
    [tax.proposedDefault, tax.proposal, tax.researched],
    ['a person decides', 'as the statute says', false],
  );
  assert.deepEqual(
    data.brief.criteria.map((l: Any) => l.text),
    ['three-way match'],
  );
});

test('a page that tries to direct the skeptic: its verdicts become gaps, its lines go', async () => {
  const { data, logs } = await run(
    normalWith(skepticSays(undefined, ['https://example.org/practice/1'])),
  );
  assert.ok(data.gaps.includes('practice-1: its page tried to direct the skeptic'));
  assert.ok(!data.sources.some((s: Any) => s.id === 'practice-1'));
  assert.deepEqual(data.brief.criteria, [], 'three-way match cited only practice-1');
  assert.deepEqual(data.brief.rubric, [], 'line by line cited practice-1 beside rules-1');
  assert.ok(
    data.gaps.includes('rubric: "line by line" — a cite was not confirmed (practice-1); dropped'),
  );
  assert.ok(logs.some((l) => l.includes('direct the skeptic: https://example.org/practice/1')));
});

test('a line stays only when every cite is confirmed: one not_on_page cite drops it', async () => {
  const both = ['practice-1', 'practice-2'];
  const { data } = await run((label, attempt, prompt, dir) => {
    if (label !== 'synthesis') return normal(label, attempt, prompt, dir);
    const brief = BRIEF();
    brief.criteria.push({ text: 'weight 70% on price, per the standard', cites: both });
    brief.openQuestions.push({
      question: 'Weight?',
      kind: 'domain_fact',
      proposedDefault: '70 percent',
      cites: both,
    });
    return brief;
  });
  assert.deepEqual(
    data.brief.criteria.map((l: Any) => l.text),
    ['three-way match'],
  );
  const why = 'a cite was not confirmed (practice-2); dropped';
  assert.ok(data.gaps.includes(`criteria: "weight 70% on price, per the standard" — ${why}`));
  const weight = data.brief.openQuestions.find((q: Any) => q.question === 'Weight?');
  assert.deepEqual(
    [weight.proposedDefault, weight.proposal, weight.researched],
    ['a person decides', '70 percent', false],
  );
});

test('two verdicts for one finding id: confirmed beside not_on_page is not confirmed, a gap', async () => {
  const { data } = await run(
    normalWith((prompt) => {
      const out = skepticSays()(prompt);
      out.verdicts.push({ id: 'practice-1', verdict: 'not_on_page', why: 'absent' });
      return out;
    }),
  );
  assert.ok(!data.sources.some((s: Any) => s.id === 'practice-1'), 'practice-1 is no source');
  assert.ok(
    data.gaps.includes('practice-1: the skeptic gave 2 verdicts, not_on_page — absent'),
    data.gaps.join('\n'),
  );
  assert.deepEqual(data.brief.criteria, [], 'three-way match cited only practice-1');
});

test('two verdicts for one line ref: not_supported then supported drops the line, a gap', async () => {
  const { data } = await run(
    normalWith((prompt) => {
      const out = skepticSays()(prompt);
      const at = out.lines.findIndex((l: Any) => l.ref === 'criteria.0');
      out.lines.splice(at, 0, { ref: 'criteria.0', verdict: 'not_supported', why: 'says more' });
      return out;
    }),
  );
  assert.deepEqual(data.brief.criteria, [], 'the later "supported" does not hide the first');
  const why = 'the skeptic gave 2 verdicts, not_supported — says more; dropped';
  assert.ok(data.gaps.includes(`criteria: "three-way match" — ${why}`), data.gaps.join('\n'));
});

test('a confirmed verdict for an id no line cites never makes it a source', async () => {
  const withSkeptic = normalWith((prompt) => {
    const out = skepticSays()(prompt);
    out.verdicts.push({ id: 'rules-1', verdict: 'confirmed', why: 'not asked' });
    return out;
  });
  const { data, calls } = await run((label, attempt, prompt, dir) => {
    if (label !== 'synthesis') return withSkeptic(label, attempt, prompt, dir);
    const brief: Any = BRIEF();
    for (const lines of Object.values(brief) as Any[][])
      for (const l of lines) l.cites = l.cites.filter((id: string) => id !== 'rules-1');
    return brief;
  });
  const { findings } = skepticInput(calls.find((c) => c.label === 'skeptic')!.prompt);
  assert.ok(!findings.some((f) => f.id === 'rules-1'), 'the skeptic is not asked about rules-1');
  assert.ok(
    data.sources.some((s: Any) => s.id === 'practice-1'),
    'a cited finding still is',
  );
  assert.ok(!data.sources.some((s: Any) => s.id === 'rules-1'), 'rules-1 is no source');
});

test("ids are the code's: a lens that reuses another lens's id cannot make it a source", async () => {
  const unchecked = 'https://unchecked.example/r';
  const { data, calls } = await run((label, attempt, prompt, dir) => {
    if (label !== 'rules lens') return normal(label, attempt, prompt, dir);
    const out = lensOut('rules');
    out.findings.push(finding('rules', 4, { id: 'practice-1', url: unchecked }));
    return out;
  });
  const { findings } = skepticInput(calls.find((c) => c.label === 'skeptic')!.prompt);
  const ids = findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, `ids repeat: ${ids.join(' ')}`);
  assert.ok(!data.sources.some((s: Any) => s.url === unchecked), 'an unchecked page is no source');
  assert.equal(data.sources.filter((s: Any) => s.id === 'practice-1').length, 1);
  const lens = calls.find((c) => c.label === 'rules lens')!.prompt;
  assert.ok(!lens.includes('an id "rules-<n>"'), 'the model is not asked for an id');
});

test('a throw after the synthesis writes no unverified line: the lines are gaps', async () => {
  const r = await run((label, attempt, prompt, dir) => {
    if (label !== 'synthesis') return normal(label, attempt, prompt, dir);
    const { openQuestions: _left, ...brief } = BRIEF();
    return brief;
  });
  assert.match(r.data.stopped, /^a step threw \(/u);
  assert.equal(r.data.brief, null);
  assert.equal(r.data.sources.length, 0);
  assert.ok(r.data.gaps.includes('process: "step one" — not verified; the run stopped'));
  assert.ok(
    r.data.gaps.includes(
      'goldenCases: "invented invoice → mismatch on line 2" — not verified; the run stopped',
    ),
  );
  assert.ok(!r.calls.some((c) => c.label === 'skeptic'));
  assert.equal(render(r.runDir, r.result).code, 0);
});
