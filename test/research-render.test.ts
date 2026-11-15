import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { git, repoCopy } from './flow-research.js';

/**
 * `.claude/skills/create-flow/research-render.mjs` (/create-flow stage 1b): it renders research.md
 * only from a research.json whose djb2 and length match what the workflow returned, so nothing a
 * model retyped after the skeptic reaches the owner. It reads research.json only from a clone's
 * git-ignored `tmp/create-flow/<name>/` and writes research.md beside the spec, in
 * `automations/<name>/` (files only inside a repository copy, BUILD-PLAN 30.17.2); each case's
 * clone is a temp folder made a repository copy (`repoCopy`, test/flow-research.ts).
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
/** A stand-in clone (a repository copy): where research.json is read and research.md written. */
const cloneAt = (clone: string, name = 'invoice-check') => {
  repoCopy(clone);
  const json = join(clone, 'tmp/create-flow', name, 'research.json');
  mkdirSync(dirname(json), { recursive: true });
  return { json, md: join(clone, 'automations', name, 'research.md') };
};

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
const { json: file, md: brief } = cloneAt(dir);
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
  const md = readFileSync(brief, 'utf8');
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
  assert.equal(call([join(dir, 'tmp/create-flow/missing/research.json'), '0', '0']).code, 1);
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

test("research.json only from a clone's tmp/create-flow/<name>/: anywhere else is exit 2, nothing written", () => {
  const ok = call([file, djb2(text), String(text.length)]);
  assert.match(ok.out, /; automations\/invoice-check\/research\.md written/u);
  const bare = mkdtempSync(join(dir, 'bare-')); // no .git: not a repository copy
  const elsewhere = [
    join(dir, 'research.json'), // the run folder's shape before 30.17.2
    join(dir, 'tmp/research.json'),
    join(dir, 'tmp/create-flow/Invoice Check/research.json'),
    join(dir, 'tmp/create-flow/invoice-check/nested/research.json'),
    join(bare, 'tmp/create-flow/invoice-check/research.json'),
  ];
  for (const path of elsewhere) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    const out = call([path, djb2(text), String(text.length)]);
    assert.equal(out.code, 2, path);
    assert.match(out.out, /is not in a clone's tmp\/; usage: /u);
  }
  assert.ok(!existsSync(join(dir, 'research.md')) && !existsSync(join(bare, 'automations')));
});

test('a .git with no origin or not its own work tree, or a symbolic link on the way: exit 2, nothing written', () => {
  const away = mkdtempSync(join(dir, 'away-'));
  const [lone, fake, folder, file] = ['lone-', 'fake-', 'link-', 'link-'].map((p) =>
    mkdtempSync(join(dir, p)),
  ) as [string, string, string, string];
  git(lone, 'init', '-q'); // a work tree with no origin
  mkdirSync(join(fake, '.git')); // no work tree: git finds the one around it, `dir`, with its origin
  cloneAt(folder);
  mkdirSync(join(folder, 'automations'));
  symlinkSync(away, join(folder, 'automations/invoice-check'));
  const { md } = cloneAt(file);
  mkdirSync(dirname(md), { recursive: true });
  symlinkSync(join(away, 'brief.md'), md);
  for (const [clone, why] of [
    [lone, /is not in a clone's tmp\//u],
    [fake, /is not in a clone's tmp\//u],
    [folder, /automations\/invoice-check is a symbolic link; nothing written\n$/u],
    [file, /invoice-check\/research\.md is a symbolic link; nothing written\n$/u],
  ] as const) {
    const json = join(clone, 'tmp/create-flow/invoice-check/research.json');
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(json, text);
    const out = call([json, djb2(text), String(text.length)]);
    assert.equal(out.code, 2, clone);
    assert.match(out.out, why);
  }
  assert.deepEqual(readdirSync(away), []);
  assert.ok(!existsSync(join(lone, 'automations')) && !existsSync(join(fake, 'automations')));
});

test('a flow with a brief tracked beside its spec, or a manifest: research.md beside research.json, never over it', () => {
  for (const kept of ['automations/invoice-check/research.md', 'manifests/invoice-check.v3.json']) {
    const clone = mkdtempSync(join(dir, 'kept-'));
    const { json, md } = cloneAt(clone);
    mkdirSync(dirname(join(clone, kept)), { recursive: true });
    writeFileSync(join(clone, kept), 'approved\n');
    git(clone, 'add', kept);
    writeFileSync(json, text);
    const out = call([json, djb2(text), String(text.length)]);
    assert.equal(out.code, 0, out.out);
    assert.match(
      out.out,
      /; tmp\/create-flow\/invoice-check\/research\.md written \(automations\/invoice-check\/ is kept\)\n/u,
    );
    const beside = readFileSync(join(dirname(json), 'research.md'), 'utf8');
    assert.match(beside, /^# invoice-check: domain brief\n/u);
    assert.equal(existsSync(md) && readFileSync(md, 'utf8'), kept.endsWith('.md') && 'approved\n');
  }
});

/** Renders `d` through main() in its own clone: research.md and the summary. */
const renderOf = (d: Any) => {
  const { json: path, md } = cloneAt(mkdtempSync(join(dir, 'case-')));
  const json = JSON.stringify(d);
  writeFileSync(path, json);
  const result = call([path, djb2(json), String(json.length)]);
  assert.equal(result.code, 0, result.out);
  return { md: readFileSync(md, 'utf8'), out: result.out };
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
    /gaps \(2\): Xero: ranked by adoption, not confirmed \| practice-2: not_on_page — checked\n/u,
  );
});

test('an entry with an adoption finding naming it but no confirmed line is no row; its gap leads the summary', () => {
  // 40 gaps of 60 characters: past the summary's 2,000-character cut.
  const gaps = Array.from(
    { length: 40 },
    (_, k) => `gap ${String(k).padStart(2, '0')}: ${'x'.repeat(52)}`,
  );
  const { md, out } = renderOf({
    ...data,
    integrations: [data.integrations[0], { name: 'Xero', menu: 'to add', menuAt: '' }],
    sources: [
      ...data.sources,
      {
        id: 'adoption-2',
        tier: 'T1',
        publisher: 'A survey',
        url: 'https://example.org/s',
        claim: 'Xero is second',
        quote: '| Xero | 20% |',
      },
    ],
    gaps,
  });
  assert.ok(gaps.join(' | ').length > 2000);
  assert.ok(!/^\| Xero/mu.test(md), md);
  assert.match(md, /\n- Xero: ranked by adoption, not confirmed\n/u);
  assert.ok(out.length <= 2001, String(out.length));
  assert.match(out, /\ngaps \(41\): Xero: ranked by adoption, not confirmed \| gap 00: /u);
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
  const source = (id: string, claim: string, quote = claim) => ({
    claim,
    id,
    tier: 'T1',
    publisher: 'ONC / ASTP (HHS), source 2024 NEHRS',
    url: 'https://healthit.gov/data/data-briefs/office-based-physician-electronic-health-record-adoption-2008-2024/',
    quote,
  });
  // The skeptic dropped each rank ("ranks second" is not in the quote): a cell shows the quote only.
  const shares = ['27.70%', '11.10%', '7.50%', '7.30%', '5.50%'];
  const quotes = ['Epic', 'Meditech', 'eClinicalWorks', 'athenahealth', 'Cerner'].map(
    (n, k) => `| ${n} | Top 5 | ${shares[k]} |`,
  );
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
      ...claims.map((c, k) => source(`adoption-${k + 1}`, c, quotes[k])),
      source('adoption-6', 'NextGen is outside the top 5'),
      source(
        'adoption-10',
        'Acumen runs on Epic as Acumen Epic Connect',
        '150 practices run Acumen Epic',
      ),
      // Not an adoption finding: it names MEDITECH but never fills MEDITECH's Adoption cell.
      source('integration-2-1', 'MEDITECH is used by most hospitals'),
    ],
  });
  const rows = md
    .split('\n')
    .filter((l) => /^\| (?!Integration \||Id \||---|adoption-|practice-|integration-)/u.test(l));
  assert.deepEqual(
    rows.map((l) => l.split(' | ').slice(0, 3)),
    [
      [
        `| ${names[0]}`,
        `27.70% (ONC / ASTP (HHS)) [adoption-1]; "150 practices run Acumen Epic" (ONC / ASTP (HHS)) [adoption-10]`,
        'FHIR R4 1 [integration-1-1]',
      ],
      ...names
        .slice(1)
        .map((n, k) => [
          `| ${n}`,
          `${shares[k + 1]} (ONC / ASTP (HHS)) [adoption-${k + 2}]`,
          `FHIR R4 ${k + 2} [integration-${k + 2}-1]`,
        ]),
    ],
  );
  assert.ok(!md.includes('ranked by adoption, not confirmed'), md);
  assert.ok(!/ranks|most-used|most hospitals/u.test(md.slice(0, md.indexOf('## Sources'))), md);
});
