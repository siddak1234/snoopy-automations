import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { MENU_PATH, root, rowsFor, specRows, table, touched } from '../scripts/review-rows.js';

/**
 * CI's review rows (Round 21, R3): each machine-checkable row of `/create-flow`'s review.md, read
 * from a made-up flow, PASS when it holds and FAIL with the reason when it does not. A FAIL row
 * fails Verify (`.github/workflows/ci.yml`, "Review rows").
 */

const scratch = mkdtempSync(join(tmpdir(), 'review-rows-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function flow(files: Record<string, string>): string {
  const base = mkdtempSync(join(scratch, 'repo-'));
  mkdirSync(dirname(join(base, MENU_PATH)), { recursive: true });
  cpSync(join(root, MENU_PATH), join(base, MENU_PATH));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
  return base;
}

const MANIFEST = JSON.stringify({
  templateId: 'sample',
  version: 1,
  requiredCapabilities: ['classification'],
  pipeline: [
    { id: 'receive', kicker: 'TRIGGER' },
    { id: 'read-it', kicker: 'AI STEP' },
  ],
});
const GOOD: Record<string, string> = {
  'manifests/sample.v1.json': MANIFEST,
  'automations/sample/prompts/classify.v1.json': JSON.stringify({ capability: 'classification' }),
  'automations/sample/src/automation.ts':
    "steps: { receive, 'read-it': readIt }; failed('No bill found.'); boundedBlocks(blocks);",
  'automations/sample/test/spec.test.ts':
    "test('§9: a bill', () => {}); test('§9: a page', () => {}); // receive, read-it",
  'automations/sample/test/drill.test.ts': 'await failureDrill(define(manifests), fixture);',
  'automations/sample/README.md':
    '## 8. When it fails\n\n| When | Words |\n| --- | --- |\n| none | No bill found. |\n\n## 9. Test cases\n\n| Input | Gives |\n| --- | --- |\n| a bill | ok |\n| a page | fail |\n',
};

const verdicts = (base: string, changed: string[] = [], isNew = false) =>
  Object.fromEntries(rowsFor(base, 'sample', changed, isNew).map((r) => [r.row, r.verdict]));

test('a flow that meets every row passes each one', () => {
  assert.deepEqual(verdicts(flow(GOOD)), {
    '§3 menu': 'PASS',
    '§4 capabilities': 'PASS',
    '§6 steps': 'PASS',
    '§7 blocks': 'PASS',
    '§8 failure words': 'PASS',
    '§9 tests': 'PASS',
    Drill: 'PASS',
    Paths: 'PASS',
  });
});

test('each row fails on its own departure, naming it', () => {
  const failing = (changes: Record<string, string>, name: string, why: RegExp) => {
    const rows = rowsFor(flow({ ...GOOD, ...changes }), 'sample', [], false);
    const row = rows.find((r) => r.row === name);
    assert.equal(row?.verdict, 'FAIL', `${name}: ${JSON.stringify(rows)}`);
    assert.match(row.note, why);
  };
  failing(
    { 'automations/sample/src/x.ts': "const call = { operation: 'bill.delete' };" },
    '§3 menu',
    /bill\.delete/u,
  );
  failing(
    { 'manifests/sample.v1.json': MANIFEST.replace('"classification"', '"screening"') },
    '§4 capabilities',
    /classification is used, not declared; screening is declared, not used/u,
  );
  failing(
    { 'manifests/sample.v1.json': MANIFEST.replace('"AI STEP"', '"TRIGGER"') },
    '§6 steps',
    /read-it is a second TRIGGER/u,
  );
  failing(
    {
      'automations/sample/test/spec.test.ts': "test('§9: a bill'); test('§9: a page'); // receive",
    },
    '§6 steps',
    /read-it has no test/u,
  );
  failing(
    { 'automations/sample/src/y.ts': 'return { sections: [] };' },
    '§7 blocks',
    /sections or details/u,
  );
  failing(
    { 'automations/sample/src/y.ts': "return failed('Something odd.');" },
    '§8 failure words',
    /"Something odd\." is not in the spec/u,
  );
  failing(
    { 'automations/sample/test/spec.test.ts': "test('§9: a bill'); // receive read-it" },
    '§9 tests',
    /1 tests for 2 rows/u,
  );
  failing({ 'automations/sample/test/drill.test.ts': '' }, 'Drill', /failureDrill/u);
});

test('a new flow’s pull request touches only its folder, its manifest and generated files', () => {
  const base = flow(GOOD);
  const own = [
    'automations/sample/src/a.ts',
    'manifests/sample.v1.json',
    'package-lock.json',
    'docs/MAP.md',
  ];
  assert.equal(verdicts(base, own, true).Paths, 'PASS');
  const rows = rowsFor(base, 'sample', [...own, 'packages/automation-sdk/src/x.ts'], true);
  assert.deepEqual(
    rows.find((r) => r.row === 'Paths'),
    {
      row: 'Paths',
      verdict: 'FAIL',
      note: 'also touches packages/automation-sdk/src/x.ts',
    },
  );
});

test('the live flows are exempt from the new rows; touched flows are read by folder and manifest', () => {
  const rows = rowsFor(root, 'candidate-reviewer', [], false);
  assert.deepEqual(
    rows.filter((r) => r.verdict === 'EXEMPT').map((r) => r.row),
    ['§7 blocks', '§8 failure words', '§9 tests', 'Drill'],
  );
  assert.ok(
    rows.every((r) => r.verdict !== 'FAIL'),
    JSON.stringify(rows),
  );
  assert.deepEqual(
    touched(['automations/a/src/x.ts', 'manifests/b.v2.json', 'README.md', 'manifests/a.v1.json']),
    ['a', 'b'],
  );
  assert.deepEqual(specRows('## 9. Tests\n\n| A | B |\n| - | - |\n| x | y |\n|   |   |\n', 9), [
    '| x | y |',
  ]);
  assert.match(
    table('a', [{ row: '§3', verdict: 'FAIL', note: 'x | y' }]),
    /\| §3 \| FAIL \| x \\\| y \|/u,
  );
});
