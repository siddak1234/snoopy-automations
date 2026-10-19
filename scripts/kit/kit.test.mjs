// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/kit.test.mjs
// The kit's own tests (node:test, Node built-ins only). Every cases.json row runs
// through decide() and through the spawned guard CLI (under 1 s each);
// quick-hygiene runs against fake readers; stop-check always exits 0; check-docs
// meets every fail and pass case of STANDARD (e) and the --map-only line limits;
// map --check goes stale. Temp git repos live under mkdtemp(<os tmpdir>/autom8x-kit-)
// and are removed in after(). Run: node --test scripts/kit/kit.test.mjs, or through
// the repository's runner, which imports this file.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../../.claude/hooks/guard.mjs';
import { makeProbes, scratchRoot } from '../../.claude/hooks/lib/quick-hygiene.mjs';
import { sessionLines } from '../../.claude/hooks/session-start.mjs';
import { stopCheck } from '../../.claude/hooks/stop-check.mjs';
import { matches } from './check-docs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const at = (path) => join(ROOT, path);
export const KIT_FILES = [
  '.claude/hooks/guard.mjs',
  '.claude/hooks/session-start.mjs',
  '.claude/hooks/stop-check.mjs',
  '.claude/hooks/lib/quick-hygiene.mjs',
  '.claude/hooks/cases.json',
  '.claude/agents/explorer.md',
  '.claude/agents/reviewer.md',
  '.claude/agents/builder.md',
  'scripts/kit/check-docs.mjs',
  'scripts/kit/map.mjs',
  'scripts/kit/kit.test.mjs',
];

let TMP;
before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'autom8x-kit-'));
});
after(() => rmSync(TMP, { recursive: true, force: true }));

// A child's environment without the hook variables of whatever session runs the tests.
const quietEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  delete env.CLAUDE_PROJECT_DIR;
  return env;
};
const node = (script, args, opts = {}) =>
  spawnSync(process.execPath, [at(script), ...args], { encoding: 'utf8', timeout: 30000, cwd: TMP, env: quietEnv(), ...opts });
const GIT = ['-c', 'user.name=kit', '-c', 'user.email=kit@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const git = (cwd, ...args) => execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' }).trim();
function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, path), { force: true });
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }
}
let made = 0;
function repo(files) {
  const dir = join(TMP, `r${++made}`);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
function commit(dir, files, message = 'change') {
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}
const linesOf = (n) => `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`;

describe('guard (STANDARD (h) rows 1–8)', () => {
  const cases = JSON.parse(readFileSync(at('.claude/hooks/cases.json'), 'utf8')).filter((row) => typeof row === 'object');
  const values = { HOME: homedir(), SCRATCH: scratchRoot(), REPO: '' };
  const fill = (v) =>
    typeof v === 'string'
      ? v.replace(/\$\{(HOME|SCRATCH|REPO)\}/gu, (_, k) => values[k])
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
  before(() => {
    values.REPO = repo({ 'a.txt': 'a\n' });
  });

  test('decide() fails open on an error of its own', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'rm -rf /etc/autom8x-x' }, cwd: '/' };
    const boom = () => {
      throw new Error('boom');
    };
    assert.equal(decide(input, { HOME: values.HOME, toplevel: () => null }).exit, 2);
    assert.equal(decide(input, { HOME: values.HOME, toplevel: boom }).exit, 0);
  });

  // The repository root as an allowed place, judged the same on every OS: a temp repo
  // would sit under /tmp on Linux, which is allowed on its own.
  test('rm -rf inside the git toplevel passes; leaving it, or a sibling sharing its prefix, is blocked', () => {
    const rm = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: '/srv/autom8x-repo/app' }, { HOME: values.HOME, toplevel: () => '/srv/autom8x-repo' }).exit;
    assert.deepEqual(['rm -rf node_modules', 'rm -rf ../dist', 'rm -rf ../../', 'rm -rf /srv/autom8x-repo-other'].map(rm), [0, 0, 2, 2]);
  });

  test('cases.json holds 3 or more rows for each row of the table', () => {
    for (let row = 1; row <= 8; row++) {
      assert.ok(cases.filter((c) => c.name.startsWith(`${row}:`)).length >= 3, `row ${row}`);
    }
  });

  for (const c of cases) {
    test(`${c.name} → exit ${c.exit}, through decide() and the CLI`, () => {
      const input = fill(c.input);
      let parsed;
      try {
        parsed = typeof input === 'string' ? JSON.parse(input) : input;
      } catch {
        parsed = undefined;
      }
      const verdict = decide(parsed, { HOME: values.HOME });
      assert.equal(verdict.exit, c.exit, 'decide()');
      if (c.exit === 2) assert.equal(verdict.row, Number(c.name[0]), 'blocked by its own row');
      const started = Date.now();
      const stdin = typeof input === 'string' ? input : JSON.stringify(input);
      const r = node('.claude/hooks/guard.mjs', [], { input: stdin, env: quietEnv({ HOME: values.HOME }) });
      assert.ok(Date.now() - started < 1000, 'the CLI took over 1 s');
      assert.equal(r.status, c.exit, `CLI: ${r.stderr}`);
      if (c.exit === 2) assert.match(r.stderr, /^guard #\d: .+ — .+\n$/u);
      else assert.equal(r.stderr, '');
    });
  }
});

describe('quick-hygiene, session-start and stop-check', () => {
  test('quick-hygiene reports facts through the readers it is given', () => {
    const root = '/private/tmp/claude-4242';
    const dirs = {
      [root]: ['-proj', 'autom8x-gate.lock', 'hygiene-warnings.log'],
      [`${root}/-proj`]: ['s1', 's2'],
      '/private/tmp': ['autom8x-publish-1', 'other'],
      '/fake/tmp': ['autom8x-local-ci-2'],
    };
    const mtimes = { [`${root}/-proj`]: 0, [`${root}/-proj/s1`]: 1000, [`${root}/-proj/s2`]: 4000, [`${root}/autom8x-gate.lock`]: 5000, '/private/tmp/autom8x-publish-1': 0, '/fake/tmp/autom8x-local-ci-2': 0 };
    const files = { [`${root}/autom8x-gate.lock/holder`]: 'auto 10:00Z\n', [`${root}/hygiene-warnings.log`]: 'w1\nw2\nw3\nw4\n' };
    const p = makeProbes({
      uid: () => 4242,
      tmpdir: () => '/fake/tmp',
      now: () => 10000,
      readdir: (d) => dirs[d] ?? [],
      stat: (path) => (path in mtimes ? { mtimeMs: mtimes[path], dir: true } : null),
      readFile: (path) => files[path] ?? null,
      ps: () => `  PID ELAPSED COMMAND\n   11 01:00 node ${root}/-proj/s1/scratchpad/srv.mjs\n   12 02:00 /bin/zsh\n ${process.pid} 00:01 node ${root}/self\n`,
    });
    assert.equal(p.scratchRoot(), root);
    assert.equal(p.sessionDir('/Users/a/My Proj'), `${root}/-Users-a-My-Proj`);
    assert.equal(p.sessionDir('/proj', 's1'), `${root}/-proj/s1`);
    assert.equal(p.sessionDir('/proj', 'gone'), `${root}/-proj`);
    assert.deepEqual(p.processesUnder(root).map((x) => x.pid), [11]);
    assert.deepEqual(p.tempDirs().map((t) => t.path), ['/private/tmp/autom8x-publish-1', '/fake/tmp/autom8x-local-ci-2']);
    assert.deepEqual(p.scratchSessions().map((s) => s.path), [`${root}/-proj/s1`, `${root}/-proj/s2`]);
    assert.deepEqual(p.gateLock(), { holder: 'auto 10:00Z', ageMs: 5000 });
    assert.deepEqual(p.warningsTail(2), ['w3', 'w4']);
    const summary = p.quickSummary().join('\n');
    assert.match(summary, /scratch processes 1 · autom8x temp dirs 2 · scratch sessions 2 \(oldest 9s\) · gate lock held by auto 10:00Z for 5s/u);
    assert.match(summary, /pid 11 01:00 node .*srv\.mjs/u);
    assert.match(summary, /hygiene warnings \(latest\):\n {2}w2\n {2}w3\n {2}w4$/u);
  });

  test('stop-check warns and logs what is left under the session folder, and always exits 0', () => {
    const logged = [];
    const probes = {
      sessionDir: (_cwd, id) => `/s/${id}`,
      processesUnder: (dir) => (dir === '/s/busy' ? [{ pid: 7, etime: '01:00', command: 'node /s/busy/srv.mjs' }] : []),
      warningsLog: () => '/s/hygiene-warnings.log',
    };
    const warning = stopCheck({ cwd: '/x', session_id: 'busy' }, probes, (path, line) => logged.push([path, line]));
    assert.match(warning, /1 process\(es\) still running under \/s\/busy .*pid 7 \(01:00\) node \/s\/busy\/srv\.mjs/u);
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], '/s/hygiene-warnings.log');
    assert.match(logged[0][1], /^\d{4}-\d\d-\d\dT.* stop-check: 1 process\(es\) still running under \/s\/busy: pid 7/u);
    assert.equal(stopCheck({ cwd: '/x', session_id: 'idle' }, probes, () => assert.fail('logged with nothing left')), null);
    for (const input of ['{not json', '', JSON.stringify({ cwd: TMP, session_id: 'autom8x-kit-none' })]) {
      assert.equal(node('.claude/hooks/stop-check.mjs', [], { input }).status, 0, `stdin ${JSON.stringify(input)}`);
    }
  });

  test('session-start prints 15 lines or fewer, git state first, and exits 0', () => {
    const dir = repo({ 'a.txt': 'a\n' });
    write(dir, { 'b.txt': 'b\n' });
    const r = node('.claude/hooks/session-start.mjs', [], { input: JSON.stringify({ cwd: dir }) });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trimEnd().split('\n');
    assert.ok(out.length <= 15, `${out.length} lines`);
    assert.match(out[0], /^r\d+ · branch main · no local origin\/main · dirty 1 · worktrees 1 · stashes 0$/u);
    assert.match(out[1], /^hygiene: scratch processes \d+/u);
    assert.equal(sessionLines(dir, () => Array(30).fill('x')).length, 15);
    assert.equal(node('.claude/hooks/session-start.mjs', [], { input: '{not json' }).status, 0);
  });
});

describe('check-docs (STANDARD (e))', () => {
  test('the glob engine: ** any folders or none, * and ? within one segment', () => {
    for (const [glob, path] of [['**/*.test.ts', 'x.test.ts'], ['**/*.test.ts', 'a/b/x.test.ts'], ['**/test/**', 'a/test/b/c.ts'], ['src/**', 'src/a/b.mjs'], ['a?c/*.md', 'abc/x.md']]) assert.ok(matches(glob, path), `${glob} should match ${path}`);
    for (const [glob, path] of [['src/*', 'src/a/b.mjs'], ['a?c', 'a/c'], ['src/**', 'srcx/a'], ['*.md', 'docs/a.md']]) assert.ok(!matches(glob, path), `${glob} should not match ${path}`);
  });

  const MAP = {
    version: 1,
    repo: 'demo-app',
    generated: ['docs/MAP.md'],
    ignore: ['**/*.test.mjs'],
    unmapped: { docs: 'the documents themselves', '.claude': 'the kit' },
    rules: [{ id: 'src', code: ['src/**'], docs: ['README.md', 'docs/MAP.md'] }],
    facts: [{ key: 'widgets', home: 'README.md', pattern: '\\*\\*\\d+ widgets\\*\\*' }],
    records: { current: [], archive: [] },
    map: { kind: 'service', readFirst: ['README.md'], folders: [], lists: [{ title: 'Sources', glob: 'src/*.mjs', as: 'header-line' }] },
  };
  const README = '# demo\n\nThe demo. **3 widgets**.\n';
  const BASE = { 'docs/docs-map.json': JSON.stringify(MAP), 'README.md': README, 'src/a.mjs': '// a\nexport const a = 1;\n', 'src/old.mjs': '// old\n', 'docs/MAP.md': 'x\n', 'docs/notes.md': '# notes\n' };
  const withDocs = (files) => ({ ...files, 'README.md': `${README}Changed.\n` });
  const CASES = [
    { name: 'code with docs passes', commits: [[withDocs({ 'src/a.mjs': '// a\nexport const a = 2;\n' })]], exit: 0 },
    { name: 'code without docs fails', commits: [[{ 'src/a.mjs': '// a\nexport const a = 2;\n' }]], exit: 1, out: /rule src: src\/a\.mjs changed without README\.md/u },
    { name: 'a valid trailer passes', commits: [[{ 'src/a.mjs': '// a2\n' }, 'refactor\n\nDocs-Unchanged: renames a local; nothing a doc says changes']], exit: 0 },
    { name: 'an empty trailer reason fails', commits: [[{ 'src/a.mjs': '// a2\n' }, 'refactor\n\nDocs-Unchanged:']], exit: 1, out: /under 12 characters/u },
    { name: 'a short trailer reason fails', commits: [[{ 'src/a.mjs': '// a2\n' }, 'refactor\n\nDocs-Unchanged: tiny']], exit: 1, out: /"tiny" is under 12/u },
    { name: 'only a generated file fails', commits: [[{ 'src/a.mjs': '// a2\n', 'docs/MAP.md': 'y\n' }]], exit: 1, out: /rule src/u },
    { name: 'an empty range passes', commits: [], exit: 0 },
    { name: 'no base fails', commits: [[withDocs({ 'src/a.mjs': '// a2\n' })]], args: [], exit: 1, out: /fetch origin main \(CI: fetch-depth: 0\)/u },
    { name: '$DOCS_BASE is a base', commits: [[{ 'src/a.mjs': '// a2\n' }]], args: [], env: true, exit: 1, out: /rule src/u },
    { name: 'a missing doc in the map fails', map: { rules: [{ id: 'src', code: ['src/**'], docs: ['docs/missing.md'] }] }, commits: [], args: ['--map-only'], exit: 1, out: /rule src names docs\/missing\.md, which does not exist/u },
    { name: 'a glob matching nothing fails', map: { rules: [{ id: 'src', code: ['lib/**', 'src/**'], docs: ['README.md'] }] }, commits: [], args: ['--map-only'], exit: 1, out: /lib\/\*\* matches no file/u },
    { name: 'an unmapped folder fails', commits: [[{ 'tools/x.mjs': '// x\n' }]], exit: 1, out: /tools\/: top-level folder covered by no rule/u },
    { name: 'an ignored file triggers no rule', commits: [[{ 'src/a.test.mjs': '// t\n' }]], exit: 0 },
    { name: 'a duplicated fact fails', commits: [[{ 'docs/notes.md': '# notes\n\nWe have **4 widgets**.\n' }]], exit: 1, out: /docs\/notes\.md:3: repeats fact widgets — link to README\.md/u },
    { name: 'a broken path in a changed comment fails', commits: [[withDocs({ 'src/a.mjs': '// see `src/nope.mjs`\n' })]], exit: 1, out: /src\/a\.mjs:1: src\/nope\.mjs does not resolve/u },
    { name: 'a broken link in a changed doc fails', commits: [[{ 'docs/notes.md': '# notes\n\n[x](gone.md)\n' }]], exit: 1, out: /gone\.md does not resolve/u },
    { name: 'a struck removed file passes', commits: [[withDocs({ 'src/old.mjs': null, 'docs/notes.md': '# notes\n\n~~`src/old.mjs`~~ is gone.\n' })]], exit: 0 },
    { name: 'a struck file git never added fails', commits: [[{ 'docs/notes.md': '# notes\n\n~~`src/never.mjs`~~\n' }]], exit: 1, out: /git never added/u },
    { name: 'a path git ignores is not checked', base: { '.gitignore': 'dist/\n' }, commits: [[{ 'docs/notes.md': '# notes\n\n`dist/retry.js`\n' }]], exit: 0 },
    { name: 'a built entrypoint resolves through its source', base: { '.gitignore': 'dist/\n', 'docs/src/b.ts': 'export {};\n' }, commits: [[{ 'docs/notes.md': '# notes\n\n`docs/dist/b.js`\n' }]], exit: 0 },
    { name: "an installed package's built file is not checked (Next's own AGENTS.md block names one)", base: { '.gitignore': 'node_modules/\n' }, commits: [[{ 'docs/notes.md': '# notes\n\n`node_modules/next/dist/server/lib/generate-agent-files.js`\n' }]], exit: 0 },
    { name: 'a mistyped built entrypoint fails, ignored or not', base: { '.gitignore': 'dist/\n' }, commits: [[{ 'docs/notes.md': '# notes\n\n`docs/dist/nope.js`\n' }]], exit: 1, out: /docs\/dist\/nope\.js does not resolve/u },
    { name: "another repository's path is not checked", commits: [[withDocs({ 'src/a.mjs': '// see `demo-api/src/x.mjs` and `demo/lib/y.ts`\n' })]], exit: 0 },
    { name: 'a router of 150 lines passes', base: { 'CLAUDE.md': linesOf(150) }, commits: [], args: ['--map-only'], exit: 0 },
    { name: 'a router over 150 lines fails', base: { 'CLAUDE.md': linesOf(151) }, commits: [], args: ['--map-only'], exit: 1, out: /CLAUDE\.md: the router has 151 lines, over 150/u },
    { name: 'AGENTS.md is the router when CLAUDE.md is @AGENTS.md', base: { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': linesOf(151) }, commits: [], args: ['--map-only'], exit: 1, out: /AGENTS\.md: the router has 151 lines/u },
    { name: 'a folder CLAUDE.md over 60 lines fails', base: { 'src/CLAUDE.md': linesOf(61) }, commits: [], args: ['--map-only'], exit: 1, out: /src\/CLAUDE\.md: a folder CLAUDE\.md has 61 lines, over 60/u },
    { name: 'a SKILL.md over 120 lines fails', base: { '.claude/skills/x/SKILL.md': linesOf(121) }, commits: [], args: ['--map-only'], exit: 1, out: /SKILL\.md: a SKILL\.md has 121 lines, over 120/u },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      const dir = repo({ ...BASE, ...(c.map ? { 'docs/docs-map.json': JSON.stringify({ ...MAP, ...c.map }) } : {}), ...(c.base ?? {}) });
      const base = git(dir, 'rev-parse', 'HEAD');
      for (const [files, message] of c.commits) commit(dir, files, message);
      const args = c.args ?? ['--base', base];
      const r = node('scripts/kit/check-docs.mjs', args, { cwd: dir, env: quietEnv({ DOCS_BASE: c.env ? base : '' }) });
      assert.equal(r.status, c.exit, r.stdout + r.stderr);
      if (c.out) assert.match(r.stdout, c.out);
      if (c.exit === 0) assert.match(r.stdout, /^check-docs: ok/mu);
    });
  }

  test('--json reports the same problems as data', () => {
    const dir = repo(BASE);
    const base = git(dir, 'rev-parse', 'HEAD');
    commit(dir, { 'src/a.mjs': '// a2\n' });
    const r = node('scripts/kit/check-docs.mjs', ['--base', base, '--json'], { cwd: dir });
    const result = JSON.parse(r.stdout);
    assert.equal(r.status, 1);
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems.map((p) => p.check), ['docs']);
    assert.equal(result.commits, 1);
  });

  test('map writes the eight sections, --check goes stale when a listed file is added, and over 300 lines fails', () => {
    const dir = repo(BASE);
    assert.equal(node('scripts/kit/map.mjs', [], { cwd: dir }).status, 0);
    assert.equal(node('scripts/kit/map.mjs', ['--check'], { cwd: dir }).status, 0);
    const text = readFileSync(join(dir, 'docs/MAP.md'), 'utf8');
    assert.match(text, /^<!-- Generated by scripts\/kit\/map\.mjs/u);
    assert.deepEqual(text.match(/^## .+$/gmu), ['## Read first', '## Where to look by task', '## Folders', '## package.json scripts', '## Kind lists', '## Skills, agents and hooks', '## Records by size']);
    assert.match(text, /\[src\/a\.mjs\]\(\.\.\/src\/a\.mjs\): a/u);
    assert.equal(node('scripts/kit/map.mjs', ['--stdout'], { cwd: dir }).stdout, text);
    write(dir, { 'src/new.mjs': '// new\n' });
    const stale = node('scripts/kit/map.mjs', ['--check'], { cwd: dir });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /docs\/MAP\.md is stale — run npm run map/u);
    write(dir, Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`src/f${i}.mjs`, '// f\n'])));
    const long = node('scripts/kit/map.mjs', ['--stdout'], { cwd: dir });
    assert.equal(long.status, 1);
    assert.match(long.stderr, /over 300/u);
  });
});

describe('the kit itself', () => {
  test('every kit file names its own canonical path on its marker line', () => {
    for (const file of KIT_FILES) {
      const head = readFileSync(at(file), 'utf8').split('\n').slice(0, 8).join('\n');
      const m = /autom8x-kit v1 — canonical: [\w-]+\/([^\s"]+)/u.exec(head);
      assert.equal(m?.[1], file, file);
    }
  });

  test('the agents carry the roles of STANDARD (g)', () => {
    const want = { explorer: ['Read, Grep, Glob', 'sonnet'], reviewer: ['Read, Grep, Glob, Bash', 'inherit'], builder: [undefined, 'inherit'] };
    for (const [name, [tools, model]] of Object.entries(want)) {
      const text = readFileSync(at(`.claude/agents/${name}.md`), 'utf8');
      const [, fm, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(text);
      const field = (key) => new RegExp(`^${key}: (.*)$`, 'mu').exec(fm)?.[1];
      assert.equal(field('name'), name);
      assert.ok((field('description') ?? '').length > 20, `${name} description`);
      assert.equal(field('tools'), tools, `${name} tools`);
      assert.equal(field('model'), model, `${name} model`);
      assert.ok(body.trim().split('\n').length <= 40, `${name} body over 40 lines`);
    }
  });
});
