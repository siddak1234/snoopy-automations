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
const templatesRoot = join(repositoryRoot, 'templates');

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
  const roots = [packagesRoot, automationsRoot, templatesRoot, join(repositoryRoot, 'test')];
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

test('the SDK and the kit are consumable through their published entries', async () => {
  // Resolved through the package `exports` map to `dist`, exactly as an automation
  // imports it — which a package's own suite never does, since it imports `src`. A
  // broken entry would otherwise surface only in the first automation's build.
  // Needs the build to have run: `npm run verify` orders it before this.
  const sdk = (await import('@autom8x/automation-sdk')) as Record<string, unknown>;
  for (const name of [
    'serve',
    'PlatformClient',
    'CallbackRefusedError',
    'CONTRACT_VERSION',
    'defineAutomation',
    'definePrompt',
    'held',
    'readManifests',
  ]) {
    assert.ok(name in sdk, `@autom8x/automation-sdk exports no ${name} — run npm run build first?`);
  }
  const testing = (await import('@autom8x/automation-sdk/testing')) as Record<string, unknown>;
  for (const name of ['RecordingPlatform', 'invokeFixture', 'declaredSteps']) {
    assert.ok(name in testing, `@autom8x/automation-sdk/testing exports no ${name}`);
  }
  const quickbooks = (await import('@autom8x/automation-kit/quickbooks')) as Record<
    string,
    unknown
  >;
  for (const name of ['readQuickBooks', 'lookupQuery', 'queryRowsOf', 'QUICKBOOKS_SENTENCES']) {
    assert.ok(name in quickbooks, `@autom8x/automation-kit/quickbooks exports no ${name}`);
  }
  const kitTesting = (await import('@autom8x/automation-kit/testing')) as Record<string, unknown>;
  for (const name of ['QuickBooksSimulator', 'PROVIDER_REFUSALS', 'sampleAccount']) {
    assert.ok(name in kitTesting, `@autom8x/automation-kit/testing exports no ${name}`);
  }
});

/**
 * The modules built JavaScript imports: its `import` and `export … from` statements,
 * which the compiler writes at the start of a line, and any dynamic `import()`. Read
 * by statement, so a string that happens to end in "from" is not taken for one.
 */
function importedModules(source: string): string[] {
  const statements = /^\s*(?:import|export)\s+(?:[\w$*{},\s]+?\s+from\s*)?['"]([^'"]+)['"]/gmu;
  const dynamic = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu;
  return [...source.matchAll(statements), ...source.matchAll(dynamic)].map((match) => match[1]!);
}

/** What a package under `packages/` declares about how it ships. */
interface LibraryJson extends PackageJson {
  files?: unknown;
  exports?: Record<string, Record<string, string>>;
}

test('every package under packages/ ships its built dist alone, and runs on Node built-ins alone', () => {
  // Each is packed into every image that depends on it (`--install-links`), so what
  // ships is `dist`; a runtime dependency would ride into every one of those images
  // unaudited (rule 8). What runs is the build, so the build is what is read:
  // every module its JavaScript imports is a Node built-in or one of its own files —
  // a type of the SDK's is imported as a type, and is gone.
  const libraries = childDirectories(packagesRoot);
  assert.ok(libraries.length > 0, 'packages/ holds no package');
  for (const directory of libraries) {
    const label = relative(repositoryRoot, directory);
    const manifest = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    ) as LibraryJson;
    assert.deepEqual(manifest.files, ['dist'], `${label} must ship dist alone`);
    for (const [entry, targets] of Object.entries(manifest.exports ?? {})) {
      for (const target of Object.values(targets)) {
        assert.ok(target.startsWith('./dist/'), `${label} exports ${entry} from ${target}`);
      }
    }
    for (const block of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      assert.deepEqual(Object.keys(manifest[block] ?? {}), [], `${label} declares ${block}`);
    }
    const built = sourceFiles(join(directory, 'dist')).filter((file) => file.endsWith('.js'));
    assert.ok(built.length > 0, `${label}/dist holds no JavaScript — run npm run build first?`);
    for (const file of built) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        assert.ok(
          specifier.startsWith('node:') ||
            specifier.startsWith('./') ||
            specifier.startsWith('../'),
          `${relative(repositoryRoot, file)} imports ${specifier} at run time`,
        );
      }
    }
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
    for (const required of ['package.json', 'package-lock.json', 'Dockerfile', 'src/main.ts']) {
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

test('every automation lockfile pins each local package it uses, and its image packs each one', () => {
  for (const directory of childDirectories(automationsRoot)) {
    const packageManifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8')) as {
      name?: string;
      version?: string;
      lockfileVersion?: number;
      packages?: Record<string, { resolved?: string }>;
    };

    assert.equal(
      lock.name,
      packageManifest.name,
      `${basename(directory)} lock names another package`,
    );
    assert.equal(
      lock.version,
      packageManifest.version,
      `${basename(directory)} lock has another version`,
    );
    assert.equal(
      lock.lockfileVersion,
      3,
      `${basename(directory)} lock is not npm's current format`,
    );
    assert.equal(
      packageManifest.dependencies?.['@autom8x/automation-sdk'],
      'file:../../packages/automation-sdk',
      `${basename(directory)} must consume the local SDK as its platform boundary`,
    );
    // Every local package — the SDK, and any library it builds with — pinned in its
    // own lock and packed by its own image: its manifest and built dist copied out of
    // the build stage, then installed as files, not linked.
    const dockerfile = readFileSync(join(directory, 'Dockerfile'), 'utf8');
    assert.match(
      dockerfile,
      /npm ci --omit=dev --ignore-scripts --workspaces=false --install-links=true/u,
      `${basename(directory)}/Dockerfile does not pack its local packages`,
    );
    for (const [dependency, range] of Object.entries(packageManifest.dependencies ?? {})) {
      if (!range.startsWith('file:')) continue;
      assert.equal(
        lock.packages?.[`node_modules/${dependency}`]?.resolved,
        range,
        `${basename(directory)} lock does not pin ${dependency} at ${range}`,
      );
      const local = relative(repositoryRoot, resolve(directory, range.slice('file:'.length)));
      for (const part of ['package.json', 'dist']) {
        assert.ok(
          dockerfile.includes(`COPY --from=build /workspace/${local}/${part} ./${local}/${part}`),
          `${basename(directory)}/Dockerfile does not pack ${local}/${part}`,
        );
      }
    }
  }
});

test('every manifest validates against the vendored schema and names an automation here', () => {
  if (!existsSync(manifestsRoot)) return;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats.default(ajv);
  const schema = JSON.parse(
    readFileSync(join(schemasRoot, 'automation-manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  const validate = ajv.compile(schema);
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
  const roots = [
    packagesRoot,
    automationsRoot,
    templatesRoot,
    join(repositoryRoot, 'scripts'),
    join(repositoryRoot, 'test'),
  ];
  const over: string[] = [];
  for (const file of roots.flatMap((root) => sourceFiles(root))) {
    const lines = readFileSync(file, 'utf8').split('\n').length;
    if (lines > LINE_CEILING) over.push(`${relative(repositoryRoot, file)} (${lines})`);
  }
  assert.deepEqual(over, [], `over ${LINE_CEILING} lines — split the file`);
});
