import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * `.claude/skills/create-flow/research-render.mjs` (/create-flow stage 1b): it renders research.md
 * only from a research.json whose djb2 and length match what the workflow returned, so nothing a
 * model retyped after the skeptic reaches the owner.
 */

const script = join(
  resolve(import.meta.dirname, '..'),
  '.claude/skills/create-flow/research-render.mjs',
);
const { main, djb2 } = (await import(pathToFileURL(script).href)) as {
  main: (argv: string[], write: (text: string) => void) => number;
  djb2: (text: string) => string;
};
const dir = mkdtempSync(join(tmpdir(), 'autom8x-research-render-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const data = {
  name: 'invoice-check',
  framing: {
    note: "the owner's words, quoted; not researched",
    job: 'Check each invoice',
    decision: null,
    goodResult: null,
  },
  brief: {
    process: [{ text: 'step one', cites: ['streamlining-1'] }],
    waste: [],
    criteria: [{ text: 'three-way match', cites: ['practice-1'] }],
    rubric: [],
    rules: [],
    vendors: [],
    v1: [],
    failures: [],
    goldenCases: [
      { input: 'invented invoice', expected: 'mismatch on line 2', cites: ['practice-1'] },
    ],
    openQuestions: [
      {
        question: 'Tax rule?',
        kind: 'domain_fact',
        proposedDefault: 'as the statute says',
        cites: ['practice-1'],
        researched: true,
      },
      {
        question: 'Which department?',
        kind: 'our_choice',
        proposedDefault: 'a person decides',
        cites: [],
        proposal: 'Finance',
        researched: false,
      },
    ],
  },
  sources: [
    {
      id: 'practice-1',
      tier: 'T2',
      publisher: 'A body',
      url: 'https://example.org/p/1',
      quote: 'a | b',
    },
  ],
  gaps: ['practice-2: not_on_page — checked'],
  notResearched: [
    'Which department? (our_choice, not researched): a person decides, unless the owner keeps "Finance"',
  ],
  stopped: '',
};
const text = JSON.stringify(data);
const file = join(dir, 'research.json');
const call = (argv: string[]) => {
  let out = '';
  return { code: main(argv, (t) => (out += t)), out };
};

test('a matching file renders research.md and a short summary', () => {
  writeFileSync(file, text);
  const result = call([file, djb2(text), String(text.length)]);
  assert.equal(result.code, 0, result.out);
  assert.ok(result.out.length <= 2001);
  assert.match(result.out, /^research-render: checksum ok/u);
  assert.match(result.out, /not researched: Which department\?/u);
  const md = readFileSync(join(dir, 'research.md'), 'utf8');
  assert.match(md, /^# invoice-check: domain brief\n/u);
  assert.match(md, /- decision: not stated/u);
  assert.match(md, /- three-way match \[practice-1\]/u);
  assert.match(md, /## The rubric\n\n- Unknown: nothing confirmed \(see Gaps\)/u);
  assert.match(md, /- Tax rule\? — default: as the statute says \[practice-1\]/u);
  assert.match(
    md,
    /- Which department\? — default: a person decides \(not researched; proposed "Finance", kept only if the owner says so\)/u,
  );
  assert.match(
    md,
    /\| practice-1 \| T2 \| A body \| https:\/\/example\.org\/p\/1 \| "a \\\| b" \|/u,
  );
});

test('pretty-printing is not a mismatch; a changed word is, and so is a wrong length', () => {
  writeFileSync(file, JSON.stringify(data, null, 2));
  assert.equal(call([file, djb2(text), String(text.length)]).code, 0);
  writeFileSync(file, text.replace('three-way match', 'two-way match'));
  const changed = call([file, djb2(text), String(text.length)]);
  assert.equal(changed.code, 1);
  assert.match(changed.out, /MISMATCH/u);
  writeFileSync(file, text);
  assert.equal(call([file, djb2(text), String(text.length + 1)]).code, 1);
});

test('no file is exit 1, missing arguments exit 2, and the command line runs it', () => {
  assert.equal(call([join(dir, 'missing.json'), '0', '0']).code, 1);
  assert.equal(call([file]).code, 2);
  writeFileSync(file, text);
  const cli = spawnSync(process.execPath, [script, file, djb2(text), String(text.length)], {
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(
    spawnSync(process.execPath, [script, file, 'deadbeef', '1'], { encoding: 'utf8' }).status,
    1,
  );
});
