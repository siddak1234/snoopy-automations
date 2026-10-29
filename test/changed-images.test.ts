import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * CI's Image job on a pull request (Round 21, R5): only the flows whose image inputs changed —
 * the Dockerfile or a COPY source, Flow CD's rule — and every flow for a change under `packages/`,
 * the root lock or CI itself. `scripts/changed-images.mjs` runs before any install, so it is plain
 * JavaScript, imported here by URL.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const { changedImages, dockerfileInputs, dockerfilesUnder } = (await import(
  pathToFileURL(join(repositoryRoot, 'scripts', 'changed-images.mjs')).href
)) as {
  changedImages: (dockerfiles: { name: string; text: string }[], changed: string[]) => string[];
  dockerfileInputs: (text: string) => string[];
  dockerfilesUnder: () => { name: string; text: string }[];
};

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
    [['manifests/invoice-processing.v7.json'], ['invoice-processing']],
    [['automations/candidate-reviewer/Dockerfile'], ['candidate-reviewer']],
  ] as const) {
    assert.deepEqual(changedImages(flows, [...changed]), built, changed.join());
  }
});

test('what no image copies builds none; packages, the root lock and CI build every flow', () => {
  for (const changed of [
    ['automations/candidate-reviewer/README.md'],
    ['automations/invoice-processing/test/routes.test.ts'],
    ['manifests/invoice-processing.v6.json'],
    ['README.md', 'docs/MAP.md', '.claude/skills/create-flow/SKILL.md'],
  ]) {
    assert.deepEqual(changedImages(flows, changed), [], changed.join());
  }
  for (const changed of [
    ['packages/automation-sdk/src/flow.ts'],
    ['packages/automation-kit/src/quickbooks/read.ts'],
    ['package-lock.json'],
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
