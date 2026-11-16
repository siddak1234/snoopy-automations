// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/private-data-scan-run.test.mjs
// The private-data scan run whole (BUILD-PLAN 30.19.8, 30.19.9, 30.19.11, 30.19.13), imported by kit.test.mjs:
// main(), repoName() and gitleaks() in scratch git repos, with gitleaks' binary and runner injected (no download,
// no real gitleaks — private-data-scan.test.mjs runs the real one): the exit codes 0, 1 and 2, the config each
// repository gets, a malformed client-name pattern that no output ever quotes, a git failure named as one, and
// the fork's message.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { GIT, GIT_REPO, quietEnv } from './guard-cases.test.mjs';
import { ereToRegExp, gitleaks, gitleaksBinary, LEAKS_EXIT, main, nameFindings, PATTERN_ERROR, patternSource, repoName, run } from './private-data-scan.mjs';

let TMP;
before(() => (TMP = mkdtempSync(join(tmpdir(), 'autom8x-kit-scan-run-'))));
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8', env: quietEnv() }).trim();
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
let made = 0;
/** A scratch repository: `files` committed, then `staged` added to the index. */
function repo(files, staged = {}) {
  const dir = join(TMP, `r${++made}`);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const put = (set) => Object.entries(set).forEach(([path, text]) => (mkdirSync(join(dir, path, '..'), { recursive: true }), writeFileSync(join(dir, path), text)));
  put(files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  put(staged);
  git(dir, 'add', '-A');
  return dir;
}
const mapOf = (name) => ({ 'docs/docs-map.json': JSON.stringify({ repo: name }) });
/** gitleaks, faked: records each call's arguments and answers with `status` and `findings`. */
function fakeGitleaks({ status = 0, findings = [] } = {}) {
  const calls = [];
  return {
    calls,
    binary: async () => '/fake/gitleaks',
    spawn: (command, args) => (calls.push({ command, args }), { status, stdout: JSON.stringify(findings), stderr: 'gitleaks said no' }),
    config: () => calls.at(-1)?.args[calls.at(-1).args.indexOf('--config') + 1] ?? '',
  };
}
async function scan(dir, argv, { env = { CLIENT_DENY_PATTERN: 'wrenmoor' }, fake = fakeGitleaks(), binary } = {}) {
  const lines = [];
  const code = await outside(() => main(argv, { cwd: dir, env, out: (line) => lines.push(line), home: TMP, binary: binary ?? fake.binary, spawn: fake.spawn }));
  return { code, text: lines.join('\n') };
}

describe('private-data scan: repoName() and the config each repository gets', () => {
  test('the committed docs map names the repository; else the working tree’s; else unknown (null)', async () => {
    await outside(() => {
      assert.equal(repoName(repo(mapOf('snoopy-backend'))), 'snoopy-backend');
      const loose = repo({ 'a.md': 'a\n' });
      mkdirSync(join(loose, 'docs'));
      writeFileSync(join(loose, 'docs/docs-map.json'), JSON.stringify({ repo: 'snoopy-mobile' }));
      assert.equal(repoName(loose), 'snoopy-mobile');
      assert.equal(repoName(repo({ 'docs/docs-map.json': '{ not json' })), null);
      assert.equal(repoName(repo({ 'a.md': 'a\n' })), null);
    });
  });

  test('snoopy-backend gets private-data.toml; a public or unnamed repository gets private-data-public.toml', async () => {
    for (const [files, config, label] of [
      [mapOf('snoopy-backend'), 'private-data.toml', 'private'],
      [mapOf('snoopy'), 'private-data-public.toml', 'public'],
      [{ 'a.md': 'a\n' }, 'private-data-public.toml', 'public'],
    ]) {
      const fake = fakeGitleaks();
      const { code, text } = await scan(repo(files), ['--tree'], { fake });
      assert.equal(code, 0, text);
      assert.match(text, new RegExp(`\\(${label}\\)`, 'u'));
      assert.ok(fake.config().endsWith(`/scripts/kit/${config}`), fake.config());
    }
  });
});

describe('private-data scan: gitleaks() and main()', () => {
  test('gitleaks() hands each mode its target and reads the report; a code other than 0 or 99 is the tool failing', async () => {
    const dir = repo(mapOf('snoopy'));
    const found = [{ RuleID: 'r', File: 'a.md', StartLine: 1 }];
    const fake = fakeGitleaks({ status: LEAKS_EXIT, findings: found });
    assert.deepEqual(await outside(() => gitleaks(dir, 'tree', true, fake)), found);
    const tree = fake.calls[0].args.find((arg) => arg.startsWith('--log-opts='));
    assert.match(tree, /^--log-opts=[0-9a-f]{40}$/u, 'the synthetic commit of HEAD’s tree');
    await outside(() => gitleaks(dir, 'push', true, fake));
    assert.equal(fake.calls[1].args.find((arg) => arg.startsWith('--log-opts=')), '--log-opts=HEAD --not --remotes');
    await assert.rejects(outside(() => gitleaks(dir, 'staged', false, fakeGitleaks({ status: 1 }))), /\/fake\/gitleaks git --pre-commit failed \(exit 1\): gitleaks said no/u);
  });

  test('exit 0 clean, 1 on a finding (its rule and place, never its value), 2 on usage, outside git or a tool error', async () => {
    const dir = repo(mapOf('snoopy'));
    assert.equal((await scan(dir, ['--tree'])).code, 0);
    const leak = { RuleID: 'autom8x-email', File: 'a.md', StartLine: 3, Commit: 'c'.repeat(40), Secret: 'S3CR3T-VALUE', Match: 'to: S3CR3T-VALUE' };
    const found = await scan(dir, ['--tree'], { fake: fakeGitleaks({ status: LEAKS_EXIT, findings: [leak] }) });
    assert.equal(found.code, 1, found.text);
    assert.match(found.text, /gitleaks: 1 finding\(s\)\n {2}autom8x-email a\.md:3\n.*FAIL/u);
    assert.doesNotMatch(found.text, /S3CR3T/u);
    assert.equal((await scan(dir, [])).code, 2);
    assert.equal((await scan(dir, ['--tree', '--push'])).code, 2);
    const loose = join(TMP, 'not-a-repo');
    mkdirSync(loose);
    assert.match((await scan(loose, ['--tree'])).text, /not inside a git repository/u);
    assert.equal((await scan(loose, ['--tree'])).code, 2);
    const broken = await scan(dir, ['--tree'], { fake: fakeGitleaks({ status: 2 }) });
    assert.equal(broken.code, 2);
    assert.match(broken.text, /gitleaks: error — .*exit 2.*\n.*ERROR — the scan could not finish/u);
  });

  test('a download whose sha256 is not the pinned one is exit 2, and a machine gitleaks pins nothing for is refused', async () => {
    const env = { GITHUB_ACTIONS: 'true', RUNNER_TEMP: join(TMP, 'runner') };
    const refused = gitleaksBinary(env, TMP, { fetchBytes: async () => Buffer.from('not gitleaks'), extract: () => assert.fail('extracted') });
    await assert.rejects(refused, /refused gitleaks_[\d.]+_\w+\.tar\.gz: sha256 [0-9a-f]{64} is not the pinned/u);
    await assert.rejects(gitleaksBinary(env, TMP, { platform: 'win32', arch: 'x64' }), /not pinned for win32_x64/u);
    const binary = () => gitleaksBinary(env, TMP, { fetchBytes: async () => Buffer.from('not gitleaks') });
    const { code, text } = await scan(repo(mapOf('snoopy')), ['--tree'], { binary });
    assert.equal(code, 2);
    assert.match(text, /gitleaks: error — refused/u);
  });

  test('CI without the pattern is exit 2, and the client names are never skipped silently there', async () => {
    const { code, text } = await scan(repo(mapOf('snoopy')), ['--tree'], { env: { GITHUB_ACTIONS: 'true', CLIENT_DENY_PATTERN: '' } });
    assert.equal(code, 2);
    assert.match(text, /client names: error — CLIENT_DENY_PATTERN is not set: add the repository secret/u);
  });
});

describe('private-data scan: a malformed pattern is never echoed (30.19.8)', () => {
  // A deliberately malformed dummy: an unclosed group, which RegExp and git both refuse while quoting it.
  const bad = ['zqvx(hold', 'ings'].join('');
  test('RegExp’s refusal is a fixed message, not the one that quotes the pattern', () => {
    assert.throws(() => ereToRegExp(bad), (error) => error.message === PATTERN_ERROR);
    assert.throws(() => new RegExp(bad), (error) => error.message.includes(bad), 'RegExp itself quotes it: the test is not blind');
  });

  test('in every mode the scan says the pattern could not be used, exits 2, and its output never holds the pattern', async () => {
    const dir = repo(mapOf('snoopy'), { 'new.md': 'new\n' });
    for (const mode of ['--tree', '--staged', '--push', '--history']) {
      const { code, text } = await scan(dir, [mode], { env: { CLIENT_DENY_PATTERN: bad } });
      assert.equal(code, 2, `${mode}: ${text}`);
      assert.ok(text.includes(PATTERN_ERROR), `${mode}: ${text}`);
      assert.equal(text.toLowerCase().includes('zqvx'), false, `${mode} printed the pattern`);
    }
  });

  test('a quiet command’s error leaves out what it wrote to stderr', () => {
    const spawn = () => ({ status: 128, stdout: '', stderr: `fatal: command line, '${bad}': Unmatched (` });
    assert.throws(() => run('git', ['grep'], { spawn }), (error) => error.message.includes(bad));
    assert.throws(() => run('git', ['grep'], { spawn, quiet: true }), (error) => !error.message.includes('zqvx') && /exit 128/u.test(error.message) && error.status === 128);
  });
});

describe('private-data scan: a git failure is named as one, never as the pattern (30.19.13)', () => {
  const failed = (verb) => new RegExp(`git ${verb} failed \\(exit 128\\); its message is not shown because it can quote the pattern`, 'u');
  test('--tree in a repository with no commit: git grep failed, with its exit code; not "the pattern could not be used"', async () => {
    const dir = join(TMP, `empty${++made}`);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    const { code, text } = await scan(dir, ['--tree']);
    assert.equal(code, 2, text);
    assert.match(text, new RegExp(`client names: error — ${failed('grep').source}`, 'u'));
    assert.equal(text.includes(PATTERN_ERROR), false, text);
  });

  test('git log outside a repository failed by itself; a valid pattern is never blamed, a malformed one still is', async () => {
    const loose = join(TMP, `loose${++made}`);
    mkdirSync(loose);
    await outside(() => {
      assert.throws(() => nameFindings(loose, 'history', 'wrenmoor'), (error) => failed('log').test(error.message) && !error.message.includes(PATTERN_ERROR));
      const dir = repo(mapOf('snoopy'));
      assert.throws(() => nameFindings(dir, 'history', ['zqvx(hold', 'ings'].join('')), (error) => error.message === `git log: ${PATTERN_ERROR}`);
      assert.throws(() => nameFindings(dir, 'tree', ['zqvx(hold', 'ings'].join('')), (error) => error.message === `git grep: ${PATTERN_ERROR}`);
    });
  });
});

describe('private-data scan: a fork’s pull request is told why it cannot be scanned (30.19.11)', () => {
  const event = (head) => (path) => (path === '/e/event.json' ? JSON.stringify({ pull_request: { head } }) : null);
  const ci = (extra, readFile) => patternSource({ env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: '/e/event.json', ...extra }, home: '/h', readFile, publicRepo: true });
  test('a fork’s pull request (or one whose fork is gone) fails saying it cannot be scanned and the owner’s pushes are', () => {
    for (const head of [{ repo: { full_name: 'someone/r' } }, { repo: null }]) {
      const { fail } = ci({ GITHUB_EVENT_NAME: 'pull_request' }, event(head));
      assert.match(fail, /a fork’s pull request gets no secrets, so its client names cannot be scanned here; the owner’s pushes to this repository are/u);
      assert.doesNotMatch(fail, /add the repository secret/u);
    }
  });

  test('the repository’s own pull request, a push, or an unreadable event keeps "add the repository secret"', () => {
    for (const [name, readFile] of [['pull_request', event({ repo: { full_name: 'o/r' } })], ['push', event({ repo: { full_name: 'someone/r' } })], ['pull_request', () => null]]) {
      assert.match(ci({ GITHUB_EVENT_NAME: name }, readFile).fail, /^CLIENT_DENY_PATTERN is not set: add the repository secret/u, name);
    }
  });
});
