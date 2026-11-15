// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/guard-cases.test.mjs
// The guard's tests (STANDARD (h) rows 1–10), imported by kit.test.mjs, so every repository's
// runner of that file runs them too. Every cases.json row runs through decide() and through the
// spawned guard CLI (under 1 s each) against a scratch root of the test's own: on macOS a real
// path under /private/tmp, so `${TMP_SCRATCH}` (the same root as /tmp/…) reaches it through the
// system's link; elsewhere a folder under the OS tmpdir. In it, `-proj/sess/scratchpad/clone` is a
// repository copy (a git work tree with an origin) and `-proj/sess/scratchpad/notes` a work tree
// with none; `${REPO}` is a git repository outside it. Row 10's resolver (lib/repo-copy.mjs) runs
// against fake readers too. Every folder is removed in after().
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../../.claude/hooks/guard.mjs';
import { makeRowTen } from '../../.claude/hooks/lib/repo-copy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// git's own list of its repository variables, which git exports to a hook: under a linked worktree's pre-push they sent the
// scratch repos' git into the pushed repository (snoopy-backend SYSTEM-MANIFEST §12.1 #342), so no other child here is given them.
export const GIT_REPO = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n');
/** A child's environment without the hook variables of whatever session runs the tests, nor git's repository variables. */
export const quietEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const key of ['CLAUDE_PROJECT_DIR', ...GIT_REPO]) delete env[key];
  return env;
};
/** `run` with process.env changed by `vars` (undefined deletes one), then put back. Kit code run in this process (the
 * guard's decide(), session-start's sessionLines) spawns git with this process's own environment, so it runs outsideGitRepo. */
export function withEnv(vars, run) {
  const was = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const put = (pairs) => Object.entries(pairs).forEach(([key, value]) => (value === undefined ? delete process.env[key] : (process.env[key] = value)));
  put(vars); try { return run(); } finally { put(was); }
}
export const outsideGitRepo = (run) => withEnv(Object.fromEntries(GIT_REPO.map((key) => [key, undefined])), run);
export const GIT = ['-c', 'user.name=kit', '-c', 'user.email=kit@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const gitInit = (dir, origin) => {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', [...GIT, 'init', '-q', '-b', 'main'], { cwd: dir, env: quietEnv() });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir, env: quietEnv() });
};

describe('guard (STANDARD (h) rows 1–10)', () => {
  const cases = JSON.parse(readFileSync(join(ROOT, '.claude/hooks/cases.json'), 'utf8')).filter((row) => typeof row === 'object');
  const values = { HOME: homedir(), SCRATCH: '', TMP_SCRATCH: '', REPO: '' };
  const fill = (v) =>
    typeof v === 'string'
      ? v.replace(/\$\{(HOME|SCRATCH|TMP_SCRATCH|REPO)\}/gu, (_, k) => values[k])
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
  let TMP;
  before(() => {
    TMP = mkdtempSync(join(tmpdir(), 'autom8x-kit-'));
    values.SCRATCH = process.platform === 'darwin' ? realpathSync(mkdtempSync('/private/tmp/autom8x-kit-')) : join(TMP, 'scratch');
    values.TMP_SCRATCH = values.SCRATCH.replace(/^\/private(?=\/tmp\/)/u, '');
    values.REPO = join(TMP, 'repo');
    gitInit(values.REPO);
    const pad = join(values.SCRATCH, '-proj/sess/scratchpad');
    gitInit(join(pad, 'clone'), 'https://example.invalid/clone.git');
    writeFileSync(join(pad, 'clone/a.txt'), 'a\n');
    gitInit(join(pad, 'notes'));
  });
  after(() => [TMP, values.SCRATCH].forEach((dir) => dir && rmSync(dir, { recursive: true, force: true })));
  const scratchEnv = () => ({ HOME: values.HOME, SCRATCH: values.SCRATCH });

  test('decide() fails open on an error of its own', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'rm -rf /etc/autom8x-x' }, cwd: '/' };
    const boom = () => { throw new Error('boom'); };
    assert.equal(decide(input, { HOME: values.HOME, toplevel: () => null }).exit, 2);
    assert.equal(decide(input, { HOME: values.HOME, toplevel: boom }).exit, 0);
  });

  // The repository root as an allowed place, judged the same on every OS: a temp repo
  // would sit under /tmp on Linux, which is allowed on its own.
  test('rm -rf inside the git toplevel passes; leaving it, or a sibling sharing its prefix, is blocked', () => {
    const rm = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: '/srv/autom8x-repo/app' }, { HOME: values.HOME, toplevel: () => '/srv/autom8x-repo' }).exit;
    assert.deepEqual(['rm -rf node_modules', 'rm -rf ../dist', 'rm -rf ../../', 'rm -rf /srv/autom8x-repo-other'].map(rm), [0, 0, 2, 2]);
  });

  // Row 3 reads the package.json script an `npm run` names, where it runs, only in the zone.
  test('an npm script whose own text runs eas build is a build on the Desktop; another script is not', () => {
    const home = join(TMP, 'home');
    const app = join(home, 'Desktop/app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ scripts: { ship: 'npx eas-cli@27.2.0 build --platform ios', lint: 'expo lint' } }));
    const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: app }, { HOME: home }).exit;
    assert.deepEqual(['npm run ship', 'npm run lint', 'npm run missing'].map(run), [2, 0, 0]);
  });

  test('cases.json holds 3 or more rows for each row of the table', () => {
    for (let row = 1; row <= 10; row++) {
      assert.ok(cases.filter((c) => c.name.startsWith(`${row}:`)).length >= 3, `row ${row}`);
    }
  });

  for (const c of cases) {
    test(`${c.name} → exit ${c.exit}${c.ask ? ', asks the owner' : ''}, through decide() and the CLI`, () => {
      const input = fill(c.input);
      let parsed;
      try { parsed = typeof input === 'string' ? JSON.parse(input) : input; } catch { parsed = undefined; }
      const verdict = outsideGitRepo(() => decide(parsed, scratchEnv()));
      assert.deepEqual([verdict.exit, verdict.ask === true], [c.exit, c.ask === true], 'decide(): exit, ask');
      if (c.exit === 2 || c.ask) assert.equal(verdict.row, Number(c.name.split(':')[0]), 'decided by its own row');
      if (c.ask) assert.match(verdict.reason, /^Outside the repositories and the scratchpad only on the owner's explicit ask \(the owner, 2026-11-06\)\. guard #9: \S/u);
      const started = Date.now();
      const stdin = typeof input === 'string' ? input : JSON.stringify(input);
      const r = spawnSync(process.execPath, [join(ROOT, '.claude/hooks/guard.mjs')], { encoding: 'utf8', timeout: 30000, cwd: TMP, input: stdin, env: quietEnv(scratchEnv()) });
      assert.ok(Date.now() - started < 1000, 'the CLI took over 1 s');
      assert.equal(r.status, c.exit, `CLI: ${r.stderr}`);
      assert.match(r.stderr, c.exit === 2 ? /^guard #\d+: .+ — .+\n$/u : /^$/u);
      assert.deepEqual(r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null, c.ask ? { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: verdict.reason } : null, 'CLI stdout: only an ask prints');
    });
  }
});

describe("row 10's resolver (lib/repo-copy.mjs) against fake readers", () => {
  const R = '/private/tmp/claude-4242';
  const PAD = `${R}/-p/s/scratchpad`;
  /** A resolver over `dirs` (existing folders), `answer(args)` for each git call, and a clock that `tick`s per call. */
  function fake(dirs, answer, tick = 0) {
    const calls = [];
    let t = 0;
    const ten = makeRowTen({
      scratch: R,
      now: () => t,
      real: (p) => p,
      stat: (p) => { if (dirs.includes(p)) return { isDirectory: () => true }; throw new Error('ENOENT'); },
      run: (cmd, args, opts) => { calls.push({ args, timeout: opts.timeout, env: opts.env }); t += tick; return answer(args); },
    });
    return { ten, calls };
  }
  const top = (dir) => (args) => (args[2] === 'rev-parse' ? { status: 0, stdout: `${dir}\n`, stderr: '' } : { status: 0, stdout: 'https://x.invalid/c.git\n', stderr: '' });

  test('outside the root, and in a session scratchpad’s docker-config, it asks git nothing', () => {
    const { ten, calls } = fake([R, PAD], () => assert.fail('git was asked'));
    for (const path of ['/Users/a/x.md', '/dev/null', `${R}-other/a`, `${PAD}/docker-config/config.json`, `${PAD}/docker-config`]) assert.equal(ten.allowed(path), true, path);
    assert.equal(calls.length, 0);
  });

  test('only exit 128 "not a git repository" refuses; a timeout, a spawn error or another git failure allows (fail open)', () => {
    const verdict = (result) => fake([R, PAD], () => result).ten.allowed(`${PAD}/a.md`);
    assert.equal(verdict({ status: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }), false);
    assert.equal(verdict({ status: 128, stderr: "fatal: detected dubious ownership in repository at '/x'\n" }), true);
    assert.equal(verdict({ status: null, signal: 'SIGTERM', stderr: '' }), true);
    assert.equal(verdict({ error: new Error('spawnSync git ENOENT'), status: null }), true);
    const { ten, calls } = fake([R, PAD], () => ({ status: 128, stderr: 'fatal: not a git repository\n' }));
    ten.allowed(`${PAD}/a.md`);
    assert.equal(calls[0].env.LC_ALL, 'C', "git's messages read in English, whatever the locale");
    // git's repository and config variables never reach row 10's git (a config one could inject remote.origin.url).
    const injected = { GIT_DIR: '/x/.git', GIT_CONFIG_PARAMETERS: "'remote.origin.url'='x'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'x', GIT_CEILING_DIRECTORIES: '/' };
    const seen = withEnv(injected, () => { const f = fake([R, PAD], () => ({ status: 128, stderr: 'fatal: not a git repository\n' })); f.ten.allowed(`${PAD}/a.md`); return f.calls[0].env; });
    for (const key of Object.keys(injected)) assert.equal(key in seen, false, key);
  });

  test('a work tree with no origin is no copy; a top level outside the root is none either', () => {
    assert.equal(fake([R, PAD, `${PAD}/notes`], (args) => (args[2] === 'rev-parse' ? { status: 0, stdout: `${PAD}/notes\n` } : { status: 1, stdout: '' })).ten.allowed(`${PAD}/notes/a.md`), false);
    assert.equal(fake([R, PAD, `${PAD}/clone`], top(`${PAD}/clone`)).ten.allowed(`${PAD}/clone/a.md`), true);
    assert.equal(fake([R, PAD], top('/Users/a/repo')).ten.allowed(`${PAD}/a.md`), false);
  });

  test('the root counts under the name the file system gives it: git prints real paths', () => {
    const real = (p) => p.replace(/^\/Users\/a\/link(?=\/|$)/u, '/Volumes/b/root');
    const ten = makeRowTen({
      scratch: '/Users/a/link',
      now: () => 0,
      real,
      stat: () => ({ isDirectory: () => true }),
      run: () => ({ status: 0, stdout: '/Volumes/b/root/-p/s/scratchpad/clone\n', stderr: '' }),
    });
    assert.equal(ten.allowed('/Users/a/link/-p/s/scratchpad/clone/a.md'), true);
    assert.equal(ten.inside('/Volumes/b/root/-p/s/scratchpad/x.md'), true);
  });

  test('git starts in the nearest existing folder, and a path inside .git starts at its work tree', () => {
    const { ten, calls } = fake([R, PAD, `${PAD}/clone`, `${PAD}/clone/.git/info`], top(`${PAD}/clone`));
    assert.equal(ten.allowed(`${PAD}/clone/new/deeper/a.ts`), true);
    assert.equal(ten.allowed(`${PAD}/clone/.git/info/exclude`), true);
    assert.deepEqual(calls.filter((c) => c.args[2] === 'rev-parse').map((c) => c.args[1]), [`${PAD}/clone`]);
  });

  test('one answer per folder, one origin read per top level, and one 1 s budget per decision', () => {
    const { ten, calls } = fake([R, PAD, `${PAD}/clone`, `${PAD}/clone/src`], top(`${PAD}/clone`), 400);
    assert.equal(ten.allowed(`${PAD}/clone/a.md`), true);
    assert.equal(ten.allowed(`${PAD}/clone/b.md`), true);
    assert.deepEqual(calls.map((c) => [c.args[2], c.timeout]), [['rev-parse', 1000], ['config', 600]]);
    // 800 ms spent: the next folder's read gets the 200 ms left, and once it is spent git is not asked.
    assert.equal(ten.allowed(`${PAD}/clone/src/c.md`), true);
    assert.equal(ten.allowed(`${PAD}/d.md`), true);
    assert.deepEqual(calls.map((c) => c.timeout), [1000, 600, 200]);
  });
});
