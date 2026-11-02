import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * Pinned tools (Round 21 hardening): every flow's image, and the template's a new flow copies, is
 * built from one Node release named by exact tag and multi-arch index digest, in ONE FROM per
 * Dockerfile, its first (`AS base`), which every other stage builds FROM, the same in every
 * Dockerfile, so the bytes CI scanned are the bytes Flow CD ships until Dependabot's weekly docker
 * group moves them all in one pull request (.github/dependabot.yml). It moves only a Dockerfile's
 * first FROM, so a second FROM naming the image would be left behind (README, "Working here",
 * pinned base images).
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

/**
 * Each FROM of a Dockerfile that names an image, with its file: every FROM but one naming a stage
 * the same file declared above it (`FROM base AS build`).
 */
function bases(files: readonly { path: string; text: string }[]): [string, string][] {
  return files.flatMap(({ path, text }) => {
    const stages = new Set<string>();
    const images: [string, string][] = [];
    for (const match of text.matchAll(
      /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gimu,
    )) {
      if (!stages.has(match[1]!.toLowerCase())) images.push([path, match[1]!]);
      if (match[2]) stages.add(match[2].toLowerCase());
    }
    return images;
  });
}

/**
 * What is wrong with the bases: a Dockerfile naming an image in more FROMs than one (or none), an
 * image not pinned by tag and digest, or two Dockerfiles naming different ones.
 */
function baseProblems(paths: readonly string[], found: readonly [string, string][]): string[] {
  const problems = paths.flatMap((path) => {
    const count = found.filter(([file]) => file === path).length;
    return count === 1
      ? []
      : [
          `${path}: ${count} FROMs name an image, not one: name it once, AS base, and build FROM base`,
        ];
  });
  problems.push(
    ...found
      .filter(([, image]) => !PINNED.test(image))
      .map(([path, image]) => `${path}: FROM ${image} is not pinned by exact tag and index digest`),
  );
  const distinct = [...new Set(found.map(([, image]) => image))];
  if (distinct.length > 1) problems.push(`the FROMs differ: ${distinct.join(', ')}`);
  return problems;
}

test('every flow Dockerfile, and the template’s, names one image in one FROM: the same Node by exact tag and index digest', () => {
  assert.ok(dockerfiles.length >= 2, 'the flows and the template');
  const found = bases(dockerfiles.map((path) => ({ path, text: read(path) })));
  assert.deepEqual(baseProblems(dockerfiles, found), []);
});

test('a FROM by tag alone or a moving tag, a second image FROM in one file, or two files that differ are refused', () => {
  const pinned = `node:22.23.4-alpine@sha256:${'a'.repeat(64)}`;
  const staged = (image: string) =>
    `FROM ${image} AS base\nFROM base AS build\nFROM base AS production-dependencies\nfrom base as runtime\n`;
  const check = (...texts: string[]) => {
    const files = texts.map((text, index) => ({ path: `${index}/Dockerfile`, text }));
    return baseProblems(
      files.map(({ path }) => path),
      bases(files),
    ).join('\n');
  };
  assert.equal(check(staged(pinned), staged(pinned)), '');
  assert.match(check(staged('node:22-alpine')), /FROM node:22-alpine is not pinned/u);
  assert.match(check(staged('node:22.23.4-alpine')), /is not pinned/u);
  assert.match(check(staged(`node:22-alpine@sha256:${'a'.repeat(64)}`)), /is not pinned/u);
  // The image named again in a later stage: Dependabot would move the first FROM alone.
  assert.match(
    check(`${staged(pinned)}FROM ${pinned} AS again\n`),
    /0\/Dockerfile: 2 FROMs name an image, not one/u,
  );
  // A stage named before it is declared is an image, not the stage.
  assert.match(check(`FROM build AS base\n${staged(pinned)}`), /2 FROMs name an image/u);
  assert.match(check('# no FROM\n'), /0 FROMs name an image/u);
  const behind = `node:22.23.5-alpine@sha256:${'b'.repeat(64)}`;
  assert.match(check(staged(behind), staged(pinned)), /the FROMs differ/u);
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

test('.nvmrc names the exact Node release the images ship, every setup-node installs it from the file, and no brief types it', () => {
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

  // A brief or a skill that types the release is a second copy that drifts: it points at the file.
  const typed = (path: string): string[] =>
    readdirSync(join(repositoryRoot, path), { withFileTypes: true }).flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return typed(child);
      return /nvm\/versions\/node\/v\d/u.test(read(child)) ? [child] : [];
    });
  assert.deepEqual(
    typed('.claude'),
    [],
    'a Node release typed under .claude, not read from .nvmrc',
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
