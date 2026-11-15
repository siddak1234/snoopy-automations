// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/workflow-lint.test.mjs
// The workflow lint's tests, imported by kit.test.mjs. The pure parts; main() in scratch git repos with zizmor's
// binary and runner injected (the offline flag and environment, the config, exit 0, 1 and 2); then the real
// zizmor 1.32.0 on fixture workflows: the pinned, checksum-verified binary the lint itself uses (cached; fetched
// once, as CI's lint step fetches it), never skipped — a gate that refuses skipped tests counts it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { GIT, GIT_REPO, quietEnv } from './guard-cases.test.mjs';
import { main, offlineEnv, readFindings, summary, TOKEN_VARIABLES, zizmorArgs, zizmorAsset, zizmorBinary, zizmorCache, ZIZMOR_VERSION } from './workflow-lint.mjs';

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
};
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
async function lint(dir, { env = {}, status = 0, stdout = '[]', binary = async () => '/fake/zizmor', argv = [] } = {}) {
  const calls = [];
  const lines = [];
  const spawn = (command, args, options) => (calls.push({ command, args, env: options.env, cwd: options.cwd }), { status, stdout, stderr: 'zizmor said no' });
  const code = await outside(() => main(argv, { cwd: dir, env, out: (line) => lines.push(line), home: TMP, binary, spawn }));
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

  test('offline: no GitHub token and no ZIZMOR_ setting reaches it; --offline, JSON, the config or none, the workflows', () => {
    assert.deepEqual(TOKEN_VARIABLES, ['GH_TOKEN', 'GITHUB_TOKEN', 'ZIZMOR_GITHUB_TOKEN']);
    assert.deepEqual(offlineEnv({ PATH: '/bin', GH_TOKEN: 't', GITHUB_TOKEN: 't', ZIZMOR_GITHUB_TOKEN: 't', ZIZMOR_CONFIG: 'c' }), { PATH: '/bin' });
    assert.deepEqual(zizmorArgs({ config: null }), ['--offline', '--format', 'json', '--no-progress', '--quiet', '--no-config', '.github/workflows']);
    assert.deepEqual(zizmorArgs({ config: '.github/zizmor.yml' }).slice(5, 7), ['--config', '.github/zizmor.yml']);
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
    assert.deepEqual(calls[0].args.slice(5, 7), ['--config', '.github/zizmor.yml']);
  });

  test('exit 2 on usage, no workflows, a tool error, output that is not JSON, or a refused download', async () => {
    const dir = repo({ '.github/workflows/a.yml': WORKFLOW.good });
    assert.equal((await lint(dir, { argv: ['--fix'] })).code, 2);
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
  test('the pinned zizmor, offline, fails a workflow with no permissions and a kept token, and passes it fixed or ignored with a reason', async () => {
    const bin = await zizmorBinary();
    const run = async (text) => {
      const lines = [];
      const code = await outside(() => main([], { cwd: repo({ '.github/workflows/a.yml': text }), env: { ...process.env, GH_TOKEN: 'not-a-token' }, out: (line) => lines.push(line), binary: async () => bin }));
      return { code, text: lines.join('\n') };
    };
    const bad = await run(WORKFLOW.bad);
    assert.equal(bad.code, 1, bad.text);
    assert.match(bad.text, /by rule: artipacked 1, excessive-permissions 1$/mu);
    for (const fixed of [WORKFLOW.good, WORKFLOW.ignored]) assert.equal((await run(fixed)).code, 0, fixed);
  });
});
