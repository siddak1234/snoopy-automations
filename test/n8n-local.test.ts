import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * n8n is a design tool on the owner's Mac and nothing else (the platform's ADR-0052): it runs from
 * `tools/n8n/compose.yml` by its README, and is never built into an image, deployed or run by CI. A
 * design reaches customers only as a code flow, through `/create-flow`. What a file can show of
 * that is held here, by reading the files (no Docker):
 *
 * - no Dockerfile under `automations/` or `templates/` names n8n, and no flow's or the template's
 *   `package.json` or `package-lock.json` names its npm package (by name, by alias or at any
 *   depth), so no flow's image carries it and no scaffolded flow starts with it;
 * - the compose file names n8n by exact release and multi-arch index digest, at or above
 *   `N8N_FLOOR`, the one constant its README's "The pin" raises;
 * - its one service publishes its port on 127.0.0.1 only;
 * - it holds every hardening key with its value, and its node list is the five nodes and no other;
 * - its data is the gitignored `.data` folder beside it;
 * - its service holds image, ports, environment and volumes and no other key, so it never restarts
 *   by itself (no `restart`, no `deploy`) and gains no privilege, network, build or env_file.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(repositoryRoot, path), 'utf8');
const COMPOSE = 'tools/n8n/compose.yml';

/**
 * The lowest n8n release the pin may name; nothing lowers it. Why it is this release, and how a
 * bump raises it: tools/n8n/README.md, "The pin".
 */
const N8N_FLOOR = '2.46.6';

/** `docker.n8n.io/n8nio/n8n:<x.y.z>@sha256:<64 hex>`: a release that never moves, and its index digest. */
const PIN = /^docker\.n8n\.io\/n8nio\/n8n:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/u;

/**
 * The only nodes n8n is told to load (`NODES_INCLUDE`; started 2026-11-06, it listed these and HTTP
 * Request's tool variant, which it adds): no Code node, no Execute Command, no file or SSH node.
 */
const NODES = [
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.respondToWebhook',
  'n8n-nodes-base.set',
  'n8n-nodes-base.if',
  'n8n-nodes-base.httpRequest',
];

/** Each hardening key and the value it must hold (n8n's pages for each: tools/n8n/README.md). */
const HARDENING: Readonly<Record<string, string>> = {
  N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_TEMPLATES_ENABLED: 'false',
  EXTERNAL_FRONTEND_HOOKS_URLS: '',
  N8N_DIAGNOSTICS_CONFIG_FRONTEND: '',
  N8N_DIAGNOSTICS_CONFIG_BACKEND: '',
  N8N_COMMUNITY_PACKAGES_ENABLED: 'false',
  N8N_BLOCK_ENV_ACCESS_IN_NODE: 'true',
  N8N_PUBLIC_API_DISABLED: 'true',
  N8N_PUBLIC_API_SWAGGERUI_DISABLED: 'true',
  EXECUTIONS_DATA_SAVE_ON_SUCCESS: 'none',
  EXECUTIONS_DATA_SAVE_ON_ERROR: 'none',
  EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS: 'false',
};

/** Every Dockerfile under a folder, from the repository's root; installed and built folders skipped. */
function dockerfiles(folder: string): string[] {
  return readdirSync(join(repositoryRoot, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'dist' ? [] : dockerfiles(path);
    }
    return /^Dockerfile(?:\..+)?$|\.Dockerfile$/u.test(entry.name) ? [path] : [];
  });
}

/** Each flow's and the template's `package.json` and `package-lock.json`, from the root. */
function packageFiles(): string[] {
  return ['automations', 'templates']
    .flatMap((folder) =>
      readdirSync(join(repositoryRoot, folder), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          ['package.json', 'package-lock.json'].map((name) => `${folder}/${entry.name}/${name}`),
        ),
    )
    .filter((path) => existsSync(join(repositoryRoot, path)));
}

/** Every kind of dependency a `package.json` declares. */
const DEPENDENCY_KINDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * Where one package file names n8n's npm package, `n8n`, as `path: where`: in a `package.json`, a
 * dependency of any kind named n8n or aliased to it (`npm:n8n@…`); in a `package-lock.json`, an
 * entry installed at `node_modules/n8n`, at any depth, or one that names itself n8n (an alias).
 */
function n8nPackages(path: string, text: string): string[] {
  const json = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
  if (path.endsWith('package-lock.json')) {
    return Object.entries(json.packages ?? {})
      .filter(
        ([key, entry]) =>
          /(?:^|\/)node_modules\/n8n$/u.test(key) || (entry as { name?: unknown }).name === 'n8n',
      )
      .map(([key]) => `${path}: ${key}`);
  }
  return DEPENDENCY_KINDS.flatMap((kind) =>
    Object.entries(json[kind] ?? {})
      .filter(([name, range]) => name === 'n8n' || /^npm:n8n(?:@|$)/u.test(String(range)))
      .map(([name]) => `${path}: ${kind}.${name}`),
  );
}

/** A YAML scalar as written here: quoted once in single or double quotes, or plain. */
function unquote(value: string): string {
  const single = /^'(.*)'$/u.exec(value);
  if (single) return single[1]!.replaceAll("''", "'");
  const double = /^"(.*)"$/u.exec(value);
  return double ? double[1]! : value;
}

/** The service names under `services:`, each a two-space key. */
function services(text: string): string[] {
  const block = text.split(/^services:\n/mu)[1] ?? '';
  return [...block.matchAll(/^ {2}([A-Za-z0-9_.-]+):\s*$/gmu)].map((match) => match[1]!);
}

/**
 * The entries under one key of the service (`ports`, `environment`, `volumes`), comments and blank
 * lines left out: a list item without its `- `, a map entry as written.
 */
function entries(text: string, key: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(`    ${key}:`);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!line.startsWith('      ')) break;
    out.push(line.trim().replace(/^- /u, ''));
  }
  return out;
}

/**
 * The keys of the one service as written: every line at exactly four spaces under `  n8n:`, cut at
 * its colon, so a key this test does not know (a merge key `<<` included) is still read as one.
 */
function serviceKeys(text: string): string[] {
  const lines = text.split('\n');
  const keys: string[] = [];
  for (const line of lines.slice(lines.indexOf('  n8n:') + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!line.startsWith('    ')) break;
    if (!line.startsWith('     ')) keys.push(line.trim().replace(/:.*$/u, ''));
  }
  return keys;
}

/** The service's environment, as a map form of `KEY: value` lines. */
function environment(text: string): Record<string, string> {
  return Object.fromEntries(
    entries(text, 'environment').map((line) => {
      const match = /^([A-Z0-9_]+):(?: (.*))?$/u.exec(line);
      assert.ok(match, `environment line "${line}" is not KEY: value`);
      return [match[1]!, unquote(match[2] ?? '')];
    }),
  );
}

/** Whether release `a` (x.y.z) is at or above release `b`, compared as numbers part by part. */
function atOrAbove(a: string, b: string): boolean {
  const [left, right] = [a, b].map((release) => release.split('.').map(Number));
  for (let index = 0; index < 3; index += 1) {
    const difference = (left?.[index] ?? 0) - (right?.[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

test('no Dockerfile under automations/ or templates/ names n8n', () => {
  const files = ['automations', 'templates'].flatMap(dockerfiles);
  assert.ok(files.includes('templates/automation/Dockerfile'), 'the template is read');
  assert.ok(files.length >= 2, 'the flows and the template are read');
  assert.deepEqual(
    files.filter((path) => /n8n/iu.test(read(path))),
    [],
    'a Dockerfile names n8n',
  );
});

test("no flow's or the template's package.json or package-lock.json names n8n's npm package", () => {
  const files = packageFiles();
  for (const name of ['package.json', 'package-lock.json']) {
    assert.ok(files.includes(`templates/automation/${name}`), `the template's ${name} is read`);
  }
  assert.ok(files.length >= 4, 'the flows and the template are read');
  assert.deepEqual(
    files.flatMap((path) => n8nPackages(path, read(path))),
    [],
    'a package file names n8n: its npm ci would put n8n into the image',
  );
});

test('the package check finds n8n by name, by alias and at any depth, and nothing unrelated', () => {
  const manifest = (body: object) => n8nPackages('a/package.json', JSON.stringify(body));
  const lock = (packages: object) =>
    n8nPackages('a/package-lock.json', JSON.stringify({ packages }));
  assert.deepEqual(manifest({ dependencies: { n8n: '2.46.6' } }), [
    'a/package.json: dependencies.n8n',
  ]);
  assert.deepEqual(manifest({ devDependencies: { n8n: '^2.46.6' } }), [
    'a/package.json: devDependencies.n8n',
  ]);
  assert.deepEqual(manifest({ optionalDependencies: { engine: 'npm:n8n@2.46.6' } }), [
    'a/package.json: optionalDependencies.engine',
  ]);
  assert.deepEqual(lock({ 'node_modules/n8n': { version: '2.46.6' } }), [
    'a/package-lock.json: node_modules/n8n',
  ]);
  assert.deepEqual(lock({ 'node_modules/kit/node_modules/n8n': { version: '2.46.6' } }), [
    'a/package-lock.json: node_modules/kit/node_modules/n8n',
  ]);
  assert.deepEqual(lock({ 'node_modules/engine': { name: 'n8n', version: '2.46.6' } }), [
    'a/package-lock.json: node_modules/engine',
  ]);
  assert.deepEqual(
    manifest({ dependencies: { '@autom8x/automation-sdk': 'file:../../packages/automation-sdk' } }),
    [],
  );
  assert.deepEqual(lock({ '': { name: '@autom8x/example' }, 'node_modules/tsx': {} }), []);
});

test(`${COMPOSE} names n8n by exact release and multi-arch index digest, in its one service`, () => {
  const text = read(COMPOSE);
  assert.deepEqual(services(text), ['n8n'], 'one service, n8n');
  const images = [...text.matchAll(/^\s*image:\s*(\S+)\s*$/gmu)].map((match) => match[1]!);
  assert.equal(images.length, 1, 'one image');
  assert.match(images[0]!, PIN, 'docker.n8n.io/n8nio/n8n:<x.y.z>@sha256:<64 hex>');
});

test(`the release ${COMPOSE} pins is at or above the floor, ${N8N_FLOOR}`, () => {
  // The comparison is by number, not by text: 2.100.0 is above 2.46.6.
  assert.ok(atOrAbove('2.46.6', '2.46.6') && atOrAbove('2.46.10', '2.46.6'));
  assert.ok(atOrAbove('2.100.0', '2.46.6') && atOrAbove('3.0.0', '2.46.6'));
  assert.ok(!atOrAbove('2.46.5', '2.46.6') && !atOrAbove('1.123.99', '2.46.6'));
  const release = PIN.exec(/^\s*image:\s*(\S+)\s*$/mu.exec(read(COMPOSE))?.[1] ?? '')?.[1];
  assert.ok(release, 'the pin names a release');
  assert.ok(atOrAbove(release, N8N_FLOOR), `n8n ${release} is below the floor ${N8N_FLOOR}`);
});

test(`${COMPOSE} publishes its one port on 127.0.0.1 only`, () => {
  const text = read(COMPOSE);
  const ports = entries(text, 'ports');
  assert.ok(ports.length >= 1, 'a port is published');
  for (const port of ports.map(unquote)) {
    assert.match(port, /^127\.0\.0\.1:\d+:5678$/u, `${port} binds beyond 127.0.0.1`);
  }
  assert.doesNotMatch(text, /^\s*network_mode:/mu, 'no host network');
});

test(`${COMPOSE} holds every hardening key, and its node list is the five nodes and no other`, () => {
  const values = environment(read(COMPOSE));
  for (const [key, value] of Object.entries(HARDENING)) {
    assert.equal(values[key], value, `${key} must be '${value}'`);
  }
  assert.ok(
    values.NODES_INCLUDE !== undefined,
    'NODES_INCLUDE is set: without it every node loads',
  );
  assert.deepEqual(JSON.parse(values.NODES_INCLUDE), NODES, 'the five nodes and no other');
});

test(`${COMPOSE} keeps its data in the gitignored .data folder`, () => {
  const text = read(COMPOSE);
  assert.deepEqual(entries(text, 'volumes'), ['./.data:/home/node/.n8n'], 'one bind mount');
  assert.match(read('.gitignore'), /^tools\/n8n\/\.data\/$/mu, '.gitignore names the data folder');
});

test(`${COMPOSE}'s service holds only image, ports, environment and volumes: it never restarts by itself`, () => {
  assert.deepEqual(
    serviceKeys(read(COMPOSE)).sort(),
    ['environment', 'image', 'ports', 'volumes'],
    'no other key: no restart policy (restart, deploy), privileged, networks, build or env_file',
  );
});
