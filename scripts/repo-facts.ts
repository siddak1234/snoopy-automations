import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What this repository reports about itself, in the shape the platform
 * repository's `docs/repo-facts.schema.json` declares, so that repository can
 * quote this one's counts (its SYSTEM-MANIFEST §10a) without reading its files
 * (its BUILD-PLAN 17.2.4 and 25.3.6; §12.2 #68). Every count carries the command
 * that produced it: a number without its command is the thing that drifted.
 * Ported from `snoopy-mobile/scripts/repo-facts.mjs`.
 *
 * Emitted by `npm run verify` as its LAST step, with `gate: "verify"`, to
 * `docs/repo-facts/snoopy-automations.json`, and committed here beside the code
 * it counts (Round 17's instruction); the platform repository copies the file
 * emitted at `main`. `head` is the commit the counts were taken at — the parent of
 * the commit that carried the new counts, and unchanged by later commits that do
 * not move them. `test/repo-facts.test.ts` refuses a committed copy whose counts
 * differ from the tree's. `npm run facts` emits the same file without the gate
 * claim, for a tree the gate has not yet run on.
 */

const root = resolve(import.meta.dirname, '..');
export const FACTS_PATH = 'docs/repo-facts/snoopy-automations.json';

// One basis for every count: the working tree minus what .gitignore excludes —
// tracked and untracked alike, never node_modules or dist.
const BASIS = 'git ls-files --cached --others --exclude-standard -- ';
export const COUNTS: readonly (readonly [string, string])[] = [
  ['typescriptFiles', `${BASIS}':(glob)**/*.ts' | wc -l`],
  ['automations', 'ls -d automations/*/ | wc -l'],
  ['sdkPackages', 'ls -d packages/*/ | wc -l'],
  ['manifests', `${BASIS}':(glob)manifests/*.json' | wc -l`],
  ['promptTemplates', `${BASIS}':(glob)automations/*/prompts/*.json' | wc -l`],
  ['testFiles', `${BASIS}':(glob)**/*.test.ts' | wc -l`],
];

export interface RepoFacts {
  schemaVersion: 1;
  repository: 'snoopy-automations';
  head: string;
  readAt: string;
  gate?: string;
  counts: Record<string, { value: number; command: string }>;
}

// `pipefail`, so a producer that fails cannot hide behind `wc`'s exit 0 and be
// recorded as a verified count of zero.
function sh(command: string): string {
  return execFileSync('bash', ['-c', `set -o pipefail; ${command}`], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function count(unit: string, command: string): number {
  const out = sh(command);
  const value = Number(out);
  if (out === '' || !Number.isInteger(value) || value < 0) {
    throw new Error(`repo-facts: ${unit} produced "${out}", not a count`);
  }
  return value;
}

export function repoFacts(options: { gate?: string } = {}): RepoFacts {
  const counts: RepoFacts['counts'] = {};
  for (const [unit, command] of COUNTS) {
    counts[unit] = { value: count(unit, command), command };
  }
  return {
    schemaVersion: 1,
    repository: 'snoopy-automations',
    head: sh('git rev-parse --short HEAD'),
    readAt: new Date().toISOString().slice(0, 10),
    ...(options.gate ? { gate: options.gate } : {}),
    counts,
  };
}

/**
 * Writes the facts — unless the file already holds these counts (and the gate
 * claim asked for): then it is left as it is, so `head` stays the commit the
 * counts were last taken at and a green gate on a committed tree leaves the tree
 * clean. A file whose counts differ is rewritten, and `test/repo-facts.test.ts`
 * refuses to let the stale copy be committed.
 */
export function writeRepoFacts(outPath: string, options: { gate?: string } = {}): RepoFacts {
  const facts = repoFacts(options);
  const existing = readExisting(outPath);
  if (
    existing &&
    JSON.stringify(existing.counts) === JSON.stringify(facts.counts) &&
    (options.gate === undefined || existing.gate === options.gate)
  ) {
    console.log(
      `repo-facts: ${outPath} already holds these counts (head ${existing.head}); unchanged`,
    );
    return existing;
  }
  if (sh('git status --porcelain')) {
    console.warn(
      'repo-facts: the tree is dirty — counts are from the working tree while `head` is the last commit',
    );
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(facts, null, 2)}\n`);
  return facts;
}

function readExisting(path: string): RepoFacts | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RepoFacts;
  } catch {
    return undefined;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const flag = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const gate = flag('--gate');
  const facts = writeRepoFacts(resolve(root, flag('--out') ?? FACTS_PATH), gate ? { gate } : {});
  console.log(JSON.stringify(facts, null, 2));
}
