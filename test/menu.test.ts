import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import {
  MENU_PATH,
  filesUnder,
  menuProblems,
  operationLiterals,
  readMenu,
  root,
} from '../scripts/review-rows.js';

/**
 * A flow uses only what the menu offers (Round 21, B2.4): every manifest's provider is a menu
 * provider (`contract/schemas/platform-menu.json`, vendored from the platform), and every
 * `operation: '<x>'` literal under `automations/*\/src` and `packages/automation-kit/src` is an
 * operation of a provider the flow (or the kit file) declares. Today an unknown operation is
 * found only at run time, a 400 `unknown_operation` from Connections.
 */

const scratch = mkdtempSync(join(tmpdir(), 'menu-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('every flow and the kit use only what the menu offers', () => {
  assert.deepEqual(menuProblems(), []);
  const literals = [
    ...filesUnder(join(root, 'automations')),
    ...filesUnder(join(root, 'packages', 'automation-kit', 'src')),
  ]
    .filter((file) => /\/src\/.*\.ts$/u.test(file))
    .flatMap((file) => operationLiterals(readFileSafe(file)).map((found) => found.operation));
  assert.deepEqual([...new Set(literals)].sort(), [
    'bill.create',
    'companyInfo.get',
    'journalEntry.create',
    'preferences.get',
    'purchase.create',
    'query.run',
    'vendor.create',
    'vendorCredit.create',
  ]);
});

test('a made-up operation, a provider the menu lacks, and an operation of an undeclared provider fail', () => {
  const base = join(scratch, 'repo');
  mkdirSync(dirname(join(base, MENU_PATH)), { recursive: true });
  cpSync(join(root, MENU_PATH), join(base, MENU_PATH));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  };
  write(
    'manifests/sample.v1.json',
    JSON.stringify({
      templateId: 'sample',
      version: 1,
      requiredConnections: [{ providerId: 'quickbooks' }],
    }),
  );
  write('automations/sample/src/a.ts', "const call = { operation: 'bill.create' };\n");
  assert.deepEqual(menuProblems(base), []);
  write('automations/sample/src/a.ts', "const call = { operation: 'bill.delete' };\n");
  assert.deepEqual(menuProblems(base), [
    'automations/sample/src/a.ts:1: bill.delete is not an operation of quickbooks in the menu',
  ]);
  write(
    'automations/sample/src/a.ts',
    "type Op = { operation: 'messages.send' | 'bill.create' };\n",
  );
  assert.equal(menuProblems(base).length, 1, 'google is not declared by this flow');
  write(
    'manifests/sample.v1.json',
    JSON.stringify({
      templateId: 'sample',
      version: 1,
      requiredConnections: [{ providerId: 'made-up' }],
    }),
  );
  assert.ok(
    menuProblems(base).includes('manifests/sample.v1.json: made-up is not in the menu'),
    menuProblems(base).join('\n'),
  );
  assert.ok(readMenu(base).providers.length > 0);
});

test('the literal scan reads a type union and skips an index', () => {
  assert.deepEqual(
    operationLiterals(
      "  readonly operation: 'a.b' | \"c.d\";\n  readonly operation: Plan['operation'];",
    ),
    [
      { line: 1, operation: 'a.b' },
      { line: 1, operation: 'c.d' },
    ],
  );
});

function readFileSafe(path: string): string {
  return readFileSync(path, 'utf8');
}
