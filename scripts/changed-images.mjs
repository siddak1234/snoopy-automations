#!/usr/bin/env node
// The flows whose image a pull request builds (Round 21, R5): CI's List job runs
//   node scripts/changed-images.mjs --base <ref>
// on a pull request and prints a JSON list of the flows under `automations/` whose image inputs
// changed since <ref>: the Dockerfile itself, or any of its COPY sources (never `--from=`), the
// rule the platform's Flow CD uses to tell an UPDATE from a SKIP (`snoopy-backend/scripts/flow-cd.mjs`,
// `dockerfileInputs`). A change under `packages/`, to the root `package.json`, `package-lock.json`
// or a root tsconfig, or to CI's own workflow builds every flow. A push to main builds every flow,
// as before, and does not run this. Node built-ins only: it runs before any install.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVERY = [
  /^packages\//u,
  /^package(?:-lock)?\.json$/u,
  /^tsconfig(?:\.base)?\.json$/u,
  /^\.github\/workflows\/ci\.yml$/u,
];

/** A Dockerfile's build-context inputs: its COPY and ADD sources, never a `--from=` stage. */
export function dockerfileInputs(text) {
  const inputs = [];
  for (const line of text.replace(/\\\n/gu, ' ').split('\n')) {
    const words = /^\s*(?:COPY|ADD)\s+(.*)$/iu.exec(line)?.[1]?.trim().split(/\s+/u) ?? [];
    if (words.some((word) => word.startsWith('--from'))) continue;
    const paths = words.filter((word) => !word.startsWith('--'));
    inputs.push(
      ...paths.slice(0, -1).map((path) => path.replace(/^\.\//u, '').replace(/\/$/u, '')),
    );
  }
  return inputs;
}

/** The flows, of `dockerfiles` ({ name, text }), whose image the `changed` paths touch. */
export function changedImages(dockerfiles, changed) {
  const names = dockerfiles.map((entry) => entry.name).sort();
  if (changed.some((path) => EVERY.some((pattern) => pattern.test(path)))) return names;
  return names.filter((name) => {
    const { text } = dockerfiles.find((entry) => entry.name === name);
    const inputs = [`automations/${name}/Dockerfile`, ...dockerfileInputs(text)];
    return changed.some((path) =>
      inputs.some((input) => path === input || path.startsWith(`${input}/`)),
    );
  });
}

/** Every `automations/*\/Dockerfile` under `root`, as List reads them. */
export function dockerfilesUnder(root = REPOSITORY) {
  const directory = join(root, 'automations');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'Dockerfile')))
    .map((entry) => ({
      name: entry.name,
      text: readFileSync(join(directory, entry.name, 'Dockerfile'), 'utf8'),
    }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--base');
  const base = at < 0 ? undefined : process.argv[at + 1];
  if (!base) {
    console.error('usage: node scripts/changed-images.mjs --base <ref>');
    process.exit(2);
  }
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: REPOSITORY,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  process.stdout.write(`${JSON.stringify(changedImages(dockerfilesUnder(), changed))}\n`);
}
