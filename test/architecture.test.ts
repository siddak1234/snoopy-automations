import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

// Named import for ajv, `.default` for ajv-formats: both ship CommonJS with
// `module.exports === exports.default`, and under NodeNext a default import is
// typed as the module namespace. These two forms typecheck and run identically.
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/**
 * The rules that make this repository what it is — enforced, not remembered.
 *
 * An automation is not part of the platform. It is a service the platform calls,
 * which calls back, and the only thing the two share is the wire format in
 * `contract/schemas`. The platform's own `test/architecture.test.ts` proves the
 * boundary from its side (no automation imports a platform package, no platform
 * module imports an automation); this file proves it from here, where the
 * temptation would be to reach for a convenient type.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const automationsRoot = join(repositoryRoot, 'automations');
const packagesRoot = join(repositoryRoot, 'packages');
const manifestsRoot = join(repositoryRoot, 'manifests');
const schemasRoot = join(repositoryRoot, 'contract', 'schemas');

const PLATFORM_SCOPE = '@snoopy/';
const MANIFEST_FILE = /^([a-z][a-z0-9-]*[a-z0-9])\.v([0-9]+)\.json$/u;
/** The standing ceiling on new code. A file that needs more is two files. */
const LINE_CEILING = 400;

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function childDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

/** Every `package.json` that could declare a dependency: the root and each unit. */
function packageFiles(): string[] {
  return [
    join(repositoryRoot, 'package.json'),
    ...[...childDirectories(packagesRoot), ...childDirectories(automationsRoot)].map((directory) =>
      join(directory, 'package.json'),
    ),
  ].filter((path) => existsSync(path));
}

/** Source files on disk, skipping what is installed or built. */
function sourceFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(entry.name)) out.push(path);
  }
  return out;
}

/** What git tracks — the concern for a public repository is what is COMMITTED. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

test('nothing here depends on a platform package', () => {
  const files = packageFiles();
  assert.ok(files.length > 0, 'the root package.json must exist');
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
    for (const block of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]) {
      for (const dependency of Object.keys(block ?? {})) {
        assert.ok(
          !dependency.startsWith(PLATFORM_SCOPE),
          `${relative(repositoryRoot, file)} declares ${dependency}; an automation shares no code with the platform`,
        );
      }
    }
  }
});

test('no source file imports a platform package', () => {
  // Walked on disk rather than read from git, so it holds before the first commit
  // too. A type imported "just for the shape" is exactly how the boundary would
  // stop being one: a third-party automation could not import it either.
  const roots = [packagesRoot, automationsRoot, join(repositoryRoot, 'test')];
  const offenders: string[] = [];
  for (const file of roots.flatMap((root) => sourceFiles(root))) {
    const source = readFileSync(file, 'utf8');
    if (/(?:from|require\()\s*['"]@snoopy\//u.test(source)) {
      offenders.push(relative(repositoryRoot, file));
    }
  }
  assert.deepEqual(offenders, [], 'these files import a platform package');
});

/** The scripts the root gate fans out to. `--if-present` would skip one silently. */
const WORKSPACE_SCRIPTS = ['build', 'typecheck', 'test'];

test('every workspace declares the scripts the gate runs', () => {
  // The root fans out with `--workspaces --if-present` because npm errors on a
  // missing script otherwise — which means a workspace that forgot `test` would
  // pass verify without ever being tested. Presence is required here instead.
  for (const directory of [
    ...childDirectories(packagesRoot),
    ...childDirectories(automationsRoot),
  ]) {
    const file = join(directory, 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> };
    for (const script of WORKSPACE_SCRIPTS) {
      assert.ok(
        typeof manifest.scripts?.[script] === 'string',
        `${relative(repositoryRoot, file)} declares no "${script}" script, so the gate would skip it`,
      );
    }
  }
});

test('the SDK is consumable through its published entries', async () => {
  // Resolved through the package `exports` map to `dist`, exactly as an automation
  // imports it — which the SDK's own suite never does, since it imports `src`. A
  // broken entry would otherwise surface only in the first automation's build.
  // Needs the build to have run: `npm run verify` orders it before this.
  const sdk = (await import('@autom8x/automation-sdk')) as Record<string, unknown>;
  for (const name of ['serve', 'PlatformClient', 'CallbackRefusedError', 'CONTRACT_VERSION']) {
    assert.ok(name in sdk, `@autom8x/automation-sdk exports no ${name} — run npm run build first?`);
  }
  const testing = (await import('@autom8x/automation-sdk/testing')) as Record<string, unknown>;
  for (const name of ['RecordingPlatform', 'invokeFixture', 'declaredSteps']) {
    assert.ok(name in testing, `@autom8x/automation-sdk/testing exports no ${name}`);
  }
});

test('every automation is a complete unit', () => {
  const automations = childDirectories(automationsRoot);
  if (existsSync(automationsRoot)) {
    assert.ok(automations.length > 0, 'automations/ exists but holds no automation');
  }
  const manifestNames = existsSync(manifestsRoot) ? readdirSync(manifestsRoot) : [];
  for (const directory of automations) {
    const name = basename(directory);
    for (const required of ['package.json', 'Dockerfile', 'src/main.ts']) {
      assert.ok(
        existsSync(join(directory, required)),
        `automations/${name} lacks ${required} — an automation builds and ships on its own`,
      );
    }
    assert.ok(
      manifestNames.some((file) => {
        const match = MANIFEST_FILE.exec(file);
        return match?.[1] === name;
      }),
      `automations/${name} has no manifests/${name}.v<n>.json — an automation nobody can register is not one`,
    );
  }
});

/**
 * The manifest schema as the platform applies it.
 *
 * The emitted schema admits `https` origins only. The platform's own
 * `validateManifest` also admits plain `http` on a `*.internal` host — ICANN
 * reserved the label in 2024 and it will never be delegated, so the name cannot
 * resolve outside a private network — and every shipped manifest is written that
 * way. Applied here as the platform applies it; the disagreement between the
 * schema and the validator is filed with the platform, not papered over silently.
 */
function manifestSchemaAsThePlatformAppliesIt(): Record<string, unknown> {
  const schema = JSON.parse(
    readFileSync(join(schemasRoot, 'automation-manifest.json'), 'utf8'),
  ) as { properties: { service: { properties: { origin: { pattern: string } } } } };
  schema.properties.service.properties.origin.pattern =
    '^(https://[^/?#@]+|http://[^/?#@:]+\\.internal(:[0-9]{1,5})?)$';
  return schema as unknown as Record<string, unknown>;
}

test('every manifest validates against the vendored schema and names an automation here', () => {
  if (!existsSync(manifestsRoot)) return;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats.default(ajv);
  const validate = ajv.compile(manifestSchemaAsThePlatformAppliesIt());
  const automationNames = new Set(childDirectories(automationsRoot).map((d) => basename(d)));

  const files = readdirSync(manifestsRoot).filter((file) => file.endsWith('.json'));
  assert.ok(files.length > 0, 'manifests/ exists but holds no manifest');
  for (const file of files) {
    const match = MANIFEST_FILE.exec(file);
    assert.ok(match, `manifests/${file} must be named <templateId>.v<n>.json`);
    const parsed: unknown = JSON.parse(readFileSync(join(manifestsRoot, file), 'utf8'));
    assert.ok(
      validate(parsed),
      `manifests/${file} is not a valid manifest — ${ajv.errorsText(validate.errors)}`,
    );
    // The filename is an index into the catalog: the reviewed file and the
    // registered row must agree about what was approved.
    const manifest = parsed as { templateId: string; version: number };
    assert.equal(manifest.templateId, match[1], `manifests/${file} declares another templateId`);
    assert.equal(manifest.version, Number(match[2]), `manifests/${file} declares another version`);
    assert.ok(
      automationNames.has(manifest.templateId),
      `manifests/${file} names ${manifest.templateId}, and automations/${manifest.templateId} does not exist`,
    );
  }
});

test('no environment file and no recovered client data is tracked', () => {
  // This repository is public. Push protection catches provider-shaped secrets;
  // this catches the two paths that would carry one without matching any pattern.
  const tracked = trackedFiles();
  const environmentFiles = tracked.filter((path) => /(^|\/)\.env(\.|$)/u.test(path));
  assert.deepEqual(environmentFiles, [], 'an environment file is tracked');
  const salvage = tracked.filter((path) => path.toLowerCase().includes('_salvage'));
  assert.deepEqual(salvage, [], 'a _salvage path is tracked — recovered client data');
});

test('source files stay under the line ceiling', () => {
  const roots = [packagesRoot, automationsRoot, join(repositoryRoot, 'test')];
  const over: string[] = [];
  for (const file of roots.flatMap((root) => sourceFiles(root))) {
    const lines = readFileSync(file, 'utf8').split('\n').length;
    if (lines > LINE_CEILING) over.push(`${relative(repositoryRoot, file)} (${lines})`);
  }
  assert.deepEqual(over, [], `over ${LINE_CEILING} lines — split the file`);
});
