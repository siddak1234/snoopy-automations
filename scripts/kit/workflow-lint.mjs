// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/workflow-lint.mjs
// The workflows' lint (the owner's security review, 2026-11-15: "scanner, safe, not bulky";
// the prevention plan's "zizmor in CI: every workflow declares its permissions").
// `node scripts/kit/workflow-lint.mjs` runs zizmor 1.32.0 over .github/workflows/:
//   - the binary is pinned by sha256 per platform, fetched and cached exactly as the
//     private-data scan's gitleaks (`ensureBinary`: the archive checked before it is written or
//     extracted), in ~/.cache/autom8x/zizmor/1.32.0/ or $RUNNER_TEMP under Actions;
//   - it runs OFFLINE: --offline, and GH_TOKEN, GITHUB_TOKEN and ZIZMOR_GITHUB_TOKEN taken out
//     of its environment, so no audit reaches GitHub and no token reaches the tool;
//   - the repository's own .github/zizmor.yml (CONFIG) is its config when there is one (each ignore
//     there carries its reason), else zizmor's defaults; an inline `# zizmor: ignore[rule]`
//     with its reason works too.
// Prints one line per finding (rule, severity, path:line) and the count by rule. Exit 0 clean,
// 1 findings, 2 usage or tool error.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
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

/** Pure: zizmor's arguments: offline, JSON, quiet, the config when the repository has one. */
export function zizmorArgs({ config }) {
  return ['--offline', '--format', 'json', '--no-progress', '--quiet', ...(config ? ['--config', config] : ['--no-config']), WORKFLOWS];
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

/** The lint; `home`, `binary` and `spawn` are the tests' (zizmor's path and its runner). Resolves to the exit code. */
export async function main(argv, { cwd = process.cwd(), env = process.env, out = console.log, home = homedir(), binary = () => zizmorBinary(env, home), spawn = spawnSync } = {}) {
  const say = (line) => out(`workflow-lint: ${line}`);
  if (argv.length) {
    out('usage: node scripts/kit/workflow-lint.mjs');
    return 2;
  }
  try {
    const root = run('git', ['rev-parse', '--show-toplevel'], { cwd }).stdout.trim();
    if (!existsSync(join(root, WORKFLOWS))) throw new Error(`no ${WORKFLOWS} in ${relative(cwd, root) || '.'}`);
    const config = existsSync(join(root, CONFIG)) ? CONFIG : null;
    const bin = await binary();
    const r = run(bin, zizmorArgs({ config }), { cwd: root, env: offlineEnv(env), inherit: false, allow: [0, ...FINDINGS_EXITS], spawn });
    const findings = readFindings(r.stdout.trim() || '[]');
    say(`zizmor ${ZIZMOR_VERSION}, offline, over ${WORKFLOWS}/ (${config ? `config ${CONFIG}` : 'no config'})`);
    if (!findings.length) {
      say('PASS');
      return 0;
    }
    say(`${findings.length} finding(s)`);
    for (const line of summary(findings)) out(line);
    say('FAIL — fix each by its rule (https://docs.zizmor.sh/audits/), or ignore it in .github/zizmor.yml with its reason');
    return 1;
  } catch (error) {
    say(`ERROR — ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
