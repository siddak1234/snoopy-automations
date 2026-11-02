import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * Pinned tools (Round 21 hardening): every flow's image, and the template's a new flow copies, is
 * built FROM one Node release named by exact tag and multi-arch index digest, the same in every
 * stage of every Dockerfile, so the bytes CI scanned are the bytes Flow CD ships until
 * Dependabot's weekly docker group moves them all in one pull request (.github/dependabot.yml).
 * `.nvmrc` names that same release, and every workflow installs Node from it, as in the other
 * repositories, so CI and a developer's nvm run what the images ship.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(repositoryRoot, path), 'utf8');

/** Every flow's Dockerfile, and the template's, from the repository's root. */
const dockerfiles = [
  ...readdirSync(join(repositoryRoot, 'automations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `automations/${entry.name}/Dockerfile`)
    .filter((path) => existsSync(join(repositoryRoot, path))),
  'templates/automation/Dockerfile',
];

/** `node:<major>.<minor>.<patch>-alpine@sha256:<64 hex>`: a tag that never moves, and its index digest. */
const PINNED = /^node:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/u;

/** Each `FROM` image a Dockerfile names, with its file. */
function bases(files: readonly { path: string; text: string }[]): [string, string][] {
  return files.flatMap(({ path, text }) =>
    [...text.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gmu)].map((match): [string, string] => [
      path,
      match[1]!,
    ]),
  );
}

/** What is wrong with the bases: a FROM not pinned by tag and digest, or two different ones. */
function baseProblems(found: readonly [string, string][]): string[] {
  const problems = found
    .filter(([, image]) => !PINNED.test(image))
    .map(([path, image]) => `${path}: FROM ${image} is not pinned by exact tag and index digest`);
  const distinct = [...new Set(found.map(([, image]) => image))];
  if (distinct.length > 1) problems.push(`the FROMs differ: ${distinct.join(', ')}`);
  return problems;
}

test('every FROM of every flow Dockerfile, and the template’s, is one Node by exact tag and index digest', () => {
  assert.ok(dockerfiles.length >= 2, 'the flows and the template');
  const found = bases(dockerfiles.map((path) => ({ path, text: read(path) })));
  for (const path of dockerfiles) {
    assert.ok(found.filter(([file]) => file === path).length >= 1, `${path} names a base image`);
  }
  assert.deepEqual(baseProblems(found), []);
});

test('a FROM by tag alone, by a moving tag, or one stage left behind by a bump is refused', () => {
  const pinned = `node:22.23.4-alpine@sha256:${'a'.repeat(64)}`;
  const text = (stages: string[]) => stages.map((image) => `FROM ${image} AS stage\n`).join('');
  const check = (stages: string[]) =>
    baseProblems(bases([{ path: 'Dockerfile', text: text(stages) }]));
  assert.deepEqual(check([pinned, pinned, pinned]), []);
  assert.match(check(['node:22-alpine'])[0]!, /FROM node:22-alpine is not pinned/u);
  assert.match(check(['node:22.23.4-alpine'])[0]!, /is not pinned/u);
  assert.match(check([`node:22-alpine@sha256:${'a'.repeat(64)}`])[0]!, /is not pinned/u);
  const behind = `node:22.23.5-alpine@sha256:${'b'.repeat(64)}`;
  assert.match(check([behind, pinned, pinned]).join('\n'), /the FROMs differ/u);
});

test('Dependabot’s docker entry covers every Dockerfile’s folder, in one group, and never moves a Node major', () => {
  const text = read('.github/dependabot.yml');
  const docker = text
    .split(/^ {2}- package-ecosystem: /mu)
    .find((entry) => /^docker\n/u.test(entry));
  assert.ok(docker !== undefined, 'a docker entry');
  const directories = [
    ...(docker.split(/^ {4}directories:\n/mu)[1] ?? '').matchAll(/^ {6}- (\S+)$/gmu),
  ].map((match) => match[1]!);
  const covers = (folder: string) =>
    directories.some((glob) =>
      new RegExp(
        `^${glob.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]+')}$`,
        'u',
      ).test(`/${folder}`),
    );
  for (const path of dockerfiles) {
    assert.ok(
      covers(path.replace(/\/Dockerfile$/u, '')),
      `${path} is in the docker entry's directories`,
    );
  }
  assert.match(
    docker,
    /^ {4}groups:\n {6}[\w-]+:\n {8}group-by: dependency-name$/mu,
    'one pull request',
  );
  assert.match(
    docker,
    /^ {6}- dependency-name: node\n {8}update-types: \['version-update:semver-major'\]$/mu,
    'a Node major is never moved by the bot',
  );
});

test('.nvmrc names the exact Node release the images ship, and every setup-node installs it from the file', () => {
  const exact = read('.nvmrc').trim();
  assert.match(exact, /^\d+\.\d+\.\d+$/u, `.nvmrc names ${exact}, not one exact release`);
  const { engines } = JSON.parse(read('package.json')) as { engines: { node: string } };
  assert.equal(engines.node, `>=${exact.split('.')[0]}`, 'its major is the one engines declares');
  // Moved by hand with the image: a bump of the FROM is red here until `.nvmrc` moves with it.
  const shipped = bases(dockerfiles.map((path) => ({ path, text: read(path) }))).map(
    ([, image]) => /^node:(\d+\.\d+\.\d+)-/u.exec(image)?.[1],
  );
  assert.deepEqual(
    [...new Set(shipped)],
    [exact],
    `.nvmrc names ${exact}; the images ship ${shipped.join(', ')}`,
  );

  const workflows = readdirSync(join(repositoryRoot, '.github', 'workflows')).filter((name) =>
    /\.ya?ml$/u.test(name),
  );
  let setups = 0;
  for (const name of workflows) {
    const text = read(`.github/workflows/${name}`);
    for (const step of text
      .split(/^ {6}- /mu)
      .filter((each) => /uses: actions\/setup-node@/u.test(each))) {
      setups += 1;
      assert.match(step, /^ {10}node-version-file: \.nvmrc$/mu, `${name}: setup-node reads .nvmrc`);
      assert.doesNotMatch(step, /^ {10}node-version:/mu, `${name}: no Node typed beside it`);
    }
  }
  assert.ok(setups >= 1, 'CI sets up Node');
});
