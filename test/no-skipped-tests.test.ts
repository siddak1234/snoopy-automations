import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * No silent skips (Round 21 hardening, A2): `npm run verify` runs the tests through
 * `scripts/no-skipped-tests.mjs`, which fails when any suite's TAP counts a skipped or todo test
 * above 0, as CI's Verify step reads the whole log (test/workflow-policy.test.ts), and when the
 * output holds no TAP summary at all: every `tsx --test` script names the TAP reporter.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const script = join(repositoryRoot, 'scripts', 'no-skipped-tests.mjs');
const { summarized, unrun } = (await import(pathToFileURL(script).href)) as {
  summarized: (output: string) => boolean;
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

/** The same run as `clean`, as Node's spec reporter prints it, with one test skipped. */
const spec = 'ℹ tests 4\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n';

test('spec output is refused, a skip in it included: it holds no TAP summary to read', () => {
  assert.equal(summarized(clean), true);
  assert.equal(summarized(spec), false);
  const refused = run(spec);
  assert.equal(refused.status, 1, 'ℹ skipped 1 is not read as clean');
  assert.match(refused.stderr, /no TAP summary \(`# tests N`\)/u);
});

test('output with no summary at all is refused: a run whose counts cannot be read is no proof', () => {
  for (const text of ['', 'ok 1 - a test\n1..1\n', '# pass 1\n# skipped 0\n# todo 0\n']) {
    assert.equal(summarized(text), false, JSON.stringify(text));
    const refused = run(text);
    assert.equal(refused.status, 1, JSON.stringify(text));
    assert.match(refused.stderr, /no TAP summary/u);
  }
});

test('every `tsx --test` script names the TAP reporter, the root’s, each workspace’s and the template’s', () => {
  const manifests = [
    'package.json',
    ...['packages', 'automations'].flatMap((folder) =>
      readdirSync(join(repositoryRoot, folder), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${folder}/${entry.name}/package.json`),
    ),
    'templates/automation/package.json',
  ];
  let runs = 0;
  for (const manifest of manifests) {
    const { scripts = {} } = JSON.parse(readFileSync(join(repositoryRoot, manifest), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const [name, command] of Object.entries(scripts)) {
      for (const at of command.matchAll(/tsx --test\b(\S*)( \S+)?/gu)) {
        runs += 1;
        assert.equal(at[1], '', `${manifest} ${name}: ${command}`);
        assert.equal(at[2], ' --test-reporter=tap', `${manifest} ${name}: ${command}`);
      }
    }
  }
  assert.ok(runs >= manifests.length, `${runs} tsx --test runs in ${manifests.length} manifests`);
});

test('npm run verify runs the tests through the script', () => {
  const { scripts } = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const steps = scripts.verify!.split(' && ');
  assert.ok(steps.includes('node scripts/no-skipped-tests.mjs'), scripts.verify);
  assert.ok(!steps.includes('npm test'), 'not npm test unread');
});
