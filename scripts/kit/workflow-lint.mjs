// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/workflow-lint.mjs
// The workflows' lint (the owner's security review, 2026-11-15: "scanner, safe, not bulky";
// the prevention plan's "zizmor in CI: every workflow declares its permissions").
// `node scripts/kit/workflow-lint.mjs` runs zizmor 1.32.0 over the working tree's
// .github/workflows/; `--commit <sha>` over that commit's, and `--pre-push` over each commit a
// push names (pre-push's stdin: one `<local ref> <local sha> <remote ref> <remote sha>` line per
// ref; each local sha once, a deletion's zeros skipped) — so a hook judges what is pushed, never
// the working tree, which a dirty change could make pass a bad commit or fail a good one
// (BUILD-PLAN 30.19.15). A commit's .github/ is read from git's objects (`ls-tree`, `cat-file`;
// no attribute can leave a file out) into a temporary folder, removed after, and its own
// .github/zizmor.yml is the config: each regular file's bytes as committed, never re-encoded; a
// symlink or a submodule there is named in the output, not linted (git holds a link's target, or a
// submodule's commit, not a file). A commit with no .github/workflows entry is exit 2 under
// `--commit`; under `--pre-push` such a tip (an orphan branch, a tag on an old commit) has nothing to
// lint and counts clean. A .github/workflows with entries but no file among them (only symlinks or
// submodules) is exit 2 either way, naming them: it fails closed (BUILD-PLAN 30.19.20).
//   - the binary is pinned by sha256 per platform, fetched and cached exactly as the
//     private-data scan's gitleaks (`ensureBinary`: the archive checked before it is written or
//     extracted), in ~/.cache/autom8x/zizmor/1.32.0/ or $RUNNER_TEMP under Actions;
//   - it runs OFFLINE: --offline, and GH_TOKEN, GITHUB_TOKEN and ZIZMOR_GITHUB_TOKEN taken out
//     of its environment, so no audit reaches GitHub and no token reaches the tool;
//   - it fails closed: --strict-collection, so a workflow zizmor cannot load (a syntax or schema
//     error) fails the lint (exit 2) instead of being skipped with a warning while it says PASS
//     (BUILD-PLAN 30.19.14);
//   - the repository's own .github/zizmor.yml (CONFIG) is its config when there is one (each ignore
//     there carries its reason), else zizmor's defaults; an inline `# zizmor: ignore[rule]`
//     with its reason works too.
// Prints one line per finding (rule, severity, path:line) and the count by rule. Exit 0 clean,
// 1 findings, 2 usage or tool error.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, ensureBinary, extractMember, run, toolCache } from './private-data-scan.mjs';

export const ZIZMOR_VERSION = '1.32.0';
/** GitHub's recorded sha256 of each release asset, by Node's platform and CPU. */
export const ZIZMOR_ASSETS = {
  darwin_arm64: ['aarch64-apple-darwin', '6efed18c4539a663fd3c851a2be9533fd8456c4e646d9416206da059154a0d3c'],
  darwin_x64: ['x86_64-apple-darwin', '6983143c719ada6845a69cc4dd2bacc215f971662fecd8bbd2678388e5ce5969'],
  linux_arm64: ['aarch64-unknown-linux-gnu', 'cb152b207f815116d7fa1c1ee4614f61578803351395052908095e79adfd9fd0'],
  linux_x64: ['x86_64-unknown-linux-gnu', 'bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b'],
};
/** The variables zizmor would read a GitHub token from: none reaches it, nor any other ZIZMOR_ setting. */
export const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'ZIZMOR_GITHUB_TOKEN'];
export const WORKFLOWS = '.github/workflows';
export const CONFIG = '.github/zizmor.yml';
/** zizmor's exit codes when it found something: 10 plus the highest severity (unknown to high). */
const FINDINGS_EXITS = [10, 11, 12, 13, 14];

/** Pure: the release asset for a platform and CPU, or null where zizmor is pinned for none. */
export function zizmorAsset(platform, arch) {
  const key = `${platform}_${arch}`;
  if (!Object.hasOwn(ZIZMOR_ASSETS, key)) return null;
  const [triple, sha256] = ZIZMOR_ASSETS[key];
  const name = `zizmor-${triple}.tar.gz`;
  return { name, sha256, url: `https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}/${name}` };
}

export const zizmorCache = (env, home) => toolCache(env, home, 'zizmor', ZIZMOR_VERSION);

/** Pure: the child's environment — this one without a GitHub token or a ZIZMOR_ variable (the flags decide). */
export function offlineEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !TOKEN_VARIABLES.includes(key) && !key.startsWith('ZIZMOR_')));
}

/** Pure: zizmor's arguments: offline, JSON, quiet, an input it cannot load an error, the config when the repository has one. */
export function zizmorArgs({ config }) {
  return ['--offline', '--format', 'json', '--no-progress', '--quiet', '--strict-collection', ...(config ? ['--config', config] : ['--no-config']), WORKFLOWS];
}

export const USAGE = 'usage: node scripts/kit/workflow-lint.mjs [--commit <sha> | --pre-push]';
const HEX = /^[0-9a-f]{7,64}$/u;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Pure: what to lint — `{ tree: true }`, `{ commit }` or `{ prePush: true }` — or null (usage). */
export function parseArguments(argv) {
  if (argv.length === 0) return { tree: true };
  if (argv.length === 1 && argv[0] === '--pre-push') return { prePush: true };
  if (argv.length === 2 && argv[0] === '--commit' && HEX.test(argv[1])) return { commit: argv[1] };
  return null;
}

/** Pure: the commits pre-push's stdin names — each line's local sha, once; a deletion (all zeros) skipped. */
export function pushedCommits(stdin) {
  const commits = [];
  for (const line of stdin.split('\n').map((each) => each.trim()).filter(Boolean)) {
    const words = line.split(/\s+/u);
    if (words.length !== 4 || !OBJECT_ID.test(words[1])) throw new Error('pre-push: a line that is not "<local ref> <local sha> <remote ref> <remote sha>"');
    if (!/^0+$/u.test(words[1]) && !commits.includes(words[1])) commits.push(words[1]);
  }
  return commits;
}

/** The tree entries under .github/ that are not files, by git's mode: named in the output, never linted. */
export const SKIPPED_MODES = { 120000: 'a symlink', 160000: 'a submodule' };
const REGULAR = ['100644', '100755'];

/** A blob's bytes as committed: no encoding, so a byte that is not UTF-8 is never rewritten. */
function blobBytes(root, object) {
  const r = spawnSync('git', ['cat-file', 'blob', object], { cwd: root, maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) throw new Error(`git cat-file blob ${object} failed (exit ${r.status ?? r.error?.code})`);
  return r.stdout;
}

/**
 * A commit's .github/, read from git's objects into a new temporary folder (the caller removes it):
 * every regular file, its bytes as committed. `skipped` names each entry that is not a file
 * (`<path> (a symlink)`). `dir` is null, and no folder made, when .github/workflows has no entry;
 * throws when it has entries and none is a file, since nothing there could be linted.
 */
export function commitGithub(root, commit) {
  let sha;
  try {
    sha = run('git', ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { cwd: root }).stdout.trim();
  } catch {
    throw new Error(`${commit} is not a commit in this repository`);
  }
  const entries = run('git', ['ls-tree', '-r', '-z', '--full-tree', sha, '--', '.github'], { cwd: root }).stdout.split('\0').filter(Boolean)
    .map((entry) => ({ meta: entry.slice(0, entry.indexOf('\t')).split(' '), path: entry.slice(entry.indexOf('\t') + 1) }));
  const files = entries.filter(({ meta: [mode] }) => REGULAR.includes(mode));
  const skipped = entries.filter(({ meta: [mode] }) => !REGULAR.includes(mode)).map(({ meta: [mode], path }) => `${path} (${SKIPPED_MODES[mode] ?? `mode ${mode}`})`);
  const inWorkflows = ({ path }) => path.startsWith(`${WORKFLOWS}/`);
  if (!entries.some(inWorkflows)) return { dir: null, sha, skipped };
  if (!files.some(inWorkflows)) throw new Error(`${WORKFLOWS} at ${sha.slice(0, 12)} holds no file to lint: ${skipped.filter((entry) => entry.startsWith(`${WORKFLOWS}/`)).join(', ')}`);
  const dir = mkdtempSync(join(tmpdir(), 'autom8x-workflow-lint-'));
  try {
    for (const { meta: [, , object], path } of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), blobBytes(root, object));
    }
    return { dir, sha, skipped };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Pure: zizmor's JSON findings as `{ rule, severity, path, line }` — the primary location's file
 * and 1-based line; an ignored one left out. Never the YAML it quotes (`feature`).
 */
export function readFindings(json) {
  return JSON.parse(json)
    .filter((finding) => !finding.ignored)
    .map((finding) => {
      const primary = finding.locations?.find((at) => at.symbolic?.kind === 'Primary') ?? finding.locations?.[0];
      const key = primary?.symbolic?.key?.Local ?? {};
      return {
        rule: finding.ident,
        severity: String(finding.determinations?.severity ?? 'unknown').toLowerCase(),
        path: key.verbatim_path ?? key.given_path ?? '?',
        line: (primary?.concrete?.location?.start_point?.row ?? -1) + 1,
      };
    });
}

/** Pure: one line per finding, then the count by rule. */
export function summary(findings) {
  const byRule = new Map();
  for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
  return [
    ...findings.map((f) => `  ${f.rule} (${f.severity}) ${f.path}:${f.line}`),
    `  by rule: ${[...byRule].sort(([a], [b]) => a.localeCompare(b)).map(([rule, n]) => `${rule} ${n}`).join(', ')}`,
  ];
}

/** The pinned zizmor for this machine: cached, checksum-verified, fetched once. Tests inject the download. */
export async function zizmorBinary(env = process.env, home = homedir(), { fetchBytes = download, extract = extractMember, platform = process.platform, arch = process.arch } = {}) {
  const asset = zizmorAsset(platform, arch);
  if (!asset) throw new Error(`zizmor ${ZIZMOR_VERSION} is not pinned for ${platform}_${arch}`);
  return ensureBinary({ dir: zizmorCache(env, home), asset, download: fetchBytes, extract, binary: 'zizmor' });
}

/** zizmor over `dir`'s .github/workflows/, `where` naming it in the output. Returns 0 clean or 1 findings; throws on a tool error. */
function lintDir(dir, where, { bin, env, spawn, out, say }) {
  const config = existsSync(join(dir, CONFIG)) ? CONFIG : null;
  const r = run(bin, zizmorArgs({ config }), { cwd: dir, env: offlineEnv(env), inherit: false, allow: [0, ...FINDINGS_EXITS], spawn });
  const findings = readFindings(r.stdout.trim() || '[]');
  say(`zizmor ${ZIZMOR_VERSION}, offline, over ${WORKFLOWS}/ ${where} (${config ? `config ${CONFIG}` : 'no config'})`);
  if (!findings.length) {
    say('PASS');
    return 0;
  }
  say(`${findings.length} finding(s)`);
  for (const line of summary(findings)) out(line);
  say('FAIL — fix each by its rule (https://docs.zizmor.sh/audits/), or ignore it in .github/zizmor.yml with its reason');
  return 1;
}

/**
 * The lint; `home`, `binary` and `spawn` are the tests' (zizmor's path and its runner), `stdin` the
 * pre-push ref lines' reader. Resolves to the exit code: the worst of the commits linted.
 */
export async function main(argv, { cwd = process.cwd(), env = process.env, out = console.log, home = homedir(), binary = () => zizmorBinary(env, home), spawn = spawnSync, stdin = () => readFileSync(0, 'utf8') } = {}) {
  const say = (line) => out(`workflow-lint: ${line}`);
  const target = parseArguments(argv);
  if (!target) {
    out(USAGE);
    return 2;
  }
  const made = [];
  try {
    const root = run('git', ['rev-parse', '--show-toplevel'], { cwd }).stdout.trim();
    const commits = target.tree ? [] : target.commit ? [target.commit] : pushedCommits(stdin());
    if (target.tree && !existsSync(join(root, WORKFLOWS))) throw new Error(`no ${WORKFLOWS} in ${relative(cwd, root) || '.'}`);
    if (target.prePush && commits.length === 0) {
      say('PASS — the push names no commit');
      return 0;
    }
    const places = target.tree ? [{ dir: root, where: 'in the working tree' }] : commits.flatMap((commit) => {
      const { dir, sha, skipped } = commitGithub(root, commit);
      const at = `at ${sha.slice(0, 12)}`;
      for (const entry of skipped) say(`${at}: not linted, ${entry}`);
      if (!dir) {
        if (target.commit) throw new Error(`no ${WORKFLOWS} at ${sha.slice(0, 12)}`);
        say(`${at}: no ${WORKFLOWS} file, nothing to lint — clean`);
        return [];
      }
      made.push(dir);
      return [{ dir, where: at }];
    });
    if (places.length === 0) return 0;
    const bin = await binary();
    let status = 0;
    for (const { dir, where } of places) status = Math.max(status, lintDir(dir, where, { bin, env, spawn, out, say }));
    return status;
  } catch (error) {
    say(`ERROR — ${error.message}`);
    return 2;
  } finally {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
