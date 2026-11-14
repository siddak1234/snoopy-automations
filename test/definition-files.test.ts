import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  base,
  changeProblems,
  imageManifests,
  retiredRow,
  treeProblems,
  type History,
  type Tree,
} from './definition-files.js';

/**
 * The definition-file standard, D2–D8 (`test/definition-files.ts`, whose header says what it
 * cannot see), on this tree against its base (`base`, there), and each rule bitten on a scratch
 * tree.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
const lines = (text: string) => text.split('\n').filter(Boolean);

/** This repository as the rules read it. */
function repositoryTree(): Tree {
  const flows = readdirSync(join(repositoryRoot, 'automations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const text = (...path: string[]) => {
    const file = join(repositoryRoot, ...path);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  return {
    manifests: readdirSync(join(repositoryRoot, 'manifests')).filter((name) =>
      name.endsWith('.json'),
    ),
    flows,
    copies: new Map(flows.map((id) => [id, imageManifests(text('automations', id, 'Dockerfile'))])),
    readmes: new Map([
      ['', text('README.md')],
      ...flows.map((id) => [id, text('automations', id, 'README.md')] as const),
    ]),
    tracked: lines(git('ls-files')),
  };
}

/** This tree against its base, and what main ever held. */
function repositoryHistory(tree: Tree): History {
  const from = base(repositoryRoot);
  const baseFiles = new Map(
    lines(git('ls-tree', '-r', from, '--', 'manifests/')).map((line) => {
      const [meta, path] = line.split('\t') as [string, string];
      return [path.slice('manifests/'.length), meta.split(' ')[2]!] as const;
    }),
  );
  const blobs = lines(
    git('hash-object', '--', ...tree.manifests.map((name) => `manifests/${name}`)),
  );
  const names = (text: string) =>
    lines(text)
      .filter((path) => path.startsWith('manifests/'))
      .map((path) => path.slice('manifests/'.length));
  return {
    base: baseFiles,
    head: new Map(tree.manifests.map((name, index) => [name, blobs[index]!])),
    deletedOnMain: names(
      git('log', '--diff-filter=D', '--name-only', '--format=', 'origin/main', '--', 'manifests/'),
    ),
    everOnMain: names(git('log', '--name-only', '--format=', from, '--', 'manifests/')),
  };
}

test('this tree keeps the standard, against its base', () => {
  const tree = repositoryTree();
  assert.ok(tree.manifests.length > 0, 'manifests/ holds files');
  assert.deepEqual(treeProblems(tree), []);
  assert.deepEqual(changeProblems(tree, repositoryHistory(tree)), []);
});

/** A scratch repository: flow `fx` at v2 and v3, its Dockerfile copying v3. */
const scratch = (change: Partial<Tree> = {}): Tree => ({
  manifests: ['fx.v2.json', 'fx.v3.json'],
  flows: ['fx'],
  copies: new Map([['fx', ['fx.v3.json']]]),
  readmes: new Map([
    ['', ''],
    ['fx', ''],
  ]),
  tracked: ['manifests/fx.v2.json', 'manifests/fx.v3.json', 'automations/fx/README.md'],
  ...change,
});
const blobs = (...names: string[]) => new Map(names.map((name) => [name, `blob-${name}`]));
const history = (change: Partial<History> = {}): History => ({
  base: blobs('fx.v2.json', 'fx.v3.json'),
  head: blobs('fx.v2.json', 'fx.v3.json'),
  deletedOnMain: ['fx.v1.json'],
  everOnMain: ['fx.v1.json', 'fx.v2.json', 'fx.v3.json'],
  ...change,
});
const rules = (problems: string[]) => problems.map((problem) => problem.slice(0, 2));
const retired = (version: number) =>
  `| Version | State |\n| --- | --- |\n| v${version} | retired 2026-11-14: Flow CD run 1 |\n`;

test('the scratch repository keeps the standard', () => {
  assert.deepEqual(treeProblems(scratch()), []);
  assert.deepEqual(changeProblems(scratch(), history()), []);
});

test('D2: the newest file is the one the Dockerfile copies; a newer one is a stray', () => {
  const stray = scratch({ manifests: ['fx.v3.json', 'fx.v4.json'] });
  assert.deepEqual(rules(treeProblems(stray)), ['D2']);
  assert.match(treeProblems(stray)[0]!, /fx\.v4\.json is fx's newest file/u);
  assert.deepEqual(rules(treeProblems(scratch({ copies: new Map() }))), ['D2'], 'copies none');
  const two = new Map([['fx', ['fx.v2.json', 'fx.v3.json']]]);
  assert.deepEqual(rules(treeProblems(scratch({ copies: two }))), ['D2'], 'copies two');
});

test('D3: at most two files a flow', () => {
  const three = scratch({ manifests: ['fx.v1.json', 'fx.v2.json', 'fx.v3.json'] });
  assert.deepEqual(rules(treeProblems(three)), ['D3']);
});

test('D4: a file at the base keeps its bytes', () => {
  const edited = history({ head: new Map([...blobs('fx.v2.json'), ['fx.v3.json', 'other']]) });
  assert.deepEqual(rules(changeProblems(scratch(), edited)), ['D4']);
});

test('D5: a file leaves only below a newer one, or with its flow, and with its retired row', () => {
  const tree = (readme: string, manifests = ['fx.v3.json']) =>
    scratch({ manifests, readmes: new Map([['fx', readme]]) });
  const deleted = (head: string[]) => history({ head: blobs(...head) });
  assert.deepEqual(changeProblems(tree(retired(2)), deleted(['fx.v3.json'])), []);
  assert.deepEqual(rules(changeProblems(tree(''), deleted(['fx.v3.json']))), ['D5'], 'no row');
  for (const readme of [
    retired(3),
    retired(2).replace('retired 2026-11-14:', 'retired:'),
    retired(2).replace('2026-11-14', '2026-13-40'),
    retired(2).replace(': Flow CD run 1', ':'),
    retired(2).replace('retired', 'served'),
  ]) {
    assert.deepEqual(rules(changeProblems(tree(readme), deleted(['fx.v3.json']))), ['D5'], readme);
  }
  // The newest deleted, the older kept: no newer file replaces it.
  const newest = changeProblems(tree(retired(3), ['fx.v2.json']), deleted(['fx.v2.json']));
  assert.deepEqual(rules(newest), ['D5']);
  assert.match(newest[0]!, /no newer fx file/u);
  // A flow retired whole: its folder gone, its row in the root README as `<id> v<n>`.
  const whole = (root: string) =>
    scratch({ manifests: [], flows: [], copies: new Map(), readmes: new Map([['', root]]) });
  const both = (root: string) => changeProblems(whole(root), deleted([]));
  assert.deepEqual(both(retired(2).replace('v2', 'fx v2') + retired(3).replace('v3', 'fx v3')), []);
  assert.deepEqual(rules(both(retired(2).replace('v2', 'fx v2'))), ['D5']);
  assert.equal(
    retiredRow('| `v2` | x | retired 2026-11-14: run 9 |', 'v2'),
    'retired 2026-11-14: run 9',
  );
});

test('D6: a deleted name never comes back, and a new version is above every one main held', () => {
  const back = scratch({
    manifests: ['fx.v1.json', 'fx.v3.json'],
    copies: new Map([['fx', ['fx.v1.json']]]),
  });
  const readded = history({ base: blobs('fx.v3.json'), head: blobs('fx.v1.json', 'fx.v3.json') });
  assert.deepEqual(rules(changeProblems(back, readded)), ['D6', 'D6']);
  // A lower version, never deleted, never on main: below v3, so refused.
  const lower = history({
    base: blobs('fx.v3.json'),
    head: blobs('fx.v3.json', 'fx.v2.json'),
    deletedOnMain: [],
    everOnMain: ['fx.v3.json'],
  });
  assert.deepEqual(rules(changeProblems(scratch(), lower)), ['D6', 'D8']);
  // The next version: taken.
  const next = scratch({
    manifests: ['fx.v3.json', 'fx.v4.json'],
    copies: new Map([['fx', ['fx.v4.json']]]),
  });
  const added = history({ base: blobs('fx.v3.json'), head: blobs('fx.v3.json', 'fx.v4.json') });
  assert.deepEqual(changeProblems(next, added), []);
});

test('D7: no copy of a definition file outside manifests/', () => {
  const copy = scratch({ tracked: [...scratch().tracked, 'automations/fx/test/fx.v3.json'] });
  assert.deepEqual(rules(treeProblems(copy)), ['D7']);
  const other = scratch({ tracked: [...scratch().tracked, 'automations/fx/prompts/read.v1.json'] });
  assert.deepEqual(treeProblems(other), [], 'a prompt, not a flow, keeps its name');
});

test("D8: one added file a flow, and it is the Dockerfile's", () => {
  const four = (copied: string) =>
    scratch({
      manifests: ['fx.v3.json', 'fx.v4.json', 'fx.v5.json'],
      copies: new Map([['fx', [copied]]]),
    });
  const two = history({
    base: blobs('fx.v3.json'),
    head: blobs('fx.v3.json', 'fx.v4.json', 'fx.v5.json'),
  });
  assert.deepEqual(rules(changeProblems(four('fx.v5.json'), two)), ['D8', 'D8']);
  const notCopied = scratch({ manifests: ['fx.v3.json', 'fx.v4.json'] });
  const one = history({ base: blobs('fx.v3.json'), head: blobs('fx.v3.json', 'fx.v4.json') });
  assert.deepEqual(rules(changeProblems(notCopied, one)), ['D8']);
});

test('imageManifests reads the COPY lines alone', () => {
  assert.deepEqual(
    imageManifests(
      'FROM node\n# manifests/fx.v1.json\nCOPY --chown=node:node manifests/fx.v3.json ./manifests/\n',
    ),
    ['fx.v3.json'],
  );
});
