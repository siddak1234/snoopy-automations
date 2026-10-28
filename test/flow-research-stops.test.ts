import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Any, finding, lensOut, normal, run, render, has } from './flow-research.js';

/**
 * `.claude/workflows/flow-research.js` under stand-in agents (`test/flow-research.ts`): its stops,
 * retries, cap and write — every stop logged and joined, every gap logged, a resume re-running
 * only the write.
 */

test('two failed lenses and a failed write: both stops logged and joined, every gap logged', async () => {
  const r = await run((label, attempt, prompt, dir) =>
    ['rules lens', 'vendors lens', 'write'].includes(label)
      ? null
      : normal(label, attempt, prompt, dir),
  );
  assert.equal(
    r.result.stopped,
    '2 of 4 lenses failed (rules, vendors); then research.json was not written',
  );
  assert.ok(r.logs.includes('stopped: 2 of 4 lenses failed (rules, vendors)'));
  assert.ok(!r.calls.some((c) => c.label === 'synthesis'));
  assert.equal(r.calls.filter((c) => c.label === 'rules lens').length, 2, 'one retry each');
  assert.equal(r.result.research, null);
  assert.ok(has(r.result.gaps, 'write: failed twice'));
  assert.ok(has(r.logs, 'gap: write: failed twice'), 'a gap after the gap log is logged too');
  assert.equal(r.logs.filter((l) => l.startsWith('gap: ')).length, r.result.gaps.length);
  assert.ok(r.logs.includes('the skeptic did not run: none of the 4 gated findings is verified'));
});

test('two failed lenses with a working write: the gaps are written, no source is', async () => {
  const r = await run((label, attempt, prompt, dir) =>
    label === 'rules lens' || label === 'vendors lens' ? null : normal(label, attempt, prompt, dir),
  );
  assert.equal(r.data.stopped, '2 of 4 lenses failed (rules, vendors)');
  assert.equal(r.data.brief, null);
  assert.equal(r.data.sources.length, 0, 'nothing unverified is written as a source');
  assert.ok(has(r.data.gaps, 'rules lens: failed twice'));
  assert.equal(render(r.runDir, r.result).code, 0);
});

test('findings past the cap of twelve are gaps, never dropped silently', async () => {
  const many = (lens: string) => ({
    ...lensOut(lens),
    findings: Array.from({ length: 14 }, (_, i) => finding(lens, i + 1)),
  });
  const { data } = await run((label, attempt, prompt, dir) =>
    label === 'practice lens' ? many('practice') : normal(label, attempt, prompt, dir),
  );
  assert.ok(data.gaps.includes('practice-13: past the cap of 12 a lens; dropped'));
  assert.ok(data.gaps.includes('practice-14: past the cap of 12 a lens; dropped'));
});

test('a throwing agent is retried once; a skeptic that throws twice stops the run', async () => {
  const r = await run((label, attempt, prompt, dir) => {
    if (label === 'vendors lens' && attempt === 1) throw new Error('terminal API error');
    if (label === 'skeptic') throw new Error('terminal API error');
    return normal(label, attempt, prompt, dir);
  });
  assert.ok(r.logs.includes('vendors lens: it threw (terminal API error); one retry'));
  assert.ok(has(r.data.gaps, 'skeptic: failed twice (it threw'));
  assert.equal(r.data.sources.length, 0);
  assert.equal(
    r.data.stopped,
    'the skeptic did not finish (it failed twice); no claim is verified',
  );
  assert.ok(r.data.brief.openQuestions.every((q: Any) => q.proposedDefault === 'a person decides'));
  assert.ok(has(r.logs, 'the skeptic did not finish (it failed twice): none of the'));
});

test('a throw outside an agent call stops the run, and the write still runs', async () => {
  const r = await run((label, attempt, prompt, dir) =>
    label === 'rules lens'
      ? { ...lensOut('rules'), findings: [{ id: 'rules-1', url: 'https://example.org/r' }] }
      : normal(label, attempt, prompt, dir),
  );
  assert.match(r.data.stopped, /^a step threw \(/u);
  assert.ok(has(r.logs, 'stopped: a step threw ('));
  assert.equal(r.data.sources.length, 0);
});

test('a spent token target: every stop joined, the gaps logged, nothing hangs, no file', async () => {
  const r = await run(normal, { total: 15_000 });
  assert.equal(
    r.result.stopped,
    'the token target is spent before the lenses; then the token target is spent; research.json was not written',
  );
  assert.ok(has(r.logs, 'gap: framing: the decision'));
  assert.equal(r.data, null);
});

test('a null write is retried once, then the run stops; the gaps were logged before it', async () => {
  const r = await run((label, attempt, prompt, dir) =>
    label === 'write' ? null : normal(label, attempt, prompt, dir),
  );
  assert.equal(r.calls.filter((c) => c.label === 'write').length, 2);
  assert.equal(r.result.stopped, 'research.json was not written');
  assert.ok(r.logs.at(-1)!.startsWith('research: stopped (research.json was not written)'));
  const firstGap = r.logs.findIndex((l) => l.startsWith('gap: '));
  assert.ok(firstGap >= 0 && firstGap < r.logs.findIndex((l) => l.startsWith('write: ')));
});

test('writeAttempt 2 changes only the write prompt, so a resume re-runs only the write', async () => {
  const one = await run(normal);
  const two = await run(normal, { writeAttempt: 2, dir: one.runDir });
  const prompt = (r: typeof one, label: string) => r.calls.find((c) => c.label === label)!.prompt;
  const changed = [...new Set(one.calls.map((c) => c.label))].filter(
    (l) => prompt(one, l) !== prompt(two, l),
  );
  assert.deepEqual(changed, ['write']);
  assert.deepEqual([one.result.djb2, one.result.length], [two.result.djb2, two.result.length]);
});
