import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { FACTS_PATH, repoFacts, type RepoFacts } from '../scripts/repo-facts.js';

/**
 * The committed facts file is a claim the platform repository quotes as data
 * (its SYSTEM-MANIFEST §10a), so it is held to the tree it sits in: the shape the
 * platform's `docs/repo-facts.schema.json` requires, and counts equal to what the
 * recorded commands produce now. `head` and `readAt` are the emission's and are
 * not compared.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');

test('docs/repo-facts/snoopy-automations.json has the schema shape and a command beside every count', () => {
  const facts = JSON.parse(readFileSync(join(repositoryRoot, FACTS_PATH), 'utf8')) as RepoFacts;
  assert.equal(facts.schemaVersion, 1);
  assert.equal(facts.repository, 'snoopy-automations');
  assert.match(facts.head, /^[0-9a-f]{7,40}$/u);
  assert.match(facts.readAt, /^\d{4}-\d{2}-\d{2}$/u);
  // `gate` is written by `npm run verify`'s last step and absent from a file
  // `npm run facts` emitted on a tree the gate has not run on yet; the platform
  // marks a gate-less file UNVERIFIED, so the committed copy should carry it.
  const allowed = ['counts', 'gate', 'head', 'readAt', 'repository', 'schemaVersion'];
  for (const key of Object.keys(facts)) {
    assert.ok(allowed.includes(key), `${key} is not a field the schema declares`);
  }
  if ('gate' in facts) assert.equal(facts.gate, 'verify');
  assert.ok(Object.keys(facts.counts).length > 0);
  for (const [unit, count] of Object.entries(facts.counts)) {
    assert.ok(Number.isInteger(count.value) && count.value >= 0, unit);
    assert.ok(
      typeof count.command === 'string' && count.command.length > 0,
      `${unit} has no command`,
    );
  }
});

test('the committed counts are the counts of this tree', () => {
  const committed = JSON.parse(readFileSync(join(repositoryRoot, FACTS_PATH), 'utf8')) as RepoFacts;
  const live = repoFacts();
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(committed.counts).map(([unit, count]) => [unit, count.value]),
    ),
    Object.fromEntries(Object.entries(live.counts).map(([unit, count]) => [unit, count.value])),
    `${FACTS_PATH} is stale: run \`npm run facts\`, then \`npm run verify\` (which re-emits it with the gate claim), and commit the file`,
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(committed.counts).map(([unit, count]) => [unit, count.command]),
    ),
    Object.fromEntries(Object.entries(live.counts).map(([unit, count]) => [unit, count.command])),
    'the recorded commands are the ones the script runs',
  );
});
