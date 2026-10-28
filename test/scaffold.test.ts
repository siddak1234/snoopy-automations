import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';

import { filesUnder, menuProblems, rowsFor } from '../scripts/review-rows.js';
import { networkProblems } from './network.js';

/**
 * `npm run scaffold` (Round 21, R2) writes a flow's whole frame from its manifest and its spec:
 * the frame typechecks, its own tests (the §9 todos and the failure drill) pass, it is formatted
 * as the gate checks, it uses only the menu and no network, and a re-run changes nothing. It runs
 * in a scratch copy of the repository's root files, never in the tree.
 */

const repositoryRoot = join(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'scaffold-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const ID = 'sample-flow';
const bin = (name: string) => join(repositoryRoot, 'node_modules', '.bin', name);
/** A child run outside this test runner: `NODE_TEST_CONTEXT` would make its tests report to ours. */
const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** sha256 of every file under the scratch root but node_modules. */
const hashes = () =>
  Object.fromEntries(
    filesUnder(scratch).map((file) => [
      relative(scratch, file),
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    ]),
  );

const SPEC = `# Sample flow: spec

## 9. Test cases

| Input | What the run must give | Source: research ids |
| ----- | ---------------------- | -------------------- |
| a clear bill | its vendor and total | g1 |
| a blank page | "The file can't be read." | g2 |

## 10. Needs the platform first
`;

test('scaffold writes a frame that typechecks, passes its own tests and the gate’s format, and a re-run changes nothing', () => {
  for (const file of ['tsconfig.base.json', 'package-lock.json', '.prettierrc.json']) {
    copyFileSync(join(repositoryRoot, file), join(scratch, file));
  }
  symlinkSync(join(repositoryRoot, 'node_modules'), join(scratch, 'node_modules'));
  mkdirSync(join(scratch, 'contract', 'schemas'), { recursive: true });
  copyFileSync(
    join(repositoryRoot, 'contract', 'schemas', 'platform-menu.json'),
    join(scratch, 'contract', 'schemas', 'platform-menu.json'),
  );
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, 'templates', 'automation', 'example.v1.json'), 'utf8'),
  ) as Record<string, unknown>;
  mkdirSync(join(scratch, 'manifests'));
  writeFileSync(
    join(scratch, 'manifests', `${ID}.v1.json`),
    JSON.stringify({ ...manifest, templateId: ID, requiredConnections: [] }),
  );
  mkdirSync(join(scratch, 'automations', ID), { recursive: true });
  writeFileSync(join(scratch, 'automations', ID, 'README.md'), SPEC);

  const scaffold = join(repositoryRoot, 'scripts', 'scaffold.mjs');
  const first = run(process.execPath, [scaffold, ID, '--root', scratch], scratch);
  const flow = join(scratch, 'automations', ID);
  for (const path of [
    'package.json',
    'package-lock.json',
    'Dockerfile',
    'src/main.ts',
    'src/automation.ts',
    'src/steps/receive.ts',
    'src/steps/extract.ts',
    'src/steps/notify.ts',
    'prompts/document-extraction.v1.json',
    'test/spec.test.ts',
    'test/drill.test.ts',
    'words.md',
  ]) {
    assert.ok(first.includes(`automations/${ID}/${path}`), `${path} was written:\n${first}`);
  }
  assert.ok(!first.includes(`automations/${ID}/README.md`), 'the spec is never overwritten');
  assert.ok(first.includes('package-lock.json\n'), 'the root lock learns the workspace');
  const lock = JSON.parse(readFileSync(join(scratch, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, unknown>;
  };
  assert.deepEqual(lock.packages[`node_modules/@autom8x/${ID}`], {
    resolved: `automations/${ID}`,
    link: true,
  });
  const dockerfile = readFileSync(join(flow, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, new RegExp(`COPY --chown=node:node manifests/${ID}\\.v1\\.json`, 'u'));
  assert.ok(!/example/u.test(dockerfile + readFileSync(join(flow, 'package.json'), 'utf8')));
  const todos = readFileSync(join(flow, 'test', 'spec.test.ts'), 'utf8');
  assert.match(todos, /test\.todo\('§9: a clear bill — its vendor and total'\)/u);
  assert.equal(todos.match(/test\.todo\(/gu)?.length, 2, 'one per §9 row');

  run(bin('tsc'), ['--noEmit', '-p', 'tsconfig.test.json'], flow);
  const tests = run(bin('tsx'), ['--test', 'test/spec.test.ts', 'test/drill.test.ts'], flow);
  assert.match(tests, /# pass 1\n/u, tests);
  assert.match(tests, /# todo 2\n/u, tests);
  assert.match(tests, /# fail 0\n/u, tests);
  run(
    bin('prettier'),
    ['--config', join(scratch, '.prettierrc.json'), '--check', 'src', 'test'],
    flow,
  );
  assert.deepEqual(menuProblems(scratch), []);
  for (const file of filesUnder(join(flow, 'src'))) {
    assert.deepEqual(networkProblems(readFileSync(file, 'utf8')), [], file);
  }
  const rows = Object.fromEntries(
    rowsFor(scratch, ID, [], true).map((row) => [row.row, row.verdict]),
  );
  assert.deepEqual(
    [rows['§3 menu'], rows['§4 capabilities'], rows.Drill, rows['§9 tests']],
    ['PASS', 'PASS', 'PASS', 'FAIL'],
    'the §9 row stays FAIL until each row is a test',
  );

  const before = hashes();
  const again = run(process.execPath, [scaffold, ID, '--root', scratch], scratch);
  assert.match(again, /nothing to write/u);
  assert.deepEqual(hashes(), before, 'a re-run changes nothing');
  // A file the developer edited is never overwritten.
  writeFileSync(join(flow, 'src', 'steps', 'receive.ts'), '// written by the developer\n');
  run(process.execPath, [scaffold, ID, '--root', scratch], scratch);
  assert.equal(
    readFileSync(join(flow, 'src', 'steps', 'receive.ts'), 'utf8'),
    '// written by the developer\n',
  );
});

test('scaffold refuses an id that is not a templateId, and a flow without its manifest', () => {
  const scaffold = join(repositoryRoot, 'scripts', 'scaffold.mjs');
  assert.throws(() => run(process.execPath, [scaffold, 'Bad_Id', '--root', scratch], scratch));
  assert.throws(
    () => run(process.execPath, [scaffold, 'no-manifest', '--root', scratch], scratch),
    /write manifests\/no-manifest\.v1\.json first/u,
  );
});
