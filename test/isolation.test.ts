import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

/**
 * The engine rule — platform ADR-0034 decision 6, the owner's words of 2026-10-08:
 * "automations are vendor or tool agnostic ... each automation is its own applet
 * service. however it should not bring another down." An automation may run ANY
 * engine behind the serving shell — Temporal, n8n, another — as one engine
 * instance per automation, with that engine's state in the automation's own store;
 * nothing is shared with another automation or with the platform, so one engine's
 * failure reaches no other automation; the contract stays the probe, the invoke
 * and the callbacks, and every provider and model call still goes through the
 * platform.
 *
 * LIBRARY PACKAGES — the owner, 2026-10-10: "should we create a library folder that
 * specific automation folders call to build with". An automation may depend on the
 * SDK and on library packages under `packages/` (the kit), each packed into its image
 * at build time exactly as the SDK is (`--install-links`), so the image carries its
 * own copy and nothing is shared at run time; a library depends on no automation.
 *
 * WHAT THIS FILE HOLDS, the strongest form a static test here can: no automation
 * declares a dependency on another automation, by name or by `file:` path — a local
 * dependency is a package under `packages/` and nothing else; no source file under
 * `automations/<a>` imports anything under `automations/<b>`, by package name or by
 * relative path; no automation's Dockerfile copies anything from another
 * automation's directory into its image; and no library names or imports an
 * automation. `test/architecture.test.ts` holds the rest: every automation a complete
 * unit, its lockfile pinning and its image packing each local package, and each
 * library shipping `dist` alone on Node built-ins. Two automations therefore share no
 * code, no file, no image layer of each other's, and no process.
 *
 * WHAT IT CANNOT CHECK: whether two containers share a volume, a database, a queue
 * or a network at run time, and whether an engine runs as one instance per
 * automation — those are written in the platform's compose files and the engine's
 * own configuration, which this repository does not hold. The platform's compose
 * is where that half of the rule is read.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const automationsRoot = join(repositoryRoot, 'automations');
const packagesRoot = join(repositoryRoot, 'packages');

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

function packageOf(directory: string): PackageJson {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageJson;
}

/** Every dependency a package declares, of any kind. */
function declared(manifest: PackageJson): [string, string][] {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ].flatMap((block) => Object.entries(block ?? {}));
}

/** `from '…'`, a bare `import '…'`, `import('…')` and `require('…')` alike. */
function specifiers(source: string): string[] {
  return [
    ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu),
  ].map((match) => match[1]!);
}

/** Package name -> directory name, for every package under `root`. */
function packageNames(root: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const directory of childDirectories(root)) {
    const { name } = packageOf(directory);
    if (name) names.set(name, basename(directory));
  }
  return names;
}

/**
 * Why one dependency an automation declares breaks the rule, or `undefined`. Another
 * automation is refused by its name and by its path; a local (`file:`) dependency must
 * be a package under `packages/` — the SDK or a library — at the path that package's
 * own directory is, named as it names itself.
 */
function dependencyProblem(
  automation: string,
  dependency: string,
  range: string,
  automationPackages: ReadonlyMap<string, string>,
  libraries: ReadonlyMap<string, string>,
): string | undefined {
  const owner = automationPackages.get(dependency);
  if (owner !== undefined && owner !== automation) {
    return `automations/${automation} declares ${dependency}, another automation — an automation shares no code with another`;
  }
  if (range.startsWith('file:')) {
    const library = libraries.get(dependency);
    if (library === undefined || range !== `file:../../packages/${library}`) {
      return `automations/${automation} declares ${dependency} as ${range}; a local dependency is the SDK or a library package under packages/`;
    }
  }
  return undefined;
}

test('no automation depends on, imports from, or copies another automation (ADR-0034 decision 6)', () => {
  const automations = childDirectories(automationsRoot);
  const names = packageNames(automationsRoot);
  const libraries = packageNames(packagesRoot);
  assert.ok(names.size === automations.length, 'every automation names its package');

  for (const directory of automations) {
    const name = basename(directory);
    for (const [dependency, range] of declared(packageOf(directory))) {
      const problem = dependencyProblem(name, dependency, range, names, libraries);
      assert.equal(problem, undefined, problem);
    }

    for (const file of sourceFiles(directory)) {
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        for (const [packageName, owner] of names) {
          assert.ok(
            owner === name ||
              !(specifier === packageName || specifier.startsWith(`${packageName}/`)),
            `${relative(repositoryRoot, file)} imports ${specifier}, another automation`,
          );
        }
        if (specifier.startsWith('.')) {
          const target = resolve(join(file, '..'), specifier);
          assert.ok(
            target.startsWith(directory + sep) || target === directory,
            `${relative(repositoryRoot, file)} imports ${specifier}, which leaves automations/${name}`,
          );
        }
      }
    }

    // Sources only: the last token of a COPY or ADD is the destination inside the
    // image, where naming a directory copies nothing.
    const dockerfile = readFileSync(join(directory, 'Dockerfile'), 'utf8');
    for (const match of dockerfile.matchAll(/^\s*(?:COPY|ADD)\b(.*)$/gmu)) {
      const sources = match[1]!
        .trim()
        .split(/\s+/u)
        .filter((token) => !token.startsWith('--'))
        .slice(0, -1);
      for (const source of sources) {
        const other = /^automations\/([a-z0-9-]+)(?:\/|$)/u.exec(source);
        assert.ok(
          !other || other[1] === name,
          `automations/${name}/Dockerfile copies ${source} into its image: two automations share no file and no image layer`,
        );
      }
    }
  }
});

test('the rule takes the SDK and a library under packages/, and still refuses another automation', () => {
  const automations = new Map([
    ['@autom8x/invoice-processing', 'invoice-processing'],
    ['@autom8x/invoice-check', 'invoice-check'],
  ]);
  const libraries = new Map([
    ['@autom8x/automation-sdk', 'automation-sdk'],
    ['@autom8x/automation-kit', 'automation-kit'],
  ]);
  const problem = (dependency: string, range: string) =>
    dependencyProblem('invoice-processing', dependency, range, automations, libraries);

  assert.equal(problem('@autom8x/automation-sdk', 'file:../../packages/automation-sdk'), undefined);
  assert.equal(problem('@autom8x/automation-kit', 'file:../../packages/automation-kit'), undefined);
  assert.equal(problem('tsx', '^4.19.0'), undefined, 'a registry dependency is not a local one');

  assert.match(
    problem('@autom8x/invoice-check', 'file:../../automations/invoice-check') ?? '',
    /another automation/u,
  );
  assert.match(problem('@autom8x/invoice-check', '^0.1.0') ?? '', /another automation/u);
  // A library's name at another path, a path outside packages/, a name packages/ does not hold.
  assert.match(
    problem('@autom8x/automation-kit', 'file:../../automations/invoice-check') ?? '',
    /a local dependency is/u,
  );
  assert.match(
    problem('@autom8x/automation-kit', 'file:../automation-kit') ?? '',
    /a local dependency is/u,
  );
  assert.match(problem('left-pad', 'file:../../vendor/left-pad') ?? '', /a local dependency is/u);
  assert.match(
    problem('@autom8x/automation-extras', 'file:../../packages/automation-extras') ?? '',
    /a local dependency is/u,
  );
});

test('no library under packages/ depends on or imports an automation', () => {
  const automations = packageNames(automationsRoot);
  for (const directory of childDirectories(packagesRoot)) {
    const label = relative(repositoryRoot, directory);
    for (const [dependency, range] of declared(packageOf(directory))) {
      assert.ok(!automations.has(dependency), `${label} declares ${dependency}, an automation`);
      assert.ok(!range.includes('automations/'), `${label} declares ${dependency} as ${range}`);
    }
    for (const file of sourceFiles(directory)) {
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        assert.ok(
          ![...automations.keys()].some(
            (name) => specifier === name || specifier.startsWith(`${name}/`),
          ),
          `${relative(repositoryRoot, file)} imports ${specifier}, an automation`,
        );
        if (specifier.startsWith('.')) {
          const target = resolve(join(file, '..'), specifier);
          assert.ok(
            target.startsWith(directory + sep),
            `${relative(repositoryRoot, file)} imports ${specifier}, which leaves ${label}`,
          );
        }
      }
    }
  }
});
