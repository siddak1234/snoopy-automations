import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * The stand-in harness for `.claude/workflows/flow-research.js` (/create-flow stage 1b): the
 * Workflow tool's `agent`, `parallel`, `log`, `phase`, `args` and `budget` replaced, the file
 * compiled as the tool runs it (an async function body, its top-level return the result). Its
 * cases are in `test/flow-research.test.ts` (the gates) and `test/flow-research-stops.test.ts`
 * (stops, retries and the write).
 */

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, '.claude/workflows/flow-research.js'), 'utf8');
const renderUrl = pathToFileURL(join(root, '.claude/skills/create-flow/research-render.mjs')).href;
const { main: renderMain } = (await import(renderUrl)) as {
  main: (argv: string[], write: (text: string) => void) => number;
};
// The stand-ins answer whatever shape each step asks for.
export type Any = any;
export type Behave = (label: string, attempt: number, prompt: string, runDir: string) => Any;
type Body = (...values: unknown[]) => Promise<Any>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const GLOBALS = ['agent', 'parallel', 'log', 'phase', 'args', 'budget'];
// The harness's reading: an async function body, `meta` a plain constant, the result returned. This
// is the syntax check too: `node --check` refuses the top-level return the result travels in.
export const compile = (): Body =>
  new AsyncFunction(...GLOBALS, source.replace('export const meta', 'const meta'));
const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const IDEA = 'Check each supplier invoice against its purchase order before we pay it.';
const ANSWERS = ['Only PDF invoices.', 'A good result is a clear match or mismatch per line.'];
export const finding = (lens: string, n: number, extra: object = {}) => ({
  id: `${lens}-${n}`,
  claim: `${lens} claim ${n}`,
  url: `https://example.org/${lens}/${n}`,
  quote: `the exact words for ${lens} ${n}`,
  tier: 'T1',
  publisher: 'A body',
  ...extra,
});
export function lensOut(lens: string) {
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
export const BRIEF = () => ({
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
export const skepticInput = (prompt: string) => {
  const [findings = '', lines = ''] = prompt.split(' Findings: ')[1]!.split(' Lines: ');
  return { findings: JSON.parse(findings) as Any[], lines: JSON.parse(lines) as Any[] };
};
export const skepticSays =
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
export const normalWith =
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
export const normal = normalWith();

export async function run(
  behave: Behave,
  options: { total?: number; writeAttempt?: number; dir?: string; noBackend?: boolean } = {},
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
    ...(options.noBackend ? {} : { backend: '/clones/snoopy-backend' }),
    name: 'invoice-check',
    idea: IDEA,
    answers: ANSWERS,
    platform: 'everything there',
    writeAttempt: options.writeAttempt,
  };
  const result = await compile()(
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
export const render = (runDir: string, result: Any) => {
  let out = '';
  const argv = [join(runDir, 'research.json'), result.djb2, String(result.length)];
  return { code: renderMain(argv, (text) => (out += text)), out };
};
export const has = (list: string[], start: string) => list.some((line) => line.startsWith(start));
