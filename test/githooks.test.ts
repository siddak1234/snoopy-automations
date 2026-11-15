import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * The committed git hooks (CLAUDE.md rule 10): `npm run hooks:install` points git at `.githooks/`,
 * whose pre-commit hook runs the kit's private-data scan on the staged content and whose pre-push
 * hook runs it on the commits being pushed, to any remote, with git's ref lines on its stdin. A
 * finding, a scan that cannot run or a missing scan refuses either one. Driven as git drives them,
 * in a throwaway repository whose scan is a stub that notes its arguments and stdin and exits
 * FAKE_SCAN (0, clean, by default).
 */

const root = resolve(import.meta.dirname, '..');
const hooks = join(root, '.githooks');
const ZERO = '0000000000000000000000000000000000000000';

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'githooks-'));
  const repo = join(base, 'repo');
  const log = join(base, 'scan.log');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  write(
    join(repo, 'scripts/kit/private-data-scan.mjs'),
    `import { appendFileSync, readFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');\nprocess.exit(Number(process.env.FAKE_SCAN ?? 0));\n`,
  );
  write(join(repo, 'README.md'), '# one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  return {
    base,
    repo,
    scans: (): { args: string[]; input: string }[] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    reset: () => rmSync(log, { force: true }),
  };
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FAKE_SCAN;
  return { ...env, ...extra };
}

/** A real `git commit` with this repository's hooks armed. */
function commit(repo: string, extra: Record<string, string> = {}) {
  write(join(repo, 'notes.md'), `${Math.random()}\n`);
  git(repo, 'add', 'notes.md');
  const run = spawnSync(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      '-c',
      `core.hooksPath=${hooks}`,
      'commit',
      '-q',
      '-m',
      'next',
    ],
    { cwd: repo, encoding: 'utf8', env: cleanEnv(extra) },
  );
  return { exit: run.status, stderr: run.stderr };
}

/** The pre-push hook as git calls it: remote name and url, the ref lines on stdin. */
function push(repo: string, url: string, lines: string, extra: Record<string, string> = {}) {
  const run = spawnSync('sh', [join(hooks, 'pre-push'), 'origin', url], {
    cwd: repo,
    encoding: 'utf8',
    input: lines,
    env: cleanEnv(extra),
  });
  return { exit: run.status, stderr: run.stderr };
}

test('npm run hooks:install points git at .githooks/, whose two hooks are executable', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['hooks:install'], 'git config core.hooksPath .githooks');
  for (const name of ['pre-commit', 'pre-push']) {
    assert.ok((statSync(join(hooks, name)).mode & 0o111) !== 0, `${name} is executable`);
  }
});

test('the pre-commit hook scans the staged content and refuses a commit on a finding, a failure or a missing scan', (t) => {
  const { base, repo, scans } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const head = () => git(repo, 'rev-parse', 'HEAD');

  const before = head();
  const clean = commit(repo);
  assert.equal(clean.exit, 0, clean.stderr);
  assert.notEqual(head(), before, 'a clean scan lets the commit land');
  assert.deepEqual(scans(), [{ args: ['--staged'], input: '' }]);

  for (const [code, message] of [
    ['1', /found private data in the staged content/u],
    ['2', /private-data scan could not run \(exit 2\)/u],
  ] as const) {
    const at = head();
    const refused = commit(repo, { FAKE_SCAN: code });
    assert.notEqual(refused.exit, 0, `scan exit ${code} refuses the commit`);
    assert.match(refused.stderr, message);
    assert.equal(head(), at, 'nothing was committed');
  }

  rmSync(join(repo, 'scripts/kit/private-data-scan.mjs'));
  const at = head();
  const missing = commit(repo);
  assert.notEqual(missing.exit, 0, 'a missing scan refuses the commit');
  assert.match(missing.stderr, /private-data scan is missing/u);
  assert.equal(head(), at);
});

test("the pre-push hook scans the pushed commits, given git's ref lines, on a push to any remote, and refuses on a finding, a failure or a missing scan", (t) => {
  const { base, repo, scans, reset } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sha = git(repo, 'rev-parse', 'HEAD');
  const refLine = `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`;

  for (const url of [
    'https://github.com/siddak1234/snoopy-automations.git',
    'https://github.com/other/elsewhere.git',
  ]) {
    const clean = push(repo, url, refLine);
    assert.equal(clean.exit, 0, clean.stderr);
    assert.deepEqual(scans(), [{ args: ['--push'], input: refLine }], url);
    reset();

    const found = push(repo, url, refLine, { FAKE_SCAN: '1' });
    assert.equal(found.exit, 1, `a finding refuses a push to ${url}`);
    assert.match(found.stderr, /found private data in the commits being pushed/u);
    reset();
  }
  const broken = push(repo, 'https://github.com/other/elsewhere.git', refLine, { FAKE_SCAN: '2' });
  assert.equal(broken.exit, 1, 'a scan that cannot run never fails open');
  assert.match(broken.stderr, /private-data scan could not run \(exit 2\)/u);

  rmSync(join(repo, 'scripts/kit/private-data-scan.mjs'));
  const missing = push(repo, 'https://github.com/other/elsewhere.git', refLine);
  assert.equal(missing.exit, 1, 'a missing scan refuses the push');
  assert.match(missing.stderr, /private-data scan is missing/u);
});
