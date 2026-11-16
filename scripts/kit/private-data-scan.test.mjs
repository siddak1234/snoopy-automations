// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/private-data-scan.test.mjs
// The private-data scan's tests, imported by kit.test.mjs, so every repository's runner runs them.
// Pure functions first; then the client-name search in scratch git repos (no download); then the
// reviewed exceptions of a .gitleaksignore, --history run whole on the real gitleaks; then the
// public config's personal-data rules, read from the TOML and run in JS on fixtures built at run
// time by concatenation, so this file never holds a value its own rules would find. The last
// check runs the real gitleaks on those fixtures. The real gitleaks is the pinned, checksum-verified
// binary the scan itself uses (cached; fetched once, as CI's scan step fetches it), never skipped — a
// gate that refuses skipped tests counts it like every other.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GIT, GIT_REPO, outsideGitRepo, quietEnv } from './guard-cases.test.mjs';
import {
  addedLines, ensureBinary, ereToRegExp, findingLines, gitleaksArgs, gitleaksAsset, gitleaksBinary, gitleaksCache, GITLEAKS_VERSION,
  IGNORE_FILE, inexactIgnores, isPublic, LEAKS_EXIT, main, nameFindings, parseMode, PATTERN_FILE, pathFindings, patternSource, sha256,
} from './private-data-scan.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));
const AT = '@';
let TMP;
before(() => (TMP = mkdtempSync(join(tmpdir(), 'autom8x-kit-scan-'))));
after(() => rmSync(TMP, { recursive: true, force: true }));

describe('private-data scan: the pure parts', () => {
  test('a mode is one of four flags, alone', () => {
    for (const mode of ['staged', 'push', 'tree', 'history']) assert.equal(parseMode([`--${mode}`]), mode);
    for (const bad of [[], ['--tree', '--push'], ['tree'], ['--all'], ['-tree']]) assert.equal(parseMode(bad), null, bad.join(' '));
  });

  test('only snoopy-backend is private; the three public repositories and an unknown name are public', () => {
    assert.equal(isPublic('snoopy-backend'), false);
    for (const repo of ['snoopy', 'snoopy-mobile', 'snoopy-automations', null, 'other']) assert.equal(isPublic(repo), true, String(repo));
  });

  test('a _salvage path fails everywhere; a process record fails only in a public repository', () => {
    const records = ['DESIGN-GAPS.md', 'DESIGN-GAPS.archive.md', 'docs/records/round-record.md', 'ROUND-7.5-OBSERVATIONS.md', 'docs/audits/x.md', 'AGENTS.archive.md'];
    const fine = ['README.md', 'app/page.tsx', 'docs/platform/BUILD-PLAN.md', 'design-gaps.ts', 'docs/audit.md'];
    assert.deepEqual(pathFindings(['_salvage/a.json', 'x/My_Salvage/b', ...fine], false), ['_salvage/a.json', 'x/My_Salvage/b']);
    assert.deepEqual(pathFindings([...records, ...fine], true), records);
    assert.deepEqual(pathFindings([...records, ...fine], false), []);
  });

  test('the client-name pattern: the secret first, else the file (short forms only in public), else fail in CI, skip for Dependabot, warn on a machine', () => {
    const file = (text) => (path) => (path === join('/h', PATTERN_FILE) ? text : null);
    const src = (env, text, publicRepo = true) => patternSource({ env, home: '/h', readFile: file(text), publicRepo });
    assert.deepEqual(src({ CLIENT_DENY_PATTERN: ' one|two \n' }, 'x\ny\n'), { pattern: 'one|two' });
    assert.deepEqual(src({ CLIENT_DENY_PATTERN: '' }, 'full a|full b\nshort\n'), { pattern: 'full a|full b|short' });
    assert.deepEqual(src({}, 'full a|full b\nshort\n', false), { pattern: 'full a|full b' });
    assert.match(src({ GITHUB_ACTIONS: 'true', CLIENT_DENY_PATTERN: '' }, null).fail, /CLIENT_DENY_PATTERN is not set/u);
    assert.match(src({ GITHUB_ACTIONS: 'true', GITHUB_ACTOR: 'dependabot[bot]' }, null).skip, /^::notice::.*Dependabot/u);
    const local = src({}, null);
    assert.equal(local.pattern, undefined);
    assert.ok(local.skip.includes(`~/${PATTERN_FILE}`) && !local.skip.includes('/h/'), local.skip);
  });

  test('the ERE becomes a case-insensitive JS RegExp, POSIX classes and word edges translated', () => {
    const re = ereToRegExp('(^|[^[:alnum:]])acme([^[:alnum:]]|$)|\\<zeta\\>');
    for (const yes of ['ACME co', 'x-acme', 'the Zeta.']) assert.equal(re.test(yes), true, yes);
    for (const no of ['acmes', 'xacme', 'zetas']) assert.equal(re.test(no), false, no);
  });

  test('added lines: only "+" lines of the files a diff adds to, with the commit they came in', () => {
    const patch = ['commit 1111111111111111111111111111111111111111', 'diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1 +1 @@', '-old', '+new a',
      'diff --git a/gone.md b/gone.md', '--- a/gone.md', '+++ /dev/null', '-x', 'commit 2222222222222222222222222222222222222222',
      'diff --git a/c d.md b/c d.md', '+++ b/c d.md', '+++plus', '+'].join('\n');
    assert.deepEqual(addedLines(patch), [
      { commit: '1111111111111111111111111111111111111111', path: 'a.md', text: 'new a' },
      { commit: '2222222222222222222222222222222222222222', path: 'c d.md', text: '++plus' },
      { commit: '2222222222222222222222222222222222222222', path: 'c d.md', text: '' },
    ]);
  });

  test('gitleaks is pinned for four platforms, cached in RUNNER_TEMP under Actions, else ~/.cache/autom8x', () => {
    for (const key of ['darwin_arm64', 'darwin_x64', 'linux_arm64', 'linux_x64']) {
      const asset = gitleaksAsset(...key.split('_'));
      assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
      assert.equal(asset.url, `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${key}.tar.gz`);
    }
    assert.equal(gitleaksAsset('win32', 'x64'), null);
    assert.equal(gitleaksCache({ GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/rt' }, '/h'), `/rt/gitleaks-${GITLEAKS_VERSION}`);
    assert.equal(gitleaksCache({}, '/h'), `/h/.cache/autom8x/gitleaks/${GITLEAKS_VERSION}`);
  });

  test('each mode maps to its gitleaks command, redacted, bannerless, with the kit config and the repository’s exceptions by path', () => {
    const o = { config: '/k/c.toml', report: '-', target: 'T', source: '/r', ignore: '/r/.gitleaksignore' };
    const common = ['--redact', '--no-banner', '--config', '/k/c.toml', '--gitleaks-ignore-path', '/r/.gitleaksignore', '--report-format', 'json', '--report-path', '-', '--exit-code', String(LEAKS_EXIT), '--log-level', 'error', '/r'];
    assert.deepEqual(gitleaksArgs('staged', o), ['git', '--pre-commit', '--staged', ...common]);
    assert.deepEqual(gitleaksArgs('push', o), ['git', '--log-opts=T', ...common]);
    assert.deepEqual(gitleaksArgs('tree', o), ['git', '--log-opts=T', ...common]);
    assert.deepEqual(gitleaksArgs('history', o), ['git', ...common]);
    assert.throws(() => gitleaksArgs('all', o), /no gitleaks command/u);
  });

  test('a reviewed exception is one exact commit:file:rule:line; a line without its commit is refused (30.19.16)', () => {
    const commit = 'a'.repeat(40);
    assert.deepEqual(inexactIgnores(['# reviewed 2026-11-16', '', `${commit}:docs/a b.md:autom8x-email:12`, `${commit}:x:y.md:generic-api-key:3`].join('\n')), []);
    const bad = ['docs/a.md:autom8x-email:12', `${commit.slice(1)}:a.md:r:1`, `${commit}:a.md:r`, `${commit}:a.md:r:one`, 'anything'];
    assert.deepEqual(inexactIgnores(['# ok', ...bad].join('\n')), [2, 3, 4, 5, 6]);
  });

  test('a finding prints its rule, path and line (and commit), never its value', () => {
    const f = { RuleID: 'r', File: 'a/b.ts', StartLine: 3, Commit: 'abcdef1234567890', Secret: 'S3CR3T-VALUE', Match: 'k=S3CR3T-VALUE' };
    assert.deepEqual(findingLines([f], 'tree'), ['  r a/b.ts:3']);
    assert.deepEqual(findingLines([f], 'history'), ['  r a/b.ts:3 abcdef123456']);
  });

  test('a download whose sha256 is not the pinned one is refused before anything is written or extracted', async () => {
    const dir = join(TMP, 'cache-bad');
    const bytes = Buffer.from('not the release');
    let extracted = 0;
    const asset = { name: 'g.tar.gz', sha256: '0'.repeat(64), url: 'https://example.invalid/g.tar.gz' };
    await assert.rejects(ensureBinary({ dir, asset, download: async () => bytes, extract: () => extracted++, binary: 'gitleaks' }), /refused g\.tar\.gz: sha256 [0-9a-f]{64} is not the pinned 0{64}/u);
    assert.equal(extracted, 0);
    assert.equal(existsSync(join(dir, 'g.tar.gz')), false);
  });

  test('a verified download is kept and reused; the binary is extracted fresh from it every run', async () => {
    const dir = join(TMP, 'cache-good');
    const bytes = Buffer.from('a pinned release');
    const asset = { name: 'g.tar.gz', sha256: sha256(bytes), url: 'https://example.invalid/g.tar.gz' };
    let downloads = 0;
    const extract = (archive, into, binary) => writeFileSync(join(into, binary), readFileSync(archive));
    const get = async () => (downloads++, bytes);
    assert.equal(await ensureBinary({ dir, asset, download: get, extract, binary: 'gitleaks' }), join(dir, 'gitleaks'));
    writeFileSync(join(dir, 'gitleaks'), 'changed');
    await ensureBinary({ dir, asset, download: get, extract, binary: 'gitleaks' });
    assert.equal(downloads, 1);
    assert.equal(readFileSync(join(dir, 'gitleaks'), 'utf8'), 'a pinned release');
  });
});

describe('private-data scan: client names in git', () => {
  const git = (cwd, ...args) => execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8', env: quietEnv() }).trim();
  test('--tree names files, --staged and --push only added lines, --history commits; the matched text is never returned', () => {
    const dir = join(TMP, 'names');
    mkdirSync(dir);
    const name = ['Zq', 'vx Hold', 'ings'].join('');
    const pattern = 'zqvx holdings|wrenmoor';
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'old.md'), `${name}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'one');
    const first = git(dir, 'rev-parse', 'HEAD');
    const found = (mode) => outsideGitRepo(() => nameFindings(dir, mode, pattern));
    assert.deepEqual(found('tree'), ['old.md']);
    writeFileSync(join(dir, 'old.md'), 'cleaned\n');
    writeFileSync(join(dir, 'new.md'), `see ${'WREN'}MOOR\n`);
    git(dir, 'add', '-A');
    assert.deepEqual(found('staged'), ['new.md']);
    git(dir, 'commit', '-q', '-m', 'two');
    const second = git(dir, 'rev-parse', 'HEAD');
    // No origin/main here: --push reads every commit no remote has.
    assert.deepEqual(found('push').sort(), [`${first.slice(0, 12)} old.md`, `${second.slice(0, 12)} new.md`].sort());
    assert.deepEqual(found('tree'), ['new.md']);
    assert.deepEqual(found('history').sort(), [first, second].sort());
    for (const mode of ['tree', 'staged', 'push', 'history']) assert.equal(JSON.stringify(found(mode)).toLowerCase().includes('wrenmoor'), false, mode);
  });
});

describe('private-data scan: the reviewed exceptions in .gitleaksignore (30.19.16)', () => {
  const git = (cwd, ...args) => execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8', env: quietEnv() }).trim();
  /** main() on the real gitleaks, with git's repository variables out of this process (main() spawns git with it). */
  async function scan(dir) {
    const was = Object.fromEntries(GIT_REPO.map((key) => [key, process.env[key]]));
    for (const key of GIT_REPO) delete process.env[key];
    const lines = [];
    try {
      const code = await main(['--history'], { cwd: dir, env: { CLIENT_DENY_PATTERN: 'wrenmoor' }, out: (line) => lines.push(line), home: TMP, binary: () => gitleaksBinary() });
      return { code, text: lines.join('\n') };
    } finally {
      for (const [key, value] of Object.entries(was)) if (value !== undefined) process.env[key] = value;
    }
  }
  test('--history: a listed fingerprint silences exactly that finding of that commit; an unlisted one still fails; a line without its commit is refused', async () => {
    const dir = join(TMP, 'exceptions');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'docs/docs-map.json'), JSON.stringify({ repo: 'snoopy' }));
    // Two personal addresses the public config finds, built here so this file holds neither.
    writeFileSync(join(dir, 'a.md'), ['one', `to: jane.roe${AT}gmail.com`, 'two', `to: john.roe${AT}gmail.com`, ''].join('\n'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'old');
    const old = git(dir, 'rev-parse', 'HEAD');
    const both = await scan(dir);
    assert.equal(both.code, 1, both.text);
    assert.match(both.text, new RegExp(`gitleaks: 2 finding\\(s\\)\\n {2}autom8x-email a\\.md:2 ${old.slice(0, 12)}\\n {2}autom8x-email a\\.md:4 ${old.slice(0, 12)}`, 'u'));

    // The reviewed line 2 of that commit, committed as the repositories commit theirs.
    writeFileSync(join(dir, IGNORE_FILE), `# reviewed: a made-up address\n${old}:a.md:autom8x-email:2\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'exceptions');
    const one = await scan(dir);
    assert.equal(one.code, 1, one.text);
    assert.match(one.text, new RegExp(`gitleaks: 1 finding\\(s\\)\\n {2}autom8x-email a\\.md:4 ${old.slice(0, 12)}\\n`, 'u'));
    assert.doesNotMatch(one.text, /a\.md:2 /u);

    writeFileSync(join(dir, IGNORE_FILE), `${old}:a.md:autom8x-email:2\n${old}:a.md:autom8x-email:4\n`);
    const none = await scan(dir);
    assert.equal(none.code, 0, none.text);
    assert.match(none.text, /gitleaks: clean/u);

    // Without its commit a line would silence a.md:4 in every commit, the tree's too: refused.
    writeFileSync(join(dir, IGNORE_FILE), `${old}:a.md:autom8x-email:2\na.md:autom8x-email:4\n`);
    const global = await scan(dir);
    assert.equal(global.code, 2, global.text);
    assert.match(global.text, /gitleaks: error — \.gitleaksignore line 2: not one exact <commit>:<file>:<rule>:<line> fingerprint/u);
    assert.doesNotMatch(global.text, /gmail/u);
  });
});

/** The few TOML forms the kit's two configs use: tables, arrays of tables, strings, numbers, string arrays. */
function readToml(text) {
  const root = {};
  let at = root;
  const value = (raw) => {
    const literal = /^'''([\s\S]*)'''$/u.exec(raw) ?? /^'(.*)'$/u.exec(raw);
    if (literal) return literal[1];
    if (/^".*"$/u.test(raw)) return JSON.parse(raw);
    if (/^-?\d+$/u.test(raw)) return Number(raw);
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (raw.startsWith('[')) return [...raw.matchAll(/'''([\s\S]*?)'''|"((?:[^"\\]|\\.)*)"/gu)].map((m) => m[1] ?? JSON.parse(`"${m[2]}"`));
    throw new Error(`unread TOML value ${raw}`);
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const table = /^(\[\[?)([\w.]+)\]\]?$/u.exec(line);
    if (table) {
      const path = table[2].split('.');
      let parent = root;
      for (const key of path.slice(0, -1)) parent = Array.isArray(parent[key]) ? parent[key].at(-1) : (parent[key] ??= {});
      const last = path.at(-1);
      if (table[1] === '[[') (parent[last] ??= []).push((at = {}));
      else at = parent[last] ??= {};
      continue;
    }
    let [, key, raw] = /^(\w+)\s*=\s*(.*)$/u.exec(line);
    while (raw.startsWith('[') && !/\]\s*$/u.test(raw.replace(/'''[\s\S]*?'''/gu, ''))) raw += `\n${lines[++i].replace(/^\s*#.*$/u, '')}`;
    at[key] = value(raw.trim());
  }
  return root;
}

/** Go's RE2 as JS: a leading (?i) becomes the flag; (?i:abc) becomes [aA][bB][cC]. */
function re2(source) {
  const flags = source.startsWith('(?i)') ? 'i' : '';
  const body = source.replace(/^\(\?i\)/u, '').replace(/\(\?i:([^()]*)\)/gu, (_, inner) => `(?:${inner.replace(/[a-z]/giu, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)})`);
  return new RegExp(body, `${flags}g`);
}

/** The findings gitleaks would make with these rules on one line of one file: [rule id…]. */
function simulate(rules, line, file = 'f.ts') {
  const found = [];
  for (const rule of rules) {
    for (const m of line.matchAll(re2(rule.regex))) {
      const secret = rule.secretGroup ? m[rule.secretGroup] : m[0];
      const allowed = (rule.allowlists ?? []).some((a) => {
        const target = a.regexTarget === 'match' ? m[0] : a.regexTarget === 'line' ? line : secret;
        return (a.regexes ?? []).some((r) => re2(r).test(target)) || (a.paths ?? []).some((p) => re2(p).test(file))
          || (a.stopwords ?? []).some((w) => secret.toLowerCase().includes(w));
      });
      if (!allowed) found.push(rule.id);
    }
  }
  return found;
}

describe('private-data scan: the configs', () => {
  const privateToml = readToml(readFileSync(join(KIT, 'private-data.toml'), 'utf8'));
  const publicToml = readToml(readFileSync(join(KIT, 'private-data-public.toml'), 'utf8'));
  const rules = publicToml.rules;
  const email = (local, domain) => `${local}${AT}${domain}`;
  // The allowlist's one-by-one entries, read from the config so this file never holds them.
  const exactLists = rules.find((r) => r.id === 'autom8x-email').allowlists.flatMap((a) => a.regexes ?? []).filter((r) => r.startsWith('(?i)^(?:'));
  const exactAllowed = exactLists.flatMap((r) => r.slice('(?i)^(?:'.length, -')$'.length).split('|')).map((r) => r.replaceAll('\\', ''));
  // Each line is one fixture and the rules it must trip — [] for a value the rules must let be.
  const cases = [
    ...['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.de']
      .map((d) => [`to: ${email('jane.roe', d)}`, ['autom8x-email']]),
    [`to: ${email('a', 'harbourline-dental.com')}`, ['autom8x-email']],
    ...['example.com', 'mail.example.org', 'example.net', 'shop.example.co.uk', 'acme.example', 'outlook.test', 'x.invalid', 'users.noreply.github.com', 'autom8x.ai']
      .map((d) => [`to: ${email('jane', d)}`, []]),
    // Registerable domains are no placeholder (30.19.10): only the exact addresses measured pass (below).
    ...['company.com', 'acme.co', 'b.co', 'e.com', 'x.com', 'p.iam.gserviceaccount.com']
      .map((d) => [`to: ${email('jane', d)}`, ['autom8x-email']]),
    // Each exact placeholder and service account the config allows passes; one letter more does not.
    ...exactAllowed.flatMap((address) => [[`to: ${address}`, []], [`to: q${address}`, ['autom8x-email']]]),
    [`"${email('owner', 'example.test')}Owner"`, []],
    [`git clone git${AT}github.com:o/r.git and icon${AT}2x.png and ${email('noreply', 'anthropic.com')}`, []],
    [`call (212) 555-${'1234'}`, ['autom8x-phone']],
    [`call +1 415 555 ${'7788'}`, ['autom8x-phone']],
    [`link tel:+1415555${'7788'}`, ['autom8x-phone-bare', 'autom8x-phone']],
    [`phone: "415555${'7788'}"`, ['autom8x-phone-bare']],
    [`call (212) 555-${'0123'}, 212.555.${'0199'} or tel:+1212555${'0150'}`, []],
    [`ids 2026-11-15T12:34:56Z 9f86d081884c7d659a2feaa0c55ad015 123e4567-e89b-12d3-a456-42661417${'4000'} n 12345${'67890'}`, []],
    [`host ${'11.22'}.33.44:3000`, ['autom8x-public-ipv4']],
    [`url http://${'64.23'}.1.2/x and at ${'11.22'}.33.45.`, ['autom8x-public-ipv4', 'autom8x-public-ipv4']],
    [`ok ${['10.0.0.1', '127.0.0.1', '172.16.4.2', '192.168.1.1', '169.254.1.1', '100.64.0.1', '192.0.2.7', '198.51.100.7', '203.0.113.9', '0.0.0.0', '255.255.255.0', '224.0.0.1', '1.2.3.4'].join(' ')}`, []],
    [`versions Chrome/${'120.0'}.0.0 v${'12.3'}.4.5 RFC §${'4.1'}.2.1 @${'12.3'}.4.5`, []],
    [`https://${'abcdefghij'}klmnopqrsu.supabase.co/rest`, ['autom8x-supabase-project']],
    [`project_ref = "${'abcdefghij'}klmnopqrsv"`, ['autom8x-supabase-project-ref']],
    [`cd ${'/Us'}ers/jdoe/code`, ['autom8x-macos-home']],
    [`${'/Us'}ers/a/x ${'/Us'}ers/runner/work ${'/Us'}ers/Shared/y /api/Users/123/`, []],
  ];

  test('the public config extends the private one, which is gitleaks’ own rules', () => {
    assert.deepEqual(privateToml.extend, { useDefault: true });
    assert.deepEqual(publicToml.extend, { path: 'scripts/kit/private-data.toml' });
    assert.equal((privateToml.rules ?? []).every((rule) => rule.regex === undefined), true, 'private-data.toml only adds allowlists to gitleaks’ rules');
  });

  test('a registerable domain is allowed only by exact addresses, anchored, with no wildcard (30.19.10)', () => {
    assert.equal(exactLists.length, 2, 'the measured placeholders and the flows’ service accounts');
    assert.ok(exactAllowed.length >= 2 && exactAllowed.every((a) => /^[a-z0-9._-]+@[a-z0-9.-]+$/u.test(a)), 'each entry is one literal address');
    const allow = rules.find((r) => r.id === 'autom8x-email').allowlists.flatMap((a) => a.regexes ?? []);
    for (const domain of ['company\\.com', 'acme\\.co', 'gserviceaccount\\.com']) {
      assert.ok(allow.filter((r) => r.includes(domain)).every((r) => exactLists.includes(r)), `${domain} is allowed only one address at a time`);
    }
  });

  test('no personal-mail provider is ever on the email allowlist', () => {
    const allow = rules.find((r) => r.id === 'autom8x-email').allowlists.flatMap((a) => a.regexes ?? []).join('\n');
    assert.doesNotMatch(allow, /gmail|googlemail|yahoo|outlook\\\.com|hotmail|live\\\.com|icloud|\bme\\\.com|mac\\\.com|aol|proton|gmx/u);
  });

  test('each rule finds what it must and lets reserved and placeholder values be', () => {
    for (const [line, want] of cases) assert.deepEqual(simulate(rules, line).sort(), [...want].sort(), line);
    assert.deepEqual(simulate(rules, `"author": "${email('jane.roe', 'gmail.com')}"`, 'package-lock.json'), []);
  });

  test('the real gitleaks agrees with the JS reading of the rules', async () => {
    const bin = await gitleaksBinary();
    const text = cases.map(([line]) => line).join('\n');
    const r = spawnSync(bin, ['stdin', '--config', join(KIT, 'private-data-public.toml'), '--no-banner', '--redact', '--report-format', 'json', '--report-path', '-', '--exit-code', '0', '--log-level', 'error'],
      { cwd: resolve(KIT, '../..'), input: text, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout).filter((f) => f.RuleID.startsWith('autom8x-')).map((f) => `${f.StartLine}:${f.RuleID}`).sort();
    const want = cases.flatMap(([, ids], i) => ids.map((id) => `${i + 1}:${id}`)).sort();
    assert.deepEqual(got, want);
  });
});
