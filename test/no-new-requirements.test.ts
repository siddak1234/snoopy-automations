import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { base, changeProblems, type History, type Tree } from './definition-files.js';
import { newestManifests, type Json } from './file-required.js';
import { newReasonFor, requirementProblems } from './no-new-requirements.js';

/**
 * No new requirements (`test/no-new-requirements.ts`, whose header says what it does not cover):
 * each flow's newest file against the flow's newest file at the base, and each refusal bitten on
 * made-up manifests.
 */

const root = resolve(import.meta.dirname, '..');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const menu = JSON.parse(
  readFileSync(join(root, 'contract', 'schemas', 'platform-menu.json'), 'utf8'),
) as { providers: { id: string; auth: string }[] };
const PUBLIC = new Set(
  menu.providers.filter((each) => each.auth === 'none').map((each) => each.id),
);
const specOf = (id: string) => {
  const path = join(root, 'automations', id, 'README.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};
const idOf = (file: string) => file.replace(/\.v\d+\.json$/u, '');

test("every flow's newest file asks nothing new of a flow on its newest file at the base", () => {
  const from = base(root);
  const atBase = newestManifests(
    git('ls-tree', '-r', '--name-only', from, '--', 'manifests/')
      .split('\n')
      .filter(Boolean)
      .map((path) => path.slice('manifests/'.length)),
  );
  const newest = newestManifests(readdirSync(join(root, 'manifests')));
  assert.ok(newest.length > 0, 'no manifest found');
  for (const file of newest) {
    const next = JSON.parse(readFileSync(join(root, 'manifests', file), 'utf8')) as Json;
    const before = atBase.find((each) => idOf(each) === idOf(file));
    const previous =
      before === undefined
        ? undefined
        : (JSON.parse(git('show', `${from}:manifests/${before}`)) as Json);
    assert.deepEqual(requirementProblems(next, previous, specOf(idOf(file)), PUBLIC), [], file);
  }
});

test("today's three pairs pass: Resume Screening v4 to v5, Invoice Processing v8 to v9, ICD-10 Code Check v4 to v5", () => {
  // The older files left with BUILD-PLAN 30.15.2; git keeps them at the commit that added v5/v9/v5.
  const at = (file: string) => JSON.parse(git('show', `30d6798:manifests/${file}`)) as Json;
  for (const [id, from, to] of [
    ['candidate-reviewer', 4, 5],
    ['invoice-processing', 8, 9],
    ['icd10-code-check', 4, 5],
  ] as const) {
    const pair = [at(`${id}.v${from}.json`), at(`${id}.v${to}.json`)] as const;
    assert.deepEqual(requirementProblems(pair[1], pair[0], specOf(id), PUBLIC), [], id);
    assert.deepEqual(pair[1].requiredConnections, pair[0].requiredConnections, id);
    assert.deepEqual(pair[1].setup, pair[0].setup, id);
  }
});

/** A made-up flow `fx`: v1 with what is given, v2 with what is given. */
const fx = (version: number, change: Json = {}): Json => ({
  templateId: 'fx',
  version,
  requiredConnections: [],
  setup: [],
  ...change,
});
const conn = (providerId: string, scopes: string[], optional?: boolean) => ({
  providerId,
  scopes,
  ...(optional === undefined ? {} : { optional }),
});
const row = (key: string, last: string) =>
  `| Key | Why |\n| --- | --- |\n| \`${key}\` | ${last} |\n`;
const problems = (previous: Json, next: Json, spec?: string) =>
  requirementProblems(next, previous, spec, new Set(['nppes'])).length;

test('a required connection added is refused, but for a public provider asking no scope', () => {
  const v2 = fx(2, { requiredConnections: [conn('quickbooks', ['accounting'])] });
  assert.equal(problems(fx(1), v2), 1);
  assert.match(
    requirementProblems(v2, fx(1), undefined, new Set())[0]!,
    /quickbooks is a required connection v1 did not require/u,
  );
  assert.equal(
    problems(fx(1), fx(2, { requiredConnections: [conn('quickbooks', [], true)] })),
    0,
    'optional',
  );
  assert.equal(
    problems(fx(1), fx(2, { requiredConnections: [conn('nppes', [])] })),
    0,
    'public, no scope',
  );
  assert.equal(
    problems(fx(1), fx(2, { requiredConnections: [conn('nppes', ['read'])] })),
    1,
    'public, a scope',
  );
  const optional = fx(1, { requiredConnections: [conn('quickbooks', ['accounting'], true)] });
  assert.equal(problems(optional, v2), 1, 'optional before, required now');
  const required = fx(1, { requiredConnections: [conn('quickbooks', ['accounting'])] });
  assert.equal(problems(required, v2), 0, 'required before too');
  assert.equal(problems(fx(1), fx(1)), 0);
  assert.equal(
    requirementProblems(v2, undefined, undefined, new Set()).length,
    0,
    'a first version',
  );
});

test('more scopes are refused; the same or fewer are not', () => {
  const v1 = fx(1, { requiredConnections: [conn('quickbooks', ['a'], true)] });
  const v2 = (scopes: string[]) =>
    fx(2, { requiredConnections: [conn('quickbooks', scopes, true)] });
  assert.equal(problems(v1, v2(['a', 'b'])), 1);
  assert.match(
    requirementProblems(v2(['a', 'b']), v1, undefined, new Set())[0]!,
    /asks b, more than v1 asked/u,
  );
  assert.equal(problems(v1, v2(['a'])), 0);
  assert.equal(problems(v1, v2([])), 0);
  const nppes = (scopes: string[]) => fx(2, { requiredConnections: [conn('nppes', scopes)] });
  assert.equal(problems(fx(1, { requiredConnections: [conn('nppes', [])] }), nppes(['x'])), 1);
});

test('a required setting with no default is refused, unless it was one before', () => {
  const field = (change: Json = {}) => ({ key: 'npi', control: 'text', required: true, ...change });
  const v2 = fx(2, { setup: [field()] });
  assert.equal(problems(fx(1), v2), 1);
  assert.equal(problems(fx(1, { setup: [field({ required: false })] }), v2), 1, 'optional before');
  assert.equal(
    problems(fx(1, { setup: [field({ defaultValue: 'x' })] }), v2),
    1,
    'a default before',
  );
  assert.equal(problems(fx(1, { setup: [field()] }), v2), 0, 'required with no default before');
  assert.equal(problems(fx(1), fx(2, { setup: [field({ defaultValue: null })] })), 0, 'a default');
  assert.equal(problems(fx(1), fx(2, { setup: [field({ required: false })] })), 0, 'not required');
});

test('the reason row lets one through, only for the new version', () => {
  const v2 = fx(2, {
    requiredConnections: [conn('quickbooks', ['accounting'])],
    setup: [{ key: 'npi', control: 'text', required: true }],
  });
  assert.equal(problems(fx(1), v2), 2);
  const both =
    row('quickbooks', 'new in v2: the bills are written there') +
    row('npi', 'New in v2: the registry asks it');
  assert.equal(problems(fx(1), v2, both), 0);
  assert.equal(problems(fx(1), v2, both.replaceAll('v2', 'v1')), 2, "v1's reason, for v2");
  assert.equal(problems(fx(1), v2, row('quickbooks', 'new in v2:')), 2, 'no reason given');
  assert.equal(newReasonFor(row('quickbooks', 'new in v12: x'), 'quickbooks', 1), false);
});

test('two new files of one flow, the older removed, are refused by D8 before any comparison', () => {
  const tree: Tree = {
    manifests: ['fx.v6.json', 'fx.v7.json'],
    flows: ['fx'],
    copies: new Map([['fx', ['fx.v7.json']]]),
    readmes: new Map([['fx', '| v5 | retired 2026-11-14: run 1 |']]),
    tracked: [],
  };
  const history: History = {
    base: new Map([['fx.v5.json', 'b5']]),
    head: new Map([
      ['fx.v6.json', 'b6'],
      ['fx.v7.json', 'b7'],
    ]),
    deletedOnMain: [],
    everOnMain: ['fx.v5.json'],
  };
  assert.deepEqual(
    changeProblems(tree, history).map((each) => each.slice(0, 2)),
    ['D8', 'D8'],
  );
});
