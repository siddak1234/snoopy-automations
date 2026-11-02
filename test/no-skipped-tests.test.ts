import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * No silent skips (Round 21 hardening, A2): `npm run verify` runs the tests through
 * `scripts/no-skipped-tests.mjs`, which fails when any suite's TAP counts a skipped or todo test
 * above 0, as CI's Verify step reads the whole log (test/workflow-policy.test.ts).
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const script = join(repositoryRoot, 'scripts', 'no-skipped-tests.mjs');
const { unrun } = (await import(pathToFileURL(script).href)) as {
  unrun: (tap: string) => string | undefined;
};

/** The script run on a command that prints `text` and exits with `status`. */
const run = (text: string, status = 0) =>
  spawnSync(
    process.execPath,
    [
      script,
      process.execPath,
      '-e',
      `process.stdout.write(${JSON.stringify(text)}); process.exit(${status})`,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

const clean = '# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';

test('a skipped or todo count above 0 is a test that did not run; 0 of each is none', () => {
  assert.equal(unrun(clean), undefined);
  assert.equal(unrun(clean.replace('# skipped 0', '# skipped 1')), 'skipped 1');
  assert.equal(unrun(clean.replace('# todo 0', '# todo 2')), 'todo 2');
  assert.equal(unrun(`${clean}${clean.replace('# skipped 0', '# skipped 10')}`), 'skipped 10');
  // A test's name or a diagnostic's text is not a count.
  assert.equal(unrun('ok 1 - a skipped step # SKIP\n# skipped 0\n'), undefined);
});

test('the script fails a run that skipped or left a test todo, naming the count, and passes one with none', () => {
  const passed = run(clean);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, clean, 'the output is printed as it comes');

  for (const [count, words] of [
    ['# skipped 1', /a test did not run \(skipped 1\)/u],
    ['# todo 2', /a test did not run \(todo 2\)/u],
  ] as const) {
    const refused = run(clean.replace(count.replace(/[12]$/u, '0'), count));
    assert.equal(refused.status, 1, count);
    assert.match(refused.stderr, words);
  }
  // A red run stays red with its own status.
  assert.equal(run(clean, 3).status, 3);
});

test('npm run verify runs the tests through the script', () => {
  const { scripts } = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const steps = scripts.verify!.split(' && ');
  assert.ok(steps.includes('node scripts/no-skipped-tests.mjs'), scripts.verify);
  assert.ok(!steps.includes('npm test'), 'not npm test unread');
});
