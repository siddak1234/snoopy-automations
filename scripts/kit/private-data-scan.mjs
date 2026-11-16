// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/private-data-scan.mjs
// The private-data scan (the owner's security review, 2026-11-15: "no pii in public repos
// ever"). `node scripts/kit/private-data-scan.mjs <--staged|--push|--tree|--history>`:
//   1 paths: no tracked `_salvage` path anywhere; in a public repository also no process
//     record (DESIGN-GAPS*.md, *round-record*.md, ROUND-*-OBSERVATIONS*.md, docs/audits/,
//     *.archive.md) — records live only in the private snoopy-backend;
//   2 client names: one case-insensitive ERE from $CLIENT_DENY_PATTERN (CI's secret), else
//     ~/.config/autom8x/client-deny-pattern (line 1 full names, every repository; line 2
//     short forms, public repositories only). --tree greps HEAD's files, --staged and --push
//     the added lines of their diffs, --history `git log -G`. Prints paths or commit ids,
//     never the text or the pattern — nor an error's text, which would quote it: a pattern git
//     refuses (the same search with a plain pattern works) is said in fixed words, any other
//     git failure by its exit code alone. No pattern:
//     CI fails (a fork's pull request is told it cannot be scanned; Dependabot, which gets no
//     secrets, is skipped with a notice); a machine warns once and skips (CI enforces);
//   3 gitleaks 8.30.1, pinned by sha256 and checked before extraction, with
//     private-data.toml (secrets) or private-data-public.toml (secrets and personal data).
//     The fetch and cache are shared: workflow-lint.mjs pins zizmor the same way.
//     Reviewed exceptions: the scanned repository's own .gitleaksignore (IGNORE_FILE), handed
//     to gitleaks by path (`--gitleaks-ignore-path`, so no other folder's file counts), one
//     exact fingerprint per line, `<commit>:<file>:<rule>:<line>` as a finding's Fingerprint
//     reads, with `#` comments: each silences that one finding of that one commit, so it
//     serves --history (an old commit's reviewed finding); a finding in the tree is fixed,
//     never listed. A line without its commit would silence that place in every commit, the
//     tree's included: any line not exact is refused (exit 2).
// Modes: --staged the index (pre-commit), --push origin/main..HEAD (pre-push), --tree the
// tracked files at HEAD (CI, local CI), --history every commit. Exit 0 clean, 1 findings,
// 2 usage or tool error. Public or private: docs/docs-map.json `repo`; only snoopy-backend
// is private, and an unknown name is public (the stricter rules).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
export const MODES = ['staged', 'push', 'tree', 'history'];
export const PRIVATE_REPOS = ['snoopy-backend'];
export const PATTERN_FILE = '.config/autom8x/client-deny-pattern';
export const GITLEAKS_VERSION = '8.30.1';
export const GITLEAKS_SHA256 = {
  darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
/** gitleaks' exit code for "leaks found", so any other non-zero code is the tool failing. */
export const LEAKS_EXIT = 99;
const SALVAGE = /_salvage/iu;
const RECORDS = [
  /(?:^|\/)DESIGN-GAPS[^/]*\.md$/u,
  /round-record[^/]*\.md$/u,
  /(?:^|\/)ROUND-[^/]*-OBSERVATIONS[^/]*\.md$/u,
  /^docs\/audits\//u,
  /\.archive\.md$/u,
];
/** The synthetic commit --tree hands gitleaks: fixed, so one tree is always one object. */
const TREE_COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'private-data-scan', GIT_AUTHOR_EMAIL: 'scan@example.invalid', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'private-data-scan', GIT_COMMITTER_EMAIL: 'scan@example.invalid', GIT_COMMITTER_DATE: '@0 +0000',
};

/** Pure: the mode an argument list names, or null (usage). */
export function parseMode(argv) {
  return argv.length === 1 && /^--\w+$/u.test(argv[0]) && MODES.includes(argv[0].slice(2)) ? argv[0].slice(2) : null;
}

/** Pure: whether a docs-map `repo` name is public; only the private list is not. */
export const isPublic = (repo) => !PRIVATE_REPOS.includes(repo);

/** Pure: the tracked paths that must not be: `_salvage` anywhere, records in a public repo. */
export function pathFindings(paths, publicRepo) {
  return paths.filter((path) => SALVAGE.test(path) || (publicRepo && RECORDS.some((rule) => rule.test(path))));
}

/**
 * Pure: whether this Actions run is a pull request from another repository — a fork's, which
 * GitHub gives no secrets: the event's head repository is not this one (or is gone).
 */
export function forkPullRequest(env, readFile) {
  if (!/^pull_request/u.test(env.GITHUB_EVENT_NAME ?? '') || !env.GITHUB_EVENT_PATH) return false;
  try {
    const head = JSON.parse(readFile(env.GITHUB_EVENT_PATH) ?? 'null')?.pull_request?.head;
    return head !== undefined && head?.repo?.full_name !== env.GITHUB_REPOSITORY;
  } catch {
    return false;
  }
}

/**
 * Pure: where the client-name pattern comes from. `{ pattern }`, or `{ skip: message }` (a
 * machine without the file, or Dependabot in CI), or `{ fail: message }` (CI without it: a
 * fork's pull request is told why, any other run to add the secret). `readFile(path)` returns
 * the text or null. A secret that is not set reaches CI as ''.
 */
export function patternSource({ env, home, readFile, publicRepo }) {
  const fromEnv = (env.CLIENT_DENY_PATTERN ?? '').trim();
  if (fromEnv) return { pattern: fromEnv };
  const lines = (readFile(join(home, PATTERN_FILE)) ?? '').split('\n').map((line) => line.trim());
  const parts = [lines[0], publicRepo ? lines[1] : ''].filter(Boolean);
  if (parts.length) return { pattern: parts.join('|') };
  if (env.GITHUB_ACTIONS === 'true') {
    if (env.GITHUB_ACTOR === 'dependabot[bot]') {
      return { skip: '::notice::client names not checked: Dependabot runs get no secrets; the owner’s next pull request checks them' };
    }
    if (forkPullRequest(env, readFile)) {
      return { fail: 'CLIENT_DENY_PATTERN is not available: a fork’s pull request gets no secrets, so its client names cannot be scanned here; the owner’s pushes to this repository are — push the branch here to scan it' };
    }
    return { fail: 'CLIENT_DENY_PATTERN is not set: add the repository secret (one ERE of the client names)' };
  }
  return { skip: `warning: client names not checked here — ~/${PATTERN_FILE} is missing (CI checks them)` };
}

/** What a pattern that does not compile says: a fixed text, since RegExp's and git's both quote it. */
export const PATTERN_ERROR = 'the client-name pattern could not be used: is it one valid ERE? (neither it nor the error is shown: both would print it)';

/** Pure: the ERE as a case-insensitive JS RegExp (POSIX classes and \< \> translated). */
export function ereToRegExp(ere) {
  const classes = { alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\r\\n\\v\\f', blank: ' \\t', xdigit: '0-9A-Fa-f', punct: '!-/:-@\\[-`{-~' };
  const source = ere
    .replace(/\[:(\w+):\]/gu, (whole, name) => classes[name] ?? whole)
    .replace(/\\[<>]/gu, '\\b');
  try {
    return new RegExp(source, 'i');
  } catch {
    throw new Error(PATTERN_ERROR);
  }
}

/** Pure: the added lines of `git diff -U0` or `git log -p -U0 --format=commit %H` output. */
export function addedLines(patch) {
  const out = [];
  let commit = '';
  let path = null;
  for (const line of patch.split('\n')) {
    if (/^commit [0-9a-f]{7,64}$/u.test(line)) [commit, path] = [line.slice(7), null];
    else if (line.startsWith('diff --git ')) path = null;
    else if (line.startsWith('+++ ')) path = line === '+++ /dev/null' ? null : line.slice(4).replace(/^"?b\//u, '').replace(/"$/u, '');
    else if (path !== null && line.startsWith('+')) out.push({ commit, path, text: line.slice(1) });
  }
  return out;
}

/** Pure: the release asset for a platform and CPU, or null where gitleaks pins none. */
export function gitleaksAsset(platform, arch) {
  const key = `${platform}_${arch}`;
  const sha256 = Object.hasOwn(GITLEAKS_SHA256, key) ? GITLEAKS_SHA256[key] : null;
  if (!sha256) return null;
  const name = `gitleaks_${GITLEAKS_VERSION}_${key}.tar.gz`;
  return { name, sha256, url: `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${name}` };
}

/** Pure: a pinned tool's cache — $RUNNER_TEMP under GitHub Actions, else ~/.cache/autom8x. */
export function toolCache(env, home, tool, version) {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_TEMP
    ? join(env.RUNNER_TEMP, `${tool}-${version}`)
    : join(home, '.cache/autom8x', tool, version);
}
export const gitleaksCache = (env, home) => toolCache(env, home, 'gitleaks', GITLEAKS_VERSION);

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * A pinned tool's binary, from an archive whose sha256 is the pinned one: a cached archive is
 * reused when its sum still matches, else downloaded and checked BEFORE it is written or
 * extracted. Only `binary` is extracted, fresh each run, so a changed binary never outlives the
 * run. `download(url)` resolves to bytes; `extract(archive, intoDir, binary)` writes
 * `intoDir/<binary>`. gitleaks here, zizmor in workflow-lint.mjs.
 */
export async function ensureBinary({ dir, asset, download, extract, binary }) {
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, asset.name);
  if (!(existsSync(archive) && sha256(readFileSync(archive)) === asset.sha256)) {
    const bytes = await download(asset.url);
    const got = sha256(bytes);
    if (got !== asset.sha256) {
      throw new Error(`refused ${asset.name}: sha256 ${got} is not the pinned ${asset.sha256}; nothing was extracted`);
    }
    const part = `${archive}.${process.pid}.part`;
    writeFileSync(part, bytes);
    renameSync(part, archive);
  }
  const fresh = mkdtempSync(join(dir, 'extract-'));
  try {
    extract(archive, fresh, binary);
    renameSync(join(fresh, binary), join(dir, binary));
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
  return join(dir, binary);
}

/** The reviewed exceptions' file, at the scanned repository's root (the header, 3). */
export const IGNORE_FILE = '.gitleaksignore';
const EXACT_FINGERPRINT = /^[0-9a-f]{40}:.+:[\w.-]+:\d+$/u;

/** Pure: the numbers of a .gitleaksignore's lines that are not one exact fingerprint (blank and `#` lines are fine). */
export function inexactIgnores(text) {
  return text.split('\n').flatMap((line, index) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#') && !EXACT_FINGERPRINT.test(trimmed) ? [index + 1] : [];
  });
}

/** Pure: gitleaks' arguments for a mode; `target` is the --push range or the --tree commit, `ignore` the exceptions' path. */
export function gitleaksArgs(mode, { config, report, target, source, ignore }) {
  const common = ['--redact', '--no-banner', '--config', config, '--gitleaks-ignore-path', ignore, '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT), '--log-level', 'error'];
  if (mode === 'staged') return ['git', '--pre-commit', '--staged', ...common, source];
  if (mode === 'push' || mode === 'tree') return ['git', `--log-opts=${target}`, ...common, source];
  if (mode === 'history') return ['git', ...common, source];
  throw new Error(`no gitleaks command for ${mode}`);
}

/** Pure: one line per finding — rule, path:line and (for commits) the short id; no value. */
export function findingLines(findings, mode) {
  return findings.map((f) => `  ${f.RuleID} ${f.File}:${f.StartLine}${mode === 'push' || mode === 'history' ? ` ${String(f.Commit).slice(0, 12)}` : ''}`);
}

/**
 * A command, its exit code checked against `allow`. `env` adds to this process's environment,
 * or with `inherit: false` is the whole of it. `quiet` keeps the command's stderr out of the
 * error, for a command whose stderr can quote the client-name pattern. The error's `status` is
 * the exit code (or the spawn error's code, ETIMEDOUT for a timeout). `spawn` is spawnSync's
 * shape, for the tests.
 */
export function run(command, args, { cwd, env, input, allow = [0], quiet = false, inherit = true, spawn = spawnSync } = {}) {
  const r = spawn(command, args, { cwd, env: inherit ? { ...process.env, ...env } : env, input, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 600000 });
  if (r.error || !allow.includes(r.status)) {
    const status = r.status ?? r.error?.code;
    // Its first two lines (what failed: zizmor names the workflow it could not load there) and its last.
    const said = (r.stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    const why = quiet ? 'its message is not shown' : (said.length > 3 ? [...said.slice(0, 2), '…', said.at(-1)] : said).join(' / ');
    throw Object.assign(new Error(`${command} ${args[0] ?? ''} ${args[1] ?? ''} failed (exit ${status}): ${why}`), { status });
  }
  return r;
}
const git = (root, args, opts) => run('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, ...opts });
const lines = (text) => text.split('\n').filter(Boolean);

/** origin/main..HEAD, or every commit no remote has when there is no origin/main. */
function pushRange(root) {
  const has = spawnSync('git', ['rev-parse', '--verify', '-q', 'origin/main^{commit}'], { cwd: root }).status === 0;
  return has ? ['origin/main..HEAD'] : ['HEAD', '--not', '--remotes'];
}

/** docs/docs-map.json's `repo`, committed at HEAD or else in the working tree; null (public) when neither reads. */
export function repoName(root) {
  for (const read of [() => git(root, ['show', 'HEAD:docs/docs-map.json']).stdout, () => readFileSync(join(root, 'docs/docs-map.json'), 'utf8')]) {
    try {
      return JSON.parse(read()).repo ?? null;
    } catch {
      // the next reader, then unknown (public)
    }
  }
  return null;
}

/** The tracked paths a mode checks: the index, HEAD, or every path any commit added. */
export function trackedPaths(root, mode) {
  if (mode === 'staged') return lines(git(root, ['ls-files']).stdout);
  if (mode === 'history') return [...new Set(lines(git(root, ['log', '--all', '--format=', '--name-only', '--diff-filter=AR']).stdout))];
  return lines(git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).stdout);
}

/** A pattern git always compiles: the probe that tells a refused pattern from git failing. */
const PLAIN_PATTERN = 'autom8x';

/** Paths (--tree, --staged), `<commit> <path>` (--push) or commit ids (--history) the pattern matches. */
export function nameFindings(root, mode, pattern) {
  // git's stderr can quote the pattern, so it is never shown. A failure is the pattern's when the
  // same search with a plain pattern works (the fixed PATTERN_ERROR); otherwise git failed (no
  // commit, a timeout, a broken repository), said by its exit code alone (30.19.13).
  const search = (args, opts) => {
    const attempt = (p) => git(root, args(p), { ...opts(p), quiet: true }).stdout;
    try {
      return attempt(pattern);
    } catch (error) {
      const verb = args(pattern)[0];
      let refused = false;
      if (error.status !== 'ETIMEDOUT') {
        try {
          attempt(PLAIN_PATTERN);
          refused = true;
        } catch {
          // git fails with any pattern: not the pattern's fault
        }
      }
      throw new Error(refused ? `git ${verb}: ${PATTERN_ERROR}` : `git ${verb} failed (exit ${error.status}); its message is not shown because it can quote the pattern`);
    }
  };
  if (mode === 'tree') {
    const found = search(() => ['grep', '-I', '-i', '-l', '-E', '-f', '-', 'HEAD', '--'], (p) => ({ input: `${p}\n`, allow: [0, 1] }));
    return lines(found).map((path) => path.replace(/^HEAD:/u, ''));
  }
  if (mode === 'history') return lines(search((p) => ['log', '--all', '-i', `-G${p}`, '--format=%H'], () => ({})));
  const regex = ereToRegExp(pattern);
  const diff = mode === 'staged'
    ? git(root, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv']).stdout
    : git(root, ['log', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--format=commit %H', ...pushRange(root)]).stdout;
  const hits = addedLines(diff).filter((added) => regex.test(added.text));
  return [...new Set(hits.map((hit) => (hit.commit ? `${hit.commit.slice(0, 12)} ${hit.path}` : hit.path)))];
}

export async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
/** One member of a .tar.gz, by its path inside the archive (zizmor's and gitleaks' sit at the top). */
export const extractMember = (archive, into, member) => run('tar', ['-xzf', archive, '-C', into, member]);

/**
 * The pinned gitleaks for this machine: cached, checksum-verified, fetched once. The scan and its
 * test share it; the tests inject the download, the platform and the CPU.
 */
export async function gitleaksBinary(env = process.env, home = homedir(), { fetchBytes = download, extract = extractMember, platform = process.platform, arch = process.arch } = {}) {
  const asset = gitleaksAsset(platform, arch);
  if (!asset) throw new Error(`gitleaks ${GITLEAKS_VERSION} is not pinned for ${platform}_${arch}`);
  return ensureBinary({ dir: gitleaksCache(env, home), asset, download: fetchBytes, extract, binary: 'gitleaks' });
}

/**
 * gitleaks' findings for a mode: the public config in a public repository, else the private one.
 * `binary()` resolves to its path and `spawn` runs it (spawnSync's shape) — the tests inject both.
 */
export async function gitleaks(root, mode, publicRepo, { binary = gitleaksBinary, spawn = spawnSync } = {}) {
  const bin = await binary();
  let target = '';
  if (mode === 'push') target = pushRange(root).join(' ');
  if (mode === 'tree') {
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
    target = git(root, ['commit-tree', '--no-gpg-sign', tree, '-m', 'private-data-scan: the tree at HEAD'], { env: TREE_COMMIT_ENV }).stdout.trim();
  }
  // From the kit's own repository root, which the public config's `[extend] path` is read from.
  const config = join(KIT, publicRepo ? 'private-data-public.toml' : 'private-data.toml');
  const ignore = join(root, IGNORE_FILE);
  const inexact = existsSync(ignore) ? inexactIgnores(readFileSync(ignore, 'utf8')) : [];
  if (inexact.length) {
    throw new Error(`${IGNORE_FILE} line ${inexact.join(', ')}: not one exact <commit>:<file>:<rule>:<line> fingerprint (without its commit it would silence that place in every commit)`);
  }
  const args = gitleaksArgs(mode, { config, report: '-', target, source: root, ignore });
  const r = run(bin, args, { cwd: resolve(KIT, '../..'), allow: [0, LEAKS_EXIT], spawn });
  const start = r.stdout.indexOf('[');
  return start < 0 ? [] : JSON.parse(r.stdout.slice(start));
}

/** The scan; `home`, `binary` and `spawn` are the tests' (gitleaks' path and its runner). Resolves to the exit code. */
export async function main(argv, { cwd = process.cwd(), env = process.env, out = console.log, home = homedir(), binary = () => gitleaksBinary(env, home), spawn = spawnSync } = {}) {
  const mode = parseMode(argv);
  if (!mode) {
    out('usage: node scripts/kit/private-data-scan.mjs <--staged|--push|--tree|--history>');
    return 2;
  }
  const say = (line) => out(`private-data-scan: ${line}`);
  let status = 0;
  const part = async (name, body) => {
    try {
      const found = await body();
      if (found.length) {
        status = Math.max(status, 1);
        say(`${name}: ${found.length} finding(s)`);
        for (const line of found) out(line.startsWith('  ') ? line : `  ${line}`);
      } else say(`${name}: clean`);
    } catch (error) {
      status = 2;
      say(`${name}: error — ${error.message}`);
    }
  };
  let root;
  try {
    root = run('git', ['rev-parse', '--show-toplevel'], { cwd }).stdout.trim();
  } catch {
    say('not inside a git repository');
    return 2;
  }
  const repo = repoName(root);
  const publicRepo = isPublic(repo);
  say(`--${mode} in ${repo ?? 'an unnamed repository'} (${publicRepo ? 'public' : 'private'})`);
  await part('paths', () => pathFindings(trackedPaths(root, mode), publicRepo));
  await part('client names', () => {
    const source = patternSource({ env, home, readFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null), publicRepo });
    if (source.fail) throw new Error(source.fail);
    if (source.skip) {
      out(source.skip);
      return [];
    }
    return nameFindings(root, mode, source.pattern);
  });
  await part('gitleaks', async () => findingLines(await gitleaks(root, mode, publicRepo, { binary, spawn }), mode));
  say(status === 0 ? 'PASS' : status === 1 ? 'FAIL — remove what is listed (values are never printed)' : 'ERROR — the scan could not finish');
  return status;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
