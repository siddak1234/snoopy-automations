// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/workflow-lint.test.mjs
// The workflow lint's tests, imported by kit.test.mjs. The pure parts; main() in scratch git repos with zizmor's
// binary and runner injected (the offline flag and environment, the config, exit 0, 1 and 2, a commit's own
// .github/); then the real zizmor 1.32.0 on fixture workflows (a workflow it cannot load, a pushed commit beside a
// different working tree): the pinned, checksum-verified binary the lint itself uses (cached; fetched once, as
// CI's lint step fetches it), never skipped — a gate that refuses skipped tests counts it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { GIT, GIT_REPO, quietEnv } from './guard-cases.test.mjs';
import { main, offlineEnv, parseArguments, pushedCommits, readFindings, summary, TOKEN_VARIABLES, zizmorArgs, zizmorAsset, zizmorBinary, zizmorCache, ZIZMOR_VERSION } from './workflow-lint.mjs';

let TMP;
before(() => (TMP = mkdtempSync(join(tmpdir(), 'autom8x-kit-lint-'))));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PIN = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const WORKFLOW = {
  // No permissions anywhere, and the checkout keeps its token: two findings.
  bad: ['name: t', 'on: push', 'jobs:', '  a:', '    runs-on: ubuntu-24.04', '    steps:', `      - uses: ${PIN}`, ''].join('\n'),
  good: ['name: t', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  a:', '    runs-on: ubuntu-24.04', '    steps:', `      - uses: ${PIN}`, '        with:', '          persist-credentials: false', ''].join('\n'),
  // The same token kept on purpose: an inline ignore with its reason.
  ignored: ['name: t', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  a:', '    runs-on: ubuntu-24.04', '    steps:', '      # A later step fetches with it.', `      - name: Checkout # zizmor: ignore[artipacked]`, `        uses: ${PIN}`, ''].join('\n'),
  // Valid YAML that is no workflow (a job's `stepz:`): GitHub refuses it, and zizmor cannot load it.
  unloadable: ['name: t', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  a:', '    runs-on: ubuntu-24.04', '    stepz:', '      - run: echo hi', ''].join('\n'),
};
const ZEROS = '0'.repeat(40);
const git = (cwd, ...args) => execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8', env: quietEnv() }).trim();
/** Everything in `dir` committed; the new commit's id. */
function commit(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
/** pre-push's stdin for a push of `sha` to a new branch. */
const pushOf = (sha) => `refs/heads/x ${sha} refs/heads/x ${ZEROS}\n`;
let made = 0;
function repo(files) {
  const dir = join(TMP, `r${++made}`);
  mkdirSync(dir);
  execFileSync('git', [...GIT, 'init', '-q', '-b', 'main'], { cwd: dir, env: quietEnv() });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
/** `fn` awaited with git's repository variables out of this process's environment (main() spawns git with it). */
async function outside(fn) {
  const was = Object.fromEntries(GIT_REPO.map((key) => [key, process.env[key]]));
  for (const key of GIT_REPO) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(was)) if (value !== undefined) process.env[key] = value;
  }
}
const finding = (ident, row, kind = 'Primary', ignored = false) => ({
  ident, ignored, determinations: { severity: 'Medium' },
  locations: [{ symbolic: { kind: 'Related', key: { Local: { verbatim_path: 'other.yml' } } }, concrete: { location: { start_point: { row: 0 } } } },
    { symbolic: { kind, key: { Local: { verbatim_path: '.github/workflows/a.yml' } } }, concrete: { location: { start_point: { row } }, feature: 'secret-looking yaml' } }],
});
async function lint(dir, { env = {}, status = 0, stdout = '[]', binary = async () => '/fake/zizmor', argv = [], stdin = '' } = {}) {
  const calls = [];
  const lines = [];
  const spawn = (command, args, options) => (calls.push({ command, args, env: options.env, cwd: options.cwd }), { status, stdout, stderr: 'zizmor said no' });
  const code = await outside(() => main(argv, { cwd: dir, env, out: (line) => lines.push(line), home: TMP, binary, spawn, stdin: () => stdin }));
  return { code, text: lines.join('\n'), calls };
}

describe('workflow lint: the pure parts', () => {
  test('zizmor is pinned by sha256 for four platforms, cached in RUNNER_TEMP under Actions, else ~/.cache/autom8x', () => {
    for (const [key, triple] of [['darwin_arm64', 'aarch64-apple-darwin'], ['darwin_x64', 'x86_64-apple-darwin'], ['linux_arm64', 'aarch64-unknown-linux-gnu'], ['linux_x64', 'x86_64-unknown-linux-gnu']]) {
      const asset = zizmorAsset(...key.split('_'));
      assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
      assert.equal(asset.url, `https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-${triple}.tar.gz`);
    }
    assert.equal(zizmorAsset('win32', 'x64'), null);
    assert.equal(zizmorCache({ GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/rt' }, '/h'), `/rt/zizmor-${ZIZMOR_VERSION}`);
    assert.equal(zizmorCache({}, '/h'), `/h/.cache/autom8x/zizmor/${ZIZMOR_VERSION}`);
  });

  test('offline: no GitHub token and no ZIZMOR_ setting reaches it; --offline, JSON, strict collection, the config or none, the workflows', () => {
    assert.deepEqual(TOKEN_VARIABLES, ['GH_TOKEN', 'GITHUB_TOKEN', 'ZIZMOR_GITHUB_TOKEN']);
    assert.deepEqual(offlineEnv({ PATH: '/bin', GH_TOKEN: 't', GITHUB_TOKEN: 't', ZIZMOR_GITHUB_TOKEN: 't', ZIZMOR_CONFIG: 'c' }), { PATH: '/bin' });
    assert.deepEqual(zizmorArgs({ config: null }), ['--offline', '--format', 'json', '--no-progress', '--quiet', '--strict-collection', '--no-config', '.github/workflows']);
    assert.deepEqual(zizmorArgs({ config: '.github/zizmor.yml' }).slice(6, 8), ['--config', '.github/zizmor.yml']);
  });

  test('what to lint: the working tree, one commit, or each commit a push names — once each, a deletion skipped (30.19.15)', () => {
    const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
    assert.deepEqual(parseArguments([]), { tree: true });
    assert.deepEqual(parseArguments(['--commit', a]), { commit: a });
    assert.deepEqual(parseArguments(['--pre-push']), { prePush: true });
    for (const bad of [['--commit'], ['--commit', '--output=x'], ['--commit', 'main'], ['--pre-push', a], ['--fix']]) assert.equal(parseArguments(bad), null, bad.join(' '));
    const stdin = [`refs/heads/x ${a} refs/heads/x ${ZEROS}`, `refs/tags/t ${a} refs/tags/t ${ZEROS}`, `(delete) ${ZEROS} refs/heads/old ${b}`, `refs/heads/y ${b} refs/heads/y ${a}`, ''].join('\n');
    assert.deepEqual(pushedCommits(stdin), [a, b]);
    assert.deepEqual(pushedCommits(''), []);
    assert.throws(() => pushedCommits(`refs/heads/x ${a}`), /not "<local ref> <local sha> <remote ref> <remote sha>"/u);
  });

  test('a finding is its rule, severity and primary place (1-based), never the YAML it quotes; an ignored one is dropped', () => {
    const json = JSON.stringify([finding('artipacked', 45), finding('excessive-permissions', 21), finding('x', 1, 'Primary', true)]);
    const found = readFindings(json);
    assert.deepEqual(found, [
      { rule: 'artipacked', severity: 'medium', path: '.github/workflows/a.yml', line: 46 },
      { rule: 'excessive-permissions', severity: 'medium', path: '.github/workflows/a.yml', line: 22 },
    ]);
    assert.deepEqual(summary([...found, found[0]]).at(-1), '  by rule: artipacked 2, excessive-permissions 1');
    assert.equal(summary(found).join('\n').includes('secret-looking'), false);
  });
});

describe('workflow lint: main(), zizmor injected', () => {
  test('exit 0 clean: run offline from the repository root, with no token in its environment and no config', async () => {
    const dir = repo({ '.github/workflows/a.yml': WORKFLOW.good });
    const { code, text, calls } = await lint(join(dir, '.github'), { env: { PATH: '/bin', GH_TOKEN: 'gh-t', GITHUB_TOKEN: 'g-t', ZIZMOR_GITHUB_TOKEN: 'z-t' } });
    assert.equal(code, 0, text);
    assert.match(text, /PASS$/u);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('--offline') && calls[0].args.includes('--no-config'));
    assert.deepEqual(calls[0].env, { PATH: '/bin' });
    assert.match(calls[0].cwd, /\/r\d+$/u);
  });

  test('exit 1 on findings, listed by rule and place; the repository’s .github/zizmor.yml is its config', async () => {
    const dir = repo({ '.github/workflows/a.yml': WORKFLOW.bad, '.github/zizmor.yml': 'rules: {}\n' });
    const { code, text, calls } = await lint(dir, { status: 13, stdout: JSON.stringify([finding('artipacked', 6), finding('excessive-permissions', 3)]) });
    assert.equal(code, 1, text);
    assert.match(text, /2 finding\(s\)\n {2}artipacked \(medium\) \.github\/workflows\/a\.yml:7\n {2}excessive-permissions \(medium\) \.github\/workflows\/a\.yml:4\n {2}by rule: artipacked 1, excessive-permissions 1\n.*FAIL/u);
    assert.deepEqual(calls[0].args.slice(6, 8), ['--config', '.github/zizmor.yml']);
  });

  test('--commit reads that commit’s .github/ into a folder of its own, its zizmor.yml the config, and removes it after', async () => {
    const dir = repo({ '.github/workflows/a.yml': WORKFLOW.good, '.github/zizmor.yml': 'rules: {}\n' });
    const sha = commit(dir, 'one');
    rmSync(join(dir, '.github'), { recursive: true });
    const { code, text, calls } = await lint(dir, { argv: ['--commit', sha] });
    assert.equal(code, 0, text);
    assert.match(text, new RegExp(`over \\.github/workflows/ at ${sha.slice(0, 12)} \\(config \\.github/zizmor\\.yml\\)`, 'u'));
    assert.deepEqual(calls[0].args.slice(6, 8), ['--config', '.github/zizmor.yml']);
    assert.notEqual(calls[0].cwd, dir);
    assert.equal(existsSync(calls[0].cwd), false, 'the folder is removed');
    const empty = repo({ 'a.md': 'a\n' });
    assert.match((await lint(empty, { argv: ['--commit', commit(empty, 'one')] })).text, /ERROR — no \.github\/workflows at [0-9a-f]{12}/u);
    assert.match((await lint(empty, { argv: ['--commit', 'f'.repeat(40)] })).text, /ERROR — f{40} is not a commit in this repository/u);
    const nothing = await lint(empty, { argv: ['--pre-push'], stdin: `(delete) ${ZEROS} refs/heads/old ${'f'.repeat(40)}\n` });
    assert.equal(nothing.code, 0, nothing.text);
    assert.equal(nothing.calls.length, 0);
  });

  test('exit 2 on usage, no workflows, a tool error, output that is not JSON, or a refused download', async () => {
    const dir = repo({ '.github/workflows/a.yml': WORKFLOW.good });
    assert.equal((await lint(dir, { argv: ['--fix'] })).code, 2);
    assert.equal((await lint(dir, { argv: ['--pre-push'], stdin: 'not a ref line\n' })).code, 2);
    assert.match((await lint(repo({ 'a.md': 'a\n' }))).text, /ERROR — no \.github\/workflows/u);
    const broken = await lint(dir, { status: 1 });
    assert.equal(broken.code, 2);
    assert.match(broken.text, /ERROR — .*exit 1.*zizmor said no/u);
    assert.equal((await lint(dir, { stdout: 'not json' })).code, 2);
    const env = { GITHUB_ACTIONS: 'true', RUNNER_TEMP: join(TMP, 'runner') };
    const refused = () => zizmorBinary(env, TMP, { fetchBytes: async () => Buffer.from('not zizmor'), extract: () => assert.fail('extracted') });
    await assert.rejects(refused(), /refused zizmor-[\w-]+\.tar\.gz: sha256 [0-9a-f]{64} is not the pinned/u);
    await assert.rejects(zizmorBinary(env, TMP, { platform: 'win32', arch: 'x64' }), /not pinned for win32_x64/u);
    const { code, text } = await lint(dir, { binary: refused });
    assert.equal(code, 2);
    assert.match(text, /ERROR — refused/u);
  });
});

describe('workflow lint: the real zizmor', () => {
  /** main() in `dir` on the pinned zizmor. */
  const real = async (dir, argv = [], stdin = '') => {
    const bin = await zizmorBinary();
    const lines = [];
    const code = await outside(() => main(argv, { cwd: dir, env: { ...process.env, GH_TOKEN: 'not-a-token' }, out: (line) => lines.push(line), binary: async () => bin, stdin: () => stdin }));
    return { code, text: lines.join('\n') };
  };
  const run = (text) => real(repo({ '.github/workflows/a.yml': text }));

  test('the pinned zizmor, offline, fails a workflow with no permissions and a kept token, and passes it fixed or ignored with a reason', async () => {
    const bad = await run(WORKFLOW.bad);
    assert.equal(bad.code, 1, bad.text);
    assert.match(bad.text, /by rule: artipacked 1, excessive-permissions 1$/mu);
    for (const fixed of [WORKFLOW.good, WORKFLOW.ignored]) assert.equal((await run(fixed)).code, 0, fixed);
  });

  test('a workflow zizmor cannot load fails the lint, never skipped while it says PASS (30.19.14)', async () => {
    const unloadable = await run(WORKFLOW.unloadable);
    assert.equal(unloadable.code, 2, unloadable.text);
    assert.match(unloadable.text, /ERROR — .*failed to load .*\.github\/workflows\/a\.yml/u);
    assert.doesNotMatch(unloadable.text, /PASS/u);
  });

  test('--pre-push judges each pushed commit, not the working tree: a dirty tree over a clean commit passes, a clean tree beside a bad pushed commit fails (30.19.15)', async () => {
    const dir = repo({ '.github/workflows/a.yml': WORKFLOW.good });
    const good = commit(dir, 'good');
    git(dir, 'switch', '-q', '-c', 'bad');
    writeFileSync(join(dir, '.github/workflows/a.yml'), WORKFLOW.bad);
    const bad = commit(dir, 'bad');
    git(dir, 'switch', '-q', 'main');

    // A dirty working tree (the bad workflow, not committed) over the clean commit pushed.
    writeFileSync(join(dir, '.github/workflows/a.yml'), WORKFLOW.bad);
    assert.equal((await real(dir)).code, 1, 'the working tree is bad, so this test is not blind');
    const dirty = await real(dir, ['--pre-push'], pushOf(good));
    assert.equal(dirty.code, 0, dirty.text);
    assert.match(dirty.text, new RegExp(`at ${good.slice(0, 12)} .*\\n.*PASS`, 'u'));

    // A clean working tree (main, good) beside the bad commit pushed from another branch.
    git(dir, 'checkout', '--', '.');
    assert.equal((await real(dir)).code, 0, 'the working tree is clean and good');
    const pushed = await real(dir, ['--pre-push'], `${pushOf(good)}refs/heads/bad ${bad} refs/heads/bad ${ZEROS}\n`);
    assert.equal(pushed.code, 1, pushed.text);
    assert.match(pushed.text, new RegExp(`at ${bad.slice(0, 12)} .*\\n.*2 finding\\(s\\)`, 'u'));
    assert.equal((await real(dir, ['--commit', bad])).code, 1);
  });
});
