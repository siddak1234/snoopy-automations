import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * n8n is a design tool on the owner's Mac and nothing else (the platform's ADR-0052): it runs from
 * `tools/n8n/compose.yml` by its README, and is never built into an image, deployed or run by CI. A
 * design reaches customers only as a code flow, through `/create-flow`. What a file can show of
 * that is held here, by reading the files (no Docker):
 *
 * - no Dockerfile under `automations/` or `templates/` names n8n, so no flow's image carries it
 *   and no scaffolded flow starts with it;
 * - the compose file names n8n by exact release and multi-arch index digest, at or above
 *   `N8N_FLOOR`, the one constant its README's "The pin" raises;
 * - its one service publishes its port on 127.0.0.1 only;
 * - it holds every hardening key with its value, and its node list is the five nodes and no other;
 * - its data is the gitignored `.data` folder beside it, and it never restarts by itself.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(repositoryRoot, path), 'utf8');
const COMPOSE = 'tools/n8n/compose.yml';

/**
 * The lowest n8n release the pin may name, set 2026-11-06 to n8n's stable of 2026-11-04: above
 * 2.46.1, where the 2.46 line takes the fixes of n8n's security advisories of 2026-10-28. A bump
 * raises it to the new release (tools/n8n/README.md, "The pin"); nothing lowers it.
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

test('no Dockerfile under automations/ or templates/ names n8n: no flow image carries it', () => {
  const files = ['automations', 'templates'].flatMap(dockerfiles);
  assert.ok(files.includes('templates/automation/Dockerfile'), 'the template is read');
  assert.ok(files.length >= 2, 'the flows and the template are read');
  assert.deepEqual(
    files.filter((path) => /n8n/iu.test(read(path))),
    [],
    'a Dockerfile names n8n',
  );
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

test(`${COMPOSE} keeps its data in the gitignored .data folder and never restarts by itself`, () => {
  const text = read(COMPOSE);
  assert.deepEqual(entries(text, 'volumes'), ['./.data:/home/node/.n8n'], 'one bind mount');
  assert.match(read('.gitignore'), /^tools\/n8n\/\.data\/$/mu, '.gitignore names the data folder');
  assert.doesNotMatch(text, /^\s*restart:/mu, 'no restart policy');
});
