import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * `scripts/audit-doc-references.mjs`: no document here names a file that does not
 * exist. It passes on this repository, and fails on a planted repository whose
 * document names a missing path, while a struck removed file and another
 * repository's path pass.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const audit = (target?: string) =>
  spawnSync(
    process.execPath,
    [join(repositoryRoot, 'scripts/audit-doc-references.mjs'), ...(target ? [target] : [])],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

test('every file path this repository documents name exists', () => {
  const result = audit();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /missing 0$/mu);
});

test('a planted broken path fails the audit; a struck removed file and a sibling path do not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autom8x-doc-references-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=audit',
        '-c',
        'user.email=audit@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  try {
    git('init', '-q');
    write('src/a.ts', 'export {};\n');
    write('src/old.ts', 'export {};\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    rmSync(join(dir, 'src/old.ts'));
    const readme =
      '# planted\n\n`src/a.ts` and [the code](src/a.ts), ~~`src/old.ts`~~ (removed),' +
      ' `snoopy-backend/scripts/add-automation.mjs`.\n';
    write('README.md', readme);
    git('add', '-A');
    git('commit', '-q', '-m', 'two');
    const clean = audit(dir);
    assert.equal(clean.status, 0, clean.stdout);
    assert.match(clean.stdout, /found 2, struck 1, not checked 1, missing 0$/mu);

    write('README.md', `${readme}\nSee \`src/missing.ts\`.\n`);
    const broken = audit(dir);
    assert.equal(broken.status, 1, broken.stdout);
    assert.match(broken.stdout, /^missing\tREADME\.md:5\tsrc\/missing\.ts$/mu);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
