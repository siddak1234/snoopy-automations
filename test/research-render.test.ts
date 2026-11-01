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
type Any = any;
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
    integrations: [
      {
        integration: 'integration-1',
        column: 'adoption',
        text: 'most use it',
        cites: ['adoption-1'],
      },
      { integration: 'integration-1', column: 'api', text: 'FHIR R4', cites: ['integration-1-1'] },
      {
        integration: 'integration-1',
        column: 'practice',
        text: 'a | pipe',
        cites: ['integration-1-2'],
      },
    ],
    firstToBuild: [
      {
        integration: 'integration-1',
        text: 'Epic, because most use it',
        cites: ['integration-1-1'],
      },
    ],
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
  integrations: [
    { name: 'Epic', menu: 'epic', menuAt: '' },
    { name: 'QuickBooks', menu: 'quickbooks', menuAt: 'contract/schemas/platform-menu.json:119' },
  ],
  sources: [
    {
      id: 'practice-1',
      tier: 'T2',
      publisher: 'A body',
      url: 'https://example.org/p/1',
      quote: 'a | b',
    },
    {
      id: 'integration-1-2',
      tier: 'T4',
      publisher: 'A forum',
      url: 'https://example.org/f/1',
      quote: 'we sync at night',
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
  assert.match(
    md,
    /## Integrations\n\n\| Integration \| Adoption \| API \/ MCP \|.*\n.*\n\| Epic \| most use it \[adoption-1\] \| FHIR R4 \[integration-1-1\] \|.*\| a \\\| pipe \[integration-1-2\] \| to add \|\n\nFirst to build: Epic, because most use it \[integration-1-1\]\n/u,
  );
  assert.ok(!md.includes('| QuickBooks'), 'a ranked entry with no confirmed adoption line: no row');
  assert.match(md, /## Gaps\n\n.*\n- QuickBooks: ranked by adoption, not confirmed\n/u);
  assert.match(md, /\| integration-1-2 \| T4, community report \| A forum \|/u);
  assert.match(result.out, /integrations 3; first to build: Epic, because most use it;/u);
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

/** Renders `d` through main() in its own folder: research.md and the summary. */
const renderOf = (d: Any) => {
  const at = mkdtempSync(join(dir, 'case-'));
  const json = JSON.stringify(d);
  writeFileSync(join(at, 'research.json'), json);
  const result = call([join(at, 'research.json'), djb2(json), String(json.length)]);
  assert.equal(result.code, 0, result.out);
  return { md: readFileSync(join(at, 'research.md'), 'utf8'), out: result.out };
};

test('an entry whose adoption line fails the gate is no row, though its api line stays', () => {
  // The skeptic found integration-2's adoption cite not_on_page: the line and the finding are gone.
  const { md, out } = renderOf({
    ...data,
    integrations: [data.integrations[0], { name: 'Xero', menu: 'to add', menuAt: '' }],
    brief: {
      ...data.brief,
      integrations: [
        ...data.brief.integrations,
        { integration: 'integration-2', column: 'api', text: 'REST', cites: ['integration-2-1'] },
      ],
      firstToBuild: [
        {
          integration: 'integration-2',
          text: 'Xero, because it is cheap',
          cites: ['integration-2-1'],
        },
      ],
    },
  });
  assert.ok(!md.includes('| Xero'), md);
  assert.match(md, /## Gaps\n\n.*\n- Xero: ranked by adoption, not confirmed\n/u);
  assert.match(md, /\nFirst to build: a person decides\n/u, 'Xero is no row: no first to build');
  assert.match(out, /first to build: a person decides;/u);
  assert.match(
    out,
    /gaps \(2\): practice-2: not_on_page — checked \| Xero: ranked by adoption, not confirmed\n/u,
  );
});

test("the real run's shape: no adoption column, each row's adoption from the findings naming it", () => {
  // Trimmed from the icd10-code-check run (2026-11-01; public sources only): five ranked EHRs, lines
  // keyed integration-1 … integration-5 in the ranking's order, adoption's evidence only as findings.
  const names = ['Epic (incl. Acumen Epic Connect for nephrology)', 'MEDITECH', 'eClinicalWorks'];
  names.push('athenahealth', 'Oracle Health (Cerner)');
  const claims = [
    'Epic is the most-used EHR',
    'MEDITECH ranks second',
    'eClinicalWorks ranks third',
  ];
  claims.push('athenahealth ranks fourth', 'Cerner (Oracle Health) ranks fifth');
  const source = (id: string, claim: string) => ({
    claim,
    id,
    tier: 'T1',
    publisher: 'ONC / ASTP (HHS)',
    url: 'https://healthit.gov/data/data-briefs/office-based-physician-electronic-health-record-adoption-2008-2024/',
    quote: claim,
  });
  const { md } = renderOf({
    ...data,
    integrations: names.map((name) => ({ name, menu: 'to add', menuAt: '' })),
    brief: {
      ...data.brief,
      integrations: names.map((_, k) => ({
        integration: `integration-${k + 1}`,
        column: 'api',
        text: `FHIR R4 ${k + 1}`,
        cites: [`integration-${k + 1}-1`],
      })),
      firstToBuild: [],
    },
    sources: [
      ...claims.map((c, k) => source(`adoption-${k + 1}`, c)),
      source('adoption-6', 'NextGen is outside the top 5'),
      source('adoption-10', 'Acumen runs on Epic as Acumen Epic Connect'),
    ],
  });
  const rows = md
    .split('\n')
    .filter((l) => /^\| (?!Integration \||Id \||---|adoption-|practice-)/u.test(l));
  assert.deepEqual(
    rows.map((l) => l.split(' | ').slice(0, 3)),
    [
      [
        `| ${names[0]}`,
        `${claims[0]} [adoption-1]; Acumen runs on Epic as Acumen Epic Connect [adoption-10]`,
        'FHIR R4 1 [integration-1-1]',
      ],
      ...names
        .slice(1)
        .map((n, k) => [
          `| ${n}`,
          `${claims[k + 1]} [adoption-${k + 2}]`,
          `FHIR R4 ${k + 2} [integration-${k + 2}-1]`,
        ]),
    ],
  );
  assert.ok(!md.includes('ranked by adoption, not confirmed'), md);
});
