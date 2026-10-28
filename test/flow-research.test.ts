import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * `.claude/workflows/flow-research.js` (/create-flow stage 1b) under stand-in agents: the
 * harness's `agent`, `parallel`, `log`, `phase`, `args` and `budget` replaced, the file compiled
 * as the harness runs it (an async function body, its result the return value). Each case is one
 * outcome the research-stage design and its re-check name.
 */

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, '.claude/workflows/flow-research.js'), 'utf8');
const renderUrl = pathToFileURL(join(root, '.claude/skills/create-flow/research-render.mjs')).href;
const { main: renderMain } = (await import(renderUrl)) as {
  main: (argv: string[], write: (text: string) => void) => number;
};
// The stand-ins answer whatever shape each step asks for.
type Any = any;
type Behave = (label: string, attempt: number, prompt: string, runDir: string) => Any;
type Body = (...values: unknown[]) => Promise<Any>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const GLOBALS = ['agent', 'parallel', 'log', 'phase', 'args', 'budget'];
// The harness's reading: an async function body, `meta` a plain constant, the result returned.
const body: Body = new AsyncFunction(...GLOBALS, source.replace('export const meta', 'const meta'));
const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const IDEA = 'Check each supplier invoice against its purchase order before we pay it.';
const ANSWERS = ['Only PDF invoices.', 'A good result is a clear match or mismatch per line.'];
const finding = (lens: string, n: number, extra: object = {}) => ({
  id: `${lens}-${n}`,
  claim: `${lens} claim ${n}`,
  url: `https://example.org/${lens}/${n}`,
  quote: `the exact words for ${lens} ${n}`,
  tier: 'T1',
  publisher: 'A body',
  ...extra,
});
function lensOut(lens: string) {
  const findings = [finding(lens, 1), finding(lens, 2)];
  const injectionSeen: string[] = [];
  if (lens === 'rules') findings.push(finding(lens, 3, { tier: 'T4' }));
  if (lens === 'vendors') {
    findings.push(finding(lens, 3, { url: 'https://evil.example.org/p' }));
    injectionSeen.push('https://evil.example.org/p');
  }
  return {
    findings,
    notFound: [`${lens}: no figure for time per invoice`],
    injectionSeen,
    toolCalls: 9,
  };
}
const BRIEF = () => ({
  process: [
    { text: 'step one', cites: ['streamlining-1'] },
    { text: 'invented step', cites: ['nope-9'] },
  ],
  waste: [{ text: 'matching takes long', cites: ['streamlining-2'] }],
  criteria: [
    { text: 'three-way match', cites: ['practice-1'] },
    { text: 'unverifiable', cites: ['practice-2'] },
  ],
  rubric: [{ text: 'line by line', cites: ['practice-1', 'rules-1'] }],
  rules: [
    { text: 'keep records', cites: ['rules-1'] },
    { text: 'from a T4 page', cites: ['rules-3'] },
  ],
  vendors: [{ text: 'QuickBooks bill API, OAuth 2, provider exists', cites: ['vendors-1'] }],
  v1: [{ text: 'match, a person approves', cites: ['streamlining-1', 'practice-1'] }],
  failures: [{ text: 'scanned PDF with no text', cites: ['vendors-2'] }],
  goldenCases: [{ input: 'invented invoice', expected: 'mismatch on line 2', cites: ['rules-1'] }],
  openQuestions: [
    {
      question: 'Tolerance on price?',
      kind: 'domain_fact',
      proposedDefault: '2 percent',
      cites: [],
    },
    {
      question: 'Tax rule?',
      kind: 'domain_fact',
      proposedDefault: 'as the statute says',
      cites: ['rules-1'],
    },
    { question: 'Which department?', kind: 'our_choice', proposedDefault: 'Finance', cites: [] },
  ],
});
/** The skeptic's two lists from its prompt: the findings it checks and the lines it judges. */
const skepticInput = (prompt: string) => {
  const [findings = '', lines = ''] = prompt.split(' Findings: ')[1]!.split(' Lines: ');
  return { findings: JSON.parse(findings) as Any[], lines: JSON.parse(lines) as Any[] };
};
const skepticSays =
  (
    lineVerdict: (text: string) => string | null = () => 'supported',
    injectionSeen: string[] = [],
  ) =>
  (prompt: string) => {
    const { findings, lines } = skepticInput(prompt);
    const verdict = (id: string) => (id === 'practice-2' ? 'not_on_page' : 'confirmed');
    return {
      verdicts: findings.map((f) => ({ id: f.id, verdict: verdict(f.id), why: 'checked' })),
      lines: lines.flatMap((l) => {
        const v = lineVerdict(l.text);
        return v ? [{ ref: l.ref, verdict: v, why: 'read' }] : [];
      }),
      injectionSeen,
    };
  };
const normalWith =
  (skeptic: (prompt: string) => Any = skepticSays()): Behave =>
  (label, _attempt, prompt, runDir) => {
    if (label === 'frame')
      return {
        ownerWords: {
          job: 'Check each supplier invoice against its purchase order',
          decision: 'whether we pay it',
          goodResult: 'A good result is a clear match or mismatch per line.',
        },
        size: 'simple',
        questions: { practice: ['q'], rules: ['q'], vendors: ['q'], streamlining: ['q'] },
      };
    if (label.endsWith(' lens')) return lensOut(label.split(' ')[0]!);
    if (label === 'synthesis') return BRIEF();
    if (label === 'skeptic') return skeptic(prompt);
    if (label === 'write') {
      const text = prompt.split('<<<JSON\n')[1]!.split('\nJSON>>>')[0]!;
      writeFileSync(join(runDir, 'research.json'), text);
      return join(runDir, 'research.json');
    }
    throw new Error(`unexpected ${label}`);
  };
const normal = normalWith();

async function run(
  behave: Behave,
  options: { total?: number; writeAttempt?: number; dir?: string } = {},
) {
  const runDir = options.dir ?? mkdtempSync(join(tmpdir(), 'autom8x-flow-research-'));
  if (!options.dir) dirs.push(runDir);
  const total = options.total ?? null;
  const logs: string[] = [];
  const calls: { label: string; prompt: string; startedAt: number }[] = [];
  const finishedAt: Record<string, number> = {};
  let [active, peak, spent, tick] = [0, 0, 0, 0];
  const budget = {
    total,
    spent: () => spent,
    remaining: () => (total ? Math.max(0, total - spent) : Infinity),
  };
  const agent = async (prompt: string, opts: { label: string }) => {
    calls.push({ label: opts.label, prompt, startedAt: tick++ });
    if (total && spent >= total) throw new Error('token target reached');
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((done) => setTimeout(done, opts.label === 'practice lens' ? 5 : 15));
      spent += 10_000;
      const attempt = calls.filter((c) => c.label === opts.label).length;
      const out = await behave(opts.label, attempt, prompt, runDir);
      finishedAt[opts.label] = tick++;
      return out;
    } finally {
      active -= 1;
    }
  };
  const parallel = async (thunks: (() => Promise<unknown>)[]) =>
    Promise.all(thunks.map((thunk) => thunk().catch(() => null)));
  const args = {
    runDir,
    automations: '/clones/snoopy-automations',
    backend: '/clones/snoopy-backend',
    name: 'invoice-check',
    idea: IDEA,
    answers: ANSWERS,
    platform: 'everything there',
    writeAttempt: options.writeAttempt,
  };
  const result = await body(
    agent,
    parallel,
    (m: string) => logs.push(m),
    () => {},
    args,
    budget,
  );
  const file = join(runDir, 'research.json');
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  return { runDir, logs, calls, peak, finishedAt, result, data };
}
const render = (runDir: string, result: Any) => {
  let out = '';
  const argv = [join(runDir, 'research.json'), result.djb2, String(result.length)];
  return { code: renderMain(argv, (text) => (out += text)), out };
};
const has = (list: string[], start: string) => list.some((line) => line.startsWith(start));

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
  assert.deepEqual(data.brief.rubric[0].cites, ['rules-1']);
  assert.ok(logs.some((l) => l.includes('direct the skeptic: https://example.org/practice/1')));
});

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
