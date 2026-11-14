/**
 * The definition-file standard (Round 22, the platform's BUILD-PLAN 30.15.2): `manifests/` holds
 * the file of each flow's newest version, and the one before it only while that one may still be
 * served. The owner asked "is there  a way to ensure we are not duplicating efforts or items and
 * properly updating definition files based on standards?" (2026-11-14); rules D1–D8 are the
 * session's answer, pure functions here driven by `test/definition-files.test.ts` on the tree and
 * on scratch trees, as `test/file-required.ts` is.
 *
 * - D1 a file is named `<templateId>.v<n>.json`, says that id and version, and its flow folder
 *   exists: held where it always was, `test/architecture.test.ts`, which reads the top level of
 *   `manifests/` alone; here every tracked path under `manifests/` is such a name at the top
 *   level (no subfolder, no `.bak`, no leading zero), so no file there escapes D2–D8.
 * - D2 each flow's newest file is the one its Dockerfile copies; a file newer than that is a stray.
 * - D3 at most two files per flow.
 * - D4 a file at the base keeps its bytes: a change is a new `v<n+1>` file, never an edit (the
 *   platform's Flow CD refuses a served version whose bytes changed, its ADR-0047 §4.2).
 * - D5 a file leaves only when a newer version of its flow is in the tree, or its flow's folder
 *   left too, and the version's row in its flow's README ends `retired <yyyy-mm-dd>: <where
 *   shown>` (for a flow retired whole, a row of the root README whose first cell is `<id> v<n>`).
 * - D6 a name ever deleted on main never comes back, and a new file's version is above every
 *   version of its flow ever on main.
 * - D7 no copy: outside `manifests/`, no file is named `<id>.v<n>.json` for an id that is a flow.
 * - D8 against the base, at most one file is added per flow, and it is the Dockerfile's.
 *
 * What it cannot see: which version production serves and which is withdrawn. Nothing in
 * production reads these files (the hosts' register job mounts only their served copies; Flow
 * CD reads the file each Dockerfile copies at the merge, and a served version's bytes at its own
 * commit, from git), so a file may leave early with nothing changing there, and a withdrawn
 * version's file may stay until the next flows pull request after its `RETIRED` row, at the
 * latest the flow's next version (D3). A `retired` row is checked for its form; its truth is the
 * review's.
 */

import { execFileSync } from 'node:child_process';

import { lastCells } from './file-required.js';

/**
 * The base a change is read against: `git merge-base origin/main HEAD` on a branch or a pull
 * request, and `HEAD^1` when HEAD is origin/main (a push to main). A checkout without origin/main
 * fails, never passes: CI's Verify job checks out with `fetch-depth: 0`.
 */
export function base(root: string): string {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  let main: string;
  try {
    main = git('rev-parse', '--verify', '--quiet', 'origin/main^{commit}');
  } catch {
    throw new Error('origin/main is missing: fetch it (CI checks out with fetch-depth: 0)');
  }
  const head = git('rev-parse', 'HEAD');
  return head === main ? git('rev-parse', 'HEAD^1') : git('merge-base', main, head);
}

/**
 * The commit whose `manifests/` last held every retired version's file: the base of the change
 * that removed them (BUILD-PLAN 30.15.2). Git keeps them; a suite that still runs a retired
 * version's code reads its file from here (`retiredFile`).
 */
export const RETIRED_AT = '30d6798df2817e0b97ad4a7a26b70b018273eef7';

/** A retired version's manifest file, as committed, read from git at `RETIRED_AT`. */
export function retiredFile(root: string, name: string): string {
  return execFileSync('git', ['show', `${RETIRED_AT}:manifests/${name}`], {
    cwd: root,
    encoding: 'utf8',
  });
}

/** `<templateId>.v<n>.json`: the id and the version, or undefined for any other name. */
export function parseName(name: string): { id: string; version: number } | undefined {
  const named = /^(?<id>[a-z][a-z0-9-]*[a-z0-9])\.v(?<version>[1-9][0-9]*)\.json$/u.exec(
    name,
  )?.groups;
  return named === undefined ? undefined : { id: named.id!, version: Number(named.version) };
}

/** The repository as the rules read it; every name under `manifests/` is a bare file name. */
export interface Tree {
  /** The files in `manifests/` now. */
  readonly manifests: readonly string[];
  /** The flow folders, `automations/<id>`. */
  readonly flows: readonly string[];
  /** Of each flow, the `manifests/` files its Dockerfile copies (`imageManifests`). */
  readonly copies: ReadonlyMap<string, readonly string[]>;
  /** Each flow's README text, and `''` for the root README. */
  readonly readmes: ReadonlyMap<string, string>;
  /** Every tracked path (D7). */
  readonly tracked: readonly string[];
}

/** What changed against the base, and what main ever held (D4–D6, D8). */
export interface History {
  /** The base's `manifests/` files and their blob ids. */
  readonly base: ReadonlyMap<string, string>;
  /** The tree's `manifests/` files and their blob ids. */
  readonly head: ReadonlyMap<string, string>;
  /** Every `manifests/` file name ever deleted on main. */
  readonly deletedOnMain: readonly string[];
  /** Every `manifests/` file name main ever held, up to the base. */
  readonly everOnMain: readonly string[];
}

/** The manifest files a Dockerfile copies into its image, as written there, `manifests/` dropped. */
export function imageManifests(dockerfile: string): string[] {
  return dockerfile
    .split('\n')
    .filter((line) => /^COPY\b/u.test(line))
    .flatMap((line) => line.split(/\s+/u).filter((word) => word.startsWith('manifests/')))
    .filter((path) => path !== 'manifests/')
    .map((path) => path.slice('manifests/'.length))
    .sort();
}

/** Each flow's versions among the names given, ascending. */
function versionsByFlow(names: readonly string[]): Map<string, number[]> {
  const byFlow = new Map<string, number[]>();
  for (const name of names) {
    const parsed = parseName(name);
    if (parsed === undefined) continue;
    byFlow.set(parsed.id, [...(byFlow.get(parsed.id) ?? []), parsed.version]);
  }
  for (const versions of byFlow.values()) versions.sort((a, b) => a - b);
  return byFlow;
}

/** D1's tracked paths, D2, D3 and D7: what the tree alone refuses. */
export function treeProblems(tree: Tree): string[] {
  const problems: string[] = [];
  for (const path of tree.tracked) {
    if (!path.startsWith('manifests/')) continue;
    const name = path.slice('manifests/'.length);
    if (parseName(name) === undefined) {
      problems.push(
        `D1 ${path} is not a top-level manifests/<templateId>.v<n>.json: a file there the ` +
          `other rules cannot read`,
      );
    }
  }
  for (const [id, versions] of versionsByFlow(tree.manifests)) {
    if (!tree.flows.includes(id)) continue; // D1's, in test/architecture.test.ts
    const newest = `${id}.v${versions.at(-1)}.json`;
    const copied = tree.copies.get(id) ?? [];
    if (copied.length !== 1 || copied[0] !== newest) {
      problems.push(
        `D2 manifests/${newest} is ${id}'s newest file, and automations/${id}/Dockerfile copies ` +
          `${copied.length === 0 ? 'none' : copied.map((name) => `manifests/${name}`).join(', ')}: ` +
          `the newest file is the one deployed next`,
      );
    }
    if (versions.length > 2) {
      problems.push(
        `D3 ${id} has ${versions.length} files (v${versions.join(', v')}): at most the newest and ` +
          `the one before it; remove a retired version's file with its README row`,
      );
    }
  }
  for (const path of tree.tracked) {
    if (path.startsWith('manifests/')) continue;
    const parsed = parseName(path.split('/').at(-1)!);
    if (parsed !== undefined && tree.flows.includes(parsed.id)) {
      problems.push(
        `D7 ${path} is named as ${parsed.id}'s definition file: it lives in manifests/`,
      );
    }
  }
  return problems;
}

/**
 * The `retired <yyyy-mm-dd>: <where shown>` a README gives on a version's row: a table row whose
 * first cell is `first` (backticks aside) and whose last cell has that form.
 */
export function retiredRow(readme: string, first: string): string | undefined {
  return lastCells(readme, first).find((cell) => {
    const day = /^retired (?<day>\d{4}-\d{2}-\d{2}): \S/u.exec(cell)?.groups?.day;
    return day !== undefined && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
  });
}

/** D4, D5, D6 and D8: what the change against the base refuses. */
export function changeProblems(tree: Tree, history: History): string[] {
  const problems: string[] = [];
  const now = versionsByFlow([...history.head.keys()]);
  const ever = versionsByFlow(history.everOnMain);
  const added = new Map<string, string[]>();
  for (const [name, blob] of history.base) {
    const kept = history.head.get(name);
    if (kept !== undefined) {
      if (kept !== blob) {
        problems.push(`D4 manifests/${name} differs from the base: a change is a new v<n+1> file`);
      }
      continue;
    }
    const parsed = parseName(name);
    if (parsed === undefined) continue;
    const gone = !tree.flows.includes(parsed.id);
    if (!gone && !(now.get(parsed.id) ?? []).some((version) => version > parsed.version)) {
      problems.push(
        `D5 manifests/${name} is deleted with no newer ${parsed.id} file in the tree: ` +
          `only a version a newer one replaced, or a flow retired whole, leaves`,
      );
    }
    const readme = tree.readmes.get(gone ? '' : parsed.id) ?? '';
    const first = gone ? `${parsed.id} v${parsed.version}` : `v${parsed.version}`;
    if (retiredRow(readme, first) === undefined) {
      problems.push(
        `D5 manifests/${name} is deleted, and ${gone ? 'README.md' : `automations/${parsed.id}/README.md`} ` +
          `has no row "| ${first} | … | retired <yyyy-mm-dd>: <where shown> |"`,
      );
    }
  }
  for (const name of history.head.keys()) {
    if (history.base.has(name)) continue;
    const parsed = parseName(name);
    if (parsed === undefined) continue;
    added.set(parsed.id, [...(added.get(parsed.id) ?? []), name]);
    if (history.deletedOnMain.includes(name)) {
      problems.push(`D6 manifests/${name} was deleted on main: a retired version never comes back`);
    }
    const highest = Math.max(0, ...(ever.get(parsed.id) ?? []));
    if (parsed.version <= highest) {
      problems.push(
        `D6 manifests/${name} is v${parsed.version}, and main held ${parsed.id} v${highest}: ` +
          `a new file's version is above every one its flow ever had`,
      );
    }
  }
  for (const [id, names] of added) {
    if (names.length > 1) {
      problems.push(
        `D8 ${names.map((name) => `manifests/${name}`).join(', ')} are added together: ` +
          `one new ${id} file a change`,
      );
    }
    const copied = tree.copies.get(id) ?? [];
    for (const name of names) {
      if (!copied.includes(name)) {
        problems.push(
          `D8 manifests/${name} is added, and automations/${id}/Dockerfile does not copy it: ` +
            `an added file is the one deployed next`,
        );
      }
    }
  }
  return problems;
}
