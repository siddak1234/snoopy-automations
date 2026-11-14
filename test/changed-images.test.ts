import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * CI's Image job on a pull request (Round 21, R5): only the flows whose image inputs changed —
 * the Dockerfile or a COPY source, Flow CD's rule — and every flow for a change under `packages/`,
 * to `tsconfig.base.json` or to CI itself. The root `package.json`, `package-lock.json` and
 * `tsconfig.json` are no image's input (each image reads its own flow's lock), so a new flow's
 * merge builds that flow alone. `scripts/changed-images.mjs` runs before any install, so it is
 * plain JavaScript, imported here by URL.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const { changedImages, dockerfileInputs, dockerfilesUnder } = (await import(
  pathToFileURL(join(repositoryRoot, 'scripts', 'changed-images.mjs')).href
)) as {
  changedImages: (dockerfiles: { name: string; text: string }[], changed: string[]) => string[];
  dockerfileInputs: (text: string) => string[];
  dockerfilesUnder: (root?: string) => { name: string; text: string }[];
};
const { scaffold } = (await import(
  pathToFileURL(join(repositoryRoot, 'scripts', 'scaffold.mjs')).href
)) as { scaffold: (root: string, id: string) => string[] };

const flows = dockerfilesUnder();
const all = flows.map((flow) => flow.name).sort();

test('a flow’s own source, prompts, manifest or Dockerfile builds that flow alone', () => {
  // Every flow with a Dockerfile, as `dockerfilesUnder()` finds it: a new flow needs no edit here.
  assert.ok(all.includes('candidate-reviewer') && all.includes('invoice-processing'), all.join());
  for (const name of all) {
    assert.deepEqual(changedImages(flows, [`automations/${name}/Dockerfile`]), [name], name);
  }
  for (const [changed, built] of [
    [['automations/candidate-reviewer/src/steps/candidate.ts'], ['candidate-reviewer']],
    [['automations/invoice-processing/prompts/extract-documents.v1.json'], ['invoice-processing']],
    [['manifests/invoice-processing.v8.json'], ['invoice-processing']],
    [['automations/candidate-reviewer/Dockerfile'], ['candidate-reviewer']],
  ] as const) {
    assert.deepEqual(changedImages(flows, [...changed]), built, changed.join());
  }
});

test('what no image copies builds none; packages, tsconfig.base.json and CI build every flow', () => {
  for (const changed of [
    ['automations/candidate-reviewer/README.md'],
    ['automations/invoice-processing/test/routes.test.ts'],
    ['manifests/invoice-processing.v6.json'],
    ['README.md', 'docs/MAP.md', '.claude/skills/create-flow/SKILL.md'],
    ['package-lock.json'],
    ['package.json'],
    ['tsconfig.json'],
  ]) {
    assert.deepEqual(changedImages(flows, changed), [], changed.join());
  }
  for (const changed of [
    ['packages/automation-sdk/src/flow.ts'],
    ['packages/automation-kit/src/quickbooks/read.ts'],
    ['tsconfig.base.json'],
    ['.github/workflows/ci.yml'],
  ]) {
    assert.deepEqual(changedImages(flows, changed), all, changed.join());
  }
});

test('a Dockerfile’s inputs are its COPY sources, never a --from stage', () => {
  assert.deepEqual(
    dockerfileInputs(
      'COPY package.json package-lock.json ./\nCOPY --from=build /w/dist ./dist\nCOPY --chown=node:node automations/x/prompts ./prompts\n',
    ),
    ['package.json', 'package-lock.json', 'automations/x/prompts'],
  );
});

test('every flow’s image, and the template’s, copies its own lock and no other: only its folder, its manifest, packages/ and tsconfig.base.json', () => {
  const template = readFileSync(
    join(repositoryRoot, 'templates', 'automation', 'Dockerfile'),
    'utf8',
  );
  for (const { name, text } of [...flows, { name: 'example', text: template }]) {
    const inputs = dockerfileInputs(text);
    const manifest = new RegExp(`^manifests/${name}\\.v[1-9][0-9]*\\.json$`, 'u');
    for (const input of inputs) {
      assert.ok(
        input === 'tsconfig.base.json' ||
          input.startsWith('packages/') ||
          input.startsWith(`automations/${name}/`) ||
          manifest.test(input),
        `${name}'s image copies ${input}`,
      );
    }
    assert.deepEqual(
      [...new Set(inputs.filter((input) => input.endsWith('package-lock.json')))],
      [`automations/${name}/package-lock.json`],
      `${name}'s image reads its own lock and no other`,
    );
  }
});

const scratch = mkdtempSync(join(tmpdir(), 'changed-images-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('a change that only adds a flow, as the scaffold writes it, builds that flow alone', () => {
  copyFileSync(join(repositoryRoot, 'package-lock.json'), join(scratch, 'package-lock.json'));
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, 'templates', 'automation', 'example.v1.json'), 'utf8'),
  ) as Record<string, unknown>;
  mkdirSync(join(scratch, 'manifests'));
  writeFileSync(
    join(scratch, 'manifests', 'sample-flow.v1.json'),
    JSON.stringify({ ...manifest, templateId: 'sample-flow', requiredConnections: [] }),
  );
  const changed = [...scaffold(scratch, 'sample-flow'), 'manifests/sample-flow.v1.json'];
  assert.ok(changed.includes('package-lock.json'), changed.join());
  assert.ok(changed.includes('automations/sample-flow/Dockerfile'), changed.join());
  assert.deepEqual(changedImages([...dockerfilesUnder(), ...dockerfilesUnder(scratch)], changed), [
    'sample-flow',
  ]);
});
