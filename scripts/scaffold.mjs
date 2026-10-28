#!/usr/bin/env node
// `npm run scaffold -- <templateId> [--root <dir>]` (Round 21, R2): everything structural about a
// new flow, written from its manifest and its spec, so its developer writes only the steps and the
// prompts. It reads `manifests/<id>.v<n>.json` (the newest; the lane writes it from the approved
// spec, `/create-flow` stage 4) and the spec `automations/<id>/README.md` (§9's rows), and writes
// under `automations/<id>/`:
//   - package.json, package-lock.json, tsconfig.json, tsconfig.test.json, Dockerfile and
//     src/main.ts from `templates/automation/`, `example` replaced by the id (the Dockerfile copies
//     the one manifest version);
//   - src/automation.ts on `defineFlow`, and one typed stub per step id, src/steps/<id>.ts,
//     returning `failed(FLOW_WORDS.not_built)`;
//   - one prompt stub per capability, prompts/<capability>.v1.json;
//   - test/spec.test.ts, one `test.todo` per §9 row (CI's §9 review row stays FAIL until each is a
//     test), and test/drill.test.ts, the SDK's failure drill;
//   - README.md and words.md from `/create-flow`'s templates, when the spec is not there yet;
// and adds the workspace to the root package-lock.json, as npm records one. Every file is written
// only when absent: a re-run never overwrites a file the developer has edited, and changes nothing
// on a tree it already wrote. `test/scaffold.test.ts` holds its output to the gate.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(REPOSITORY, 'templates', 'automation');
const SKILL_TEMPLATES = join(REPOSITORY, '.claude', 'skills', 'create-flow', 'templates');
const ID = /^[a-z][a-z0-9-]*[a-z0-9]$/u;

/** `read-company` → `readCompany`. */
const camel = (id) => id.replace(/-([a-z0-9])/gu, (_m, c) => c.toUpperCase());

/** The newest manifest of `id` under `root/manifests`. */
export function newestManifest(root, id) {
  const directory = join(root, 'manifests');
  const versions = existsSync(directory)
    ? readdirSync(directory)
        .map((name) => new RegExp(`^${id}\\.v([1-9][0-9]*)\\.json$`, 'u').exec(name)?.[1])
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b)
    : [];
  if (versions.length === 0)
    throw new Error(`write manifests/${id}.v1.json first (the spec's sections 1–3, 5–7)`);
  const version = versions.at(-1);
  return JSON.parse(readFileSync(join(directory, `${id}.v${version}.json`), 'utf8'));
}

/** §9's rows of a spec: each row's first two cells, the header and the rule left out. */
export function testRows(spec) {
  const start = spec.search(/^## 9\. /mu);
  if (start < 0) return [];
  const rest = spec.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => /^## /u.test(line));
  return (end < 0 ? rest : rest.slice(0, end))
    .filter((line) => /^\|/u.test(line))
    .slice(2)
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.some((cell) => cell !== ''))
    .map(([input = '', gives = '']) => `${input} — ${gives}`);
}

const quote = (text) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const fromTemplate = (path, id) =>
  readFileSync(join(TEMPLATE, path), 'utf8').replaceAll('example', id);

/** Every file the flow's frame holds, path → text. */
export function frame(root, id) {
  const manifest = newestManifest(root, id);
  const steps = [...manifest.pipeline, ...(manifest.items?.pipeline ?? [])];
  const capabilities = manifest.requiredCapabilities ?? [];
  const specPath = join(root, 'automations', id, 'README.md');
  const spec = existsSync(specPath) ? readFileSync(specPath, 'utf8') : '';
  const files = new Map();
  const pkg = JSON.parse(fromTemplate('package.json', id));
  pkg.description = manifest.display?.description ?? pkg.description;
  files.set('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  files.set('package-lock.json', fromTemplate('package-lock.json', id));
  files.set('tsconfig.json', fromTemplate('tsconfig.json', id));
  files.set('tsconfig.test.json', fromTemplate('tsconfig.test.json', id));
  files.set('src/main.ts', fromTemplate('src/main.ts', id));
  files.set(
    'Dockerfile',
    fromTemplate('Dockerfile', id)
      .replace(/^# Replace `[^`]+` with your templateId everywhere in this file\.\n/mu, '')
      .replaceAll(`manifests/${id}.v1.json`, `manifests/${id}.v${manifest.version}.json`),
  );
  const imports = steps.map((s) => `import { ${camel(s.id)} } from './steps/${s.id}.js';`);
  const entries = steps.map((s) => `    ${/-/u.test(s.id) ? quote(s.id) : s.id}: ${camel(s.id)},`);
  files.set(
    'src/automation.ts',
    [
      "import { fileURLToPath } from 'node:url';",
      '',
      "import { FLOW_WORDS, defineFlow, loadPrompts, type Automation, type Manifest } from '@autom8x/automation-sdk';",
      '',
      ...imports,
      '',
      `/** ${manifest.display?.name ?? id}, on \`defineFlow\`: its spec is README.md beside src/. Written by \`npm run scaffold\`. */`,
      `export const TEMPLATE_ID = ${quote(id)};`,
      '',
      '/** The prompts the steps send: `prompts/*.json` beside `src/`, in the image too. */',
      "export const prompts = loadPrompts(fileURLToPath(new URL('../prompts/', import.meta.url)));",
      '',
      'export function define(manifests: readonly Manifest[]): Automation {',
      '  return defineFlow({',
      '    templateId: TEMPLATE_ID,',
      '    manifests,',
      '    prompts,',
      '    steps: {',
      ...entries,
      '    },',
      "    // What a person reads of a run: the spec's §7, as blocks through `boundedBlocks`.",
      '    result: () => ({ summary: FLOW_WORDS.not_built }),',
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  for (const step of steps) {
    files.set(
      `src/steps/${step.id}.ts`,
      [
        "import { FLOW_WORDS, failed, type Step } from '@autom8x/automation-sdk';",
        '',
        `/** ${step.title ?? step.id}: ${step.description ?? 'the spec’s §6'} Not built yet. */`,
        `export const ${camel(step.id)}: Step = () => Promise.resolve(failed(FLOW_WORDS.not_built, 'not_built'));`,
        '',
      ].join('\n'),
    );
  }
  for (const capability of capabilities) {
    const prompt = {
      id: capability,
      version: 1,
      capability,
      template: `Not built yet: the spec's §4 prompt for ${capability}.`,
      outputSchema: {},
    };
    files.set(`prompts/${capability}.v1.json`, `${JSON.stringify(prompt, null, 2)}\n`);
  }
  if (capabilities.length === 0) files.set('prompts/.gitkeep', '');
  const rows = testRows(spec);
  files.set(
    'test/spec.test.ts',
    [
      "import { test } from 'node:test';",
      '',
      "/** The spec's §9, one test per row: each a `test.todo` until it is written and shown to fail without its code. */",
      ...(rows.length ? rows : ['the spec’s §9 has no row yet']).map(
        (row) => `test.todo(${quote(`§9: ${row}`)});`,
      ),
      '',
    ].join('\n'),
  );
  files.set(
    'test/drill.test.ts',
    [
      "import { existsSync, readFileSync } from 'node:fs';",
      "import { join, resolve } from 'node:path';",
      "import { test } from 'node:test';",
      '',
      "import { readManifests } from '@autom8x/automation-sdk';",
      "import { RecordingPlatform, failureDrill, invokeFixture } from '@autom8x/automation-sdk/testing';",
      '',
      "import { TEMPLATE_ID, define } from '../src/automation.js';",
      '',
      '/** The SDK\'s shared failure drill (README, "Build a flow"): give `platform` what a good run reads. */',
      "const flow = resolve(import.meta.dirname, '..');",
      "const manifests = readManifests(join(flow, '..', '..', 'manifests'), TEMPLATE_ID);",
      "const words = ['README.md', 'words.md']",
      '  .map((name) => join(flow, name))',
      '  .filter((path) => existsSync(path))',
      "  .map((path) => readFileSync(path, 'utf8'))",
      "  .join('\\n');",
      '',
      "test('the failure drill: every failure ends in plain words, and a bad AI answer twice is held', async () => {",
      '  await failureDrill(define(manifests), {',
      `    request: invokeFixture({ templateId: TEMPLATE_ID, templateVersion: ${manifest.version} }),`,
      '    platform: () => new RecordingPlatform(),',
      '    words,',
      '  });',
      '});',
      '',
    ].join('\n'),
  );
  files.set('README.md', readFileSync(join(SKILL_TEMPLATES, 'spec.md'), 'utf8'));
  files.set('words.md', readFileSync(join(SKILL_TEMPLATES, 'words.md'), 'utf8'));
  return files;
}

/** The root lock with the workspace in it, as npm records one; unchanged when it is there. */
export function withWorkspace(lockText, id, pkg) {
  const lock = JSON.parse(lockText);
  const entries = [
    [
      `automations/${id}`,
      {
        name: pkg.name,
        version: pkg.version,
        dependencies: pkg.dependencies,
        devDependencies: pkg.devDependencies,
        engines: pkg.engines,
      },
    ],
    [`node_modules/@autom8x/${id}`, { resolved: `automations/${id}`, link: true }],
  ];
  if (entries.every(([key]) => key in lock.packages)) return lockText;
  const packages = Object.entries(lock.packages);
  for (const [key, value] of entries) {
    if (packages.some(([k]) => k === key)) continue;
    const at = packages.findIndex(([k], index) => index > 0 && k.localeCompare(key, 'en') > 0);
    packages.splice(at < 0 ? packages.length : at, 0, [key, value]);
  }
  lock.packages = Object.fromEntries(packages);
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** Writes the frame under `root`; returns the paths it wrote, none on a re-run. */
export function scaffold(root, id) {
  if (!ID.test(id))
    throw new Error(`"${id}" is not a templateId: lowercase letters, digits and hyphens`);
  const flow = join(root, 'automations', id);
  const written = [];
  for (const [path, text] of frame(root, id)) {
    const target = join(flow, path);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written.push(`automations/${id}/${path}`);
  }
  const lockPath = join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const before = readFileSync(lockPath, 'utf8');
    const pkg = JSON.parse(readFileSync(join(flow, 'package.json'), 'utf8'));
    const after = withWorkspace(before, id, pkg);
    if (after !== before) {
      writeFileSync(lockPath, after);
      written.push('package-lock.json');
    }
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = at < 0 ? REPOSITORY : resolve(args[at + 1]);
  const id = args.find((arg, index) => !arg.startsWith('--') && index !== at + 1);
  if (!id) {
    console.error('usage: npm run scaffold -- <templateId> [--root <dir>]');
    process.exit(2);
  }
  try {
    const written = scaffold(root, id);
    // Formatted as the gate checks it, with this repository's settings, before anyone edits it.
    const prettier = join(REPOSITORY, 'node_modules', '.bin', 'prettier');
    const code = written.filter(
      (path) => /\.(?:ts|json)$/u.test(path) && path !== 'package-lock.json',
    );
    if (code.length && existsSync(prettier)) {
      execFileSync(
        prettier,
        ['--config', join(REPOSITORY, '.prettierrc.json'), '--write', ...code],
        {
          cwd: root,
          stdio: 'ignore',
        },
      );
    }
    console.log(
      written.length ? written.join('\n') : 'scaffold: nothing to write, every file is there',
    );
    if (written.length) console.log('Then: npm run map, npm run facts, npm test.');
  } catch (error) {
    console.error(`scaffold: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
