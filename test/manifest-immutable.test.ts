import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * A manifest on main is immutable: a change is a new `v<n+1>` file, never an edit
 * (README.md, "Adding an automation"). The platform's Flow CD refuses a served version whose
 * manifest bytes changed (its ADR-0047 §4.2, `manifest_changed`); this test refuses it first,
 * here. Every file under `manifests/` at the base must exist in the tree with the same bytes.
 *
 * The base: `git merge-base origin/main HEAD` on a branch or a pull request, and `HEAD^1` when
 * HEAD is origin/main (a push to main). A checkout without origin/main fails, never passes:
 * CI's Verify job checks out with `fetch-depth: 0`.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();

function base(): string {
  let main: string;
  try {
    main = git('rev-parse', '--verify', '--quiet', 'origin/main^{commit}');
  } catch {
    assert.fail('origin/main is missing: fetch it (CI checks out with fetch-depth: 0)');
  }
  const head = git('rev-parse', 'HEAD');
  return head === main ? git('rev-parse', 'HEAD^1') : git('merge-base', main, head);
}

test('no manifest on main is modified or deleted', () => {
  const from = base();
  const files = git('ls-tree', '-r', '--name-only', from, '--', 'manifests/')
    .split('\n')
    .filter(Boolean);
  assert.ok(files.length > 0, `manifests/ at ${from} holds files`);
  for (const file of files) {
    assert.ok(
      existsSync(join(repositoryRoot, file)),
      `${file} exists at ${from.slice(0, 12)} and is deleted: a registered manifest stays`,
    );
    assert.equal(
      git('hash-object', '--', file),
      git('rev-parse', `${from}:${file}`),
      `${file} differs from ${from.slice(0, 12)}: a change is a new v<n+1> file, never an edit`,
    );
  }
});
