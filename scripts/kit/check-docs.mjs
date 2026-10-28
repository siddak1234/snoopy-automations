// autom8x-kit v1 — canonical: snoopy-backend/scripts/kit/check-docs.mjs
// D, docs always updated (STANDARD (e)): `npm run check:docs` reads
// docs/docs-map.json and exits 1, naming the file and the fix, when a check fails:
//   1 sound map: docs paths exist, code globs match, every top-level folder covered
//     (plus the line limits: router 150, folder CLAUDE.md 60, SKILL.md 120);
//   2 range: --base, else $DOCS_BASE, else `git merge-base origin/main HEAD`;
//   3 a commit with `Docs-Unchanged: <reason, 12+ chars>` triggers no rule;
//   4 each rule whose code changed needs its docs changed in the range (generated
//     files never count); a `*` in a rule's docs path is filled with what the code
//     glob's first `*` matched, so `automations/*/src/**` → `automations/*/README.md`
//     asks each changed flow for its own README;
//   5 backticked paths and relative links in changed docs (and in changed code's
//     comments) resolve; a struck ~~`x`~~ only if git once added x; a built
//     entrypoint (`<p>/dist/<f>.js`) through its source, and a path git ignores
//     is not checked, as scripts/audit-doc-references.mjs reads them;
//   6 a fact's pattern matches only in its home (archives, generated exempt).
// Flags: --base <ref>, --map-only (1 and the limits), --json. A path under another
// repository's name (the map's `repo` family, e.g. <family>-<name>/…) is not checked.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = { router: 150, folder: 60, skill: 120 };
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|ya?ml|sh)$|(?:^|\/)Dockerfile$/u;
const FILE =
  /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|json|ya?ml|md|sql|css|sh|toml|txt|html|pem|png|svg|hcl|crt|prisma|example)$|(?:^|\/)(?:Caddyfile|Dockerfile|Makefile|Procfile)$/u;

const cache = new Map();
/**
 * A glob as a RegExp: `**` any folders (or none), `*` within one segment, `?` one character.
 * With `capture`, the first single `*` is a group: what a docs path's `*` is bound to.
 */
export function globToRegExp(glob, capture = false) {
  const key = `${capture}\0${glob}`;
  if (cache.has(key)) return cache.get(key);
  let re = '';
  let captured = !capture;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/';
      if (atStart && glob[i + 2] === '/') (re += '(?:.*/)?'), (i += 2);
      else (re += '.*'), (i += 1);
    } else if (c === '*') (re += captured ? '[^/]*' : '([^/]*)'), (captured = true);
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  const compiled = new RegExp(`^${re}$`, 'u');
  cache.set(key, compiled);
  return compiled;
}
/** Whether a glob has a single-segment `*` (not part of `**`) to bind a docs path to. */
const hasStar = (glob) => /(?:^|[^*])\*(?:[^*]|$)/u.test(glob);
/** A rule's docs for one changed file: each `*` filled with what the file's glob's first `*` matched. */
export function boundDocs(rule, file) {
  const docs = rule.docs ?? [];
  if (!docs.some((d) => d.includes('*'))) return docs;
  for (const glob of rule.code ?? []) {
    const bound = globToRegExp(glob, true).exec(file)?.[1];
    if (bound !== undefined) return docs.map((d) => d.replaceAll('*', bound));
  }
  return docs;
}
export const matches = (glob, path) => globToRegExp(glob).test(path);
const any = (globs, path) => (globs ?? []).some((g) => matches(g, path));

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 });
  return r.status === 0 ? r.stdout : null;
}
const lines = (text) => (text ?? '').split('\n').filter(Boolean);

/** What git sees: tracked files still on disk, and untracked ones it does not ignore. */
export function visibleFiles(root) {
  const list = (...o) => (git(root, 'ls-files', '-z', ...o) ?? '').split('\0').filter(Boolean);
  const deleted = new Set(list('--deleted'));
  return list('--cached', '--others', '--exclude-standard').filter((f) => !deleted.has(f));
}

const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const read = (root, path) => readFileSync(posix.join(root, path), 'utf8');

/** Another repository's path: the first segment is the map's family (`<family>` or `<family>-x`), not a folder here. */
function foreign(path, map, topLevel) {
  const family = String(map.repo ?? '').split('-')[0];
  const first = path.split('/')[0];
  if (!family || topLevel.has(first)) return false;
  return first === family || first.startsWith(`${family}-`);
}

/** Check 1, and the line limits. */
export function checkMap(root, map, files) {
  const problems = [];
  const has = new Set(files);
  const topLevel = new Set(files.map((f) => f.split('/')[0]));
  const add = (file, message, fix) => problems.push({ check: 'map', file, message, fix });
  const reported = new Set();
  const need = (path, where) => {
    if (!foreign(path, map, topLevel) && !has.has(path) && !reported.has(path) && reported.add(path)) add('docs/docs-map.json', `${where} names ${path}, which does not exist`, 'fix the path or create the file');
  };
  for (const rule of map.rules ?? []) {
    for (const doc of rule.docs ?? []) {
      if (!doc.includes('*')) need(doc, `rule ${rule.id}`);
      else if (!files.some((f) => matches(doc, f))) add('docs/docs-map.json', `rule ${rule.id} names ${doc}, which matches no file`, 'fix the path or create the file');
      else if (!(rule.code ?? []).every(hasStar)) add('docs/docs-map.json', `rule ${rule.id}: ${doc} needs a * in every code glob to bind to`, 'give each code glob a *, or split the rule');
    }
    for (const glob of rule.code ?? []) {
      if (!files.some((f) => matches(glob, f))) add('docs/docs-map.json', `rule ${rule.id}: ${glob} matches no file`, 'fix the glob or remove it');
    }
  }
  for (const fact of map.facts ?? []) need(fact.home, `fact ${fact.key}`);
  for (const path of [...(map.generated ?? []), ...(map.records?.current ?? []), ...(map.records?.archive ?? []), ...(map.map?.readFirst ?? [])]) need(path, 'the map');
  const unmapped = map.unmapped ?? {};
  for (const [folder, reason] of Object.entries(unmapped)) {
    if (typeof reason !== 'string' || reason.trim() === '') add('docs/docs-map.json', `unmapped ${folder} has no reason`, 'give the reason it has no doc');
  }
  const codeGlobs = (map.rules ?? []).flatMap((r) => r.code ?? []);
  const quiet = [...(map.ignore ?? []), ...(map.generated ?? [])];
  for (const folder of [...topLevel].filter((t) => files.some((f) => f.startsWith(`${t}/`))).sort()) {
    const inside = files.filter((f) => f.startsWith(`${folder}/`));
    const covered = folder in unmapped || inside.some((f) => any(codeGlobs, f)) || inside.every((f) => any(quiet, f));
    if (!covered) add(`${folder}/`, 'top-level folder covered by no rule', `add a rule for it to docs/docs-map.json, or list it in "unmapped" with a reason`);
  }
  // Line limits (STANDARD (a), (b), (f)).
  const limit = (path, max, what) => {
    const n = lineCount(read(root, path));
    if (n > max) problems.push({ check: 'limits', file: path, message: `${what} has ${n} lines, over ${max}`, fix: 'move detail into a linked doc' });
  };
  if (has.has('CLAUDE.md')) {
    const router = read(root, 'CLAUDE.md').trim() === '@AGENTS.md' && has.has('AGENTS.md') ? 'AGENTS.md' : 'CLAUDE.md';
    limit(router, LIMITS.router, 'the router');
  }
  for (const f of files) {
    if (f !== 'CLAUDE.md' && posix.basename(f) === 'CLAUDE.md') limit(f, LIMITS.folder, 'a folder CLAUDE.md');
    if (posix.basename(f) === 'SKILL.md') limit(f, LIMITS.skill, 'a SKILL.md');
  }
  return problems;
}

/** Check 2: the commits since the base, oldest first; or the error. */
export function commitRange(root, base) {
  const ref = base || process.env.DOCS_BASE || lines(git(root, 'merge-base', 'origin/main', 'HEAD'))[0];
  const sha = ref ? lines(git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`))[0] : undefined;
  if (!sha) return { error: `no base${ref ? ` (${ref} does not resolve)` : ''}: fetch origin main (CI: fetch-depth: 0)` };
  return { base: ref, commits: lines(git(root, 'rev-list', '--reverse', `${sha}..HEAD`)) };
}

/** Code spans and relative links in one line of text, as [path, kind, struck]. */
function references(text) {
  const out = [];
  const struck = [...text.matchAll(/~~(?:(?!~~).)+?~~/gu)].map((m) => [m.index, m.index + m[0].length]);
  const inStrike = (at) => struck.some(([s, e]) => at >= s && at < e);
  for (const m of text.matchAll(/`([^`\s]+)`/gu)) {
    let p = m[1].replace(/:\d+(?:[-–]\d+)?(?:,\d+(?:[-–]\d+)?)*$/u, '');
    if (!p.includes('/') || /^[/~]/u.test(p) || p.includes('://') || /[*<>{}$…]/u.test(p) || p.includes('...')) continue;
    if (FILE.test(p)) out.push([p, 'code', inStrike(m.index)]);
  }
  const prose = text.replace(/`[^`]*`/gu, (s) => ' '.repeat(s.length));
  for (const m of prose.matchAll(/\]\(<?([^()\s<>]+)>?(?:\s+"[^"]*")?\)/gu)) {
    let p = m[1].replace(/[#?].*$/u, '');
    if (!p || p.startsWith('//') || /^[a-z][a-z0-9+.-]*:/iu.test(p)) continue;
    try {
      p = decodeURIComponent(p);
    } catch {
      continue;
    }
    out.push([p, 'link', inStrike(m.index)]);
  }
  return out;
}

/** The comment text of a code file, line by line (other lines blank). */
function commentLines(file, text) {
  const hash = /\.(?:ya?ml|sh)$|(?:^|\/)Dockerfile$/u.test(file);
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (hash) return t.startsWith('#') ? t : (/\s#\s.*$/u.exec(line)?.[0] ?? '');
    if (/^(?:\/\/|\/\*|\*)/u.test(t)) return t;
    return /(?:^|\s)\/\/\s.*$/u.exec(line)?.[0] ?? '';
  });
}

const BUILT = /^(.*)\/dist\/(.+)\.(js|mjs|cjs)$/u;
const SOURCE = { js: ['ts', 'tsx'], mjs: ['mts'], cjs: ['cts'] };
const sources = (p) => (BUILT.test(p) ? SOURCE[BUILT.exec(p)[3]].map((t) => `${BUILT.exec(p)[1]}/src/${BUILT.exec(p)[2]}.${t}`) : []);

/** Check 5 for the files changed in the range that still exist. */
export function checkReferences(root, map, files, changed) {
  const problems = [];
  const has = new Set(files);
  const topLevel = new Set(files.map((f) => f.split('/')[0]));
  let added;
  const everAdded = (p) => {
    added ??= new Set(lines(git(root, 'log', '--all', '--no-renames', '--diff-filter=A', '--format=', '--name-only')));
    return added.has(p);
  };
  const exists = (p) => has.has(p) || files.some((f) => f.startsWith(`${p.replace(/\/$/u, '')}/`));
  for (const file of [...changed].filter((f) => has.has(f)).sort()) {
    if ((map.generated ?? []).includes(file)) continue;
    const isDoc = file.endsWith('.md');
    if (!isDoc && !CODE_EXT.test(file)) continue;
    const text = read(root, file);
    const rows = isDoc ? text.split('\n') : commentLines(file, text);
    const dir = posix.dirname(file);
    rows.forEach((row, index) => {
      for (const [path, kind, struck] of references(row)) {
        if (kind === 'link' && !isDoc) continue;
        const landed = kind === 'link' ? posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(dir, path)) : path;
        if (landed.startsWith('../')) {
          if (foreign(landed.replace(/^(?:\.\.\/)+/u, ''), map, topLevel)) continue;
        } else {
          const local = map.repo && landed.startsWith(`${map.repo}/`) ? landed.slice(map.repo.length + 1) : landed;
          if (local === landed && foreign(landed, map, topLevel)) continue;
          const candidates = kind === 'link' ? [local] : [local, posix.normalize(posix.join(dir, local))];
          // Each reading on its own, as the audit judges each place.
          const ignored = (c) => spawnSync('git', ['check-ignore', '-q', c], { cwd: root }).status === 0;
          const resolves = (c) => {
            const named = [c, ...sources(c)];
            if (named.some((n) => (kind === 'link' ? exists(n) : has.has(n)))) return true;
            return ((!BUILT.test(c) || c.split('/').includes('node_modules')) && ignored(c)) || (struck && named.some(everAdded));
          };
          if (candidates.some(resolves)) continue;
        }
        problems.push({ check: 'references', file: `${file}:${index + 1}`, message: `${path} does not resolve${struck ? ' (struck, but git never added it)' : ''}`, fix: 'fix the path, or strike a removed file as ~~`path`~~' });
      }
    });
  }
  return problems;
}

/** Check 6: each fact's pattern only in its home. */
export function checkFacts(root, map, files) {
  const problems = [];
  const exempt = new Set([...(map.generated ?? []), ...(map.records?.archive ?? [])]);
  for (const fact of map.facts ?? []) {
    const re = new RegExp(fact.pattern, 'u');
    for (const file of files.filter((f) => f.endsWith('.md') && f !== fact.home && !exempt.has(f) && !f.endsWith('.archive.md'))) {
      read(root, file).split('\n').forEach((line, i) => {
        if (re.test(line)) problems.push({ check: 'facts', file: `${file}:${i + 1}`, message: `repeats fact ${fact.key}`, fix: `link to ${fact.home}` });
      });
    }
  }
  return problems;
}

/** Checks 3 and 4 over the range; returns the problems and every changed path. */
export function checkRange(root, map, commits) {
  const problems = [];
  const changed = new Set();
  const triggering = new Set();
  const generated = new Set(map.generated ?? []);
  for (const c of commits) {
    const files = lines(git(root, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', c));
    files.forEach((f) => changed.add(f));
    const trailers = lines(git(root, 'log', '-1', '--format=%(trailers:key=Docs-Unchanged)', c));
    const reasons = trailers.map((t) => t.slice(t.indexOf(':') + 1).trim());
    const short = reasons.find((r) => r.length < 12);
    if (short !== undefined) {
      problems.push({ check: 'trailer', file: c.slice(0, 12), message: `Docs-Unchanged reason "${short}" is under 12 characters`, fix: 'say why no doc changes, in 12+ characters' });
    }
    if (reasons.length && short === undefined) continue;
    files.filter((f) => !generated.has(f) && !any(map.ignore, f)).forEach((f) => triggering.add(f));
  }
  for (const rule of map.rules ?? []) {
    // One group per set of bound docs: each flow's change asks for that flow's own doc.
    const groups = new Map();
    for (const f of [...triggering].filter((x) => any(rule.code, x)).sort()) {
      const docs = boundDocs(rule, f).filter((d) => !generated.has(d));
      const key = docs.join('\0');
      if (!groups.has(key)) groups.set(key, { docs, hits: [] });
      groups.get(key).hits.push(f);
    }
    for (const { docs, hits } of groups.values()) {
      const done = docs.filter((d) => changed.has(d));
      const ok = (rule.need ?? 'any') === 'all' ? done.length === docs.length : done.length > 0;
      if (!ok) {
        problems.push({ check: 'docs', file: hits[0], message: `rule ${rule.id}: ${hits.length > 1 ? `${hits[0]} and ${hits.length - 1} more` : hits[0]} changed without ${docs.join(rule.need === 'all' ? ' and ' : ' or ')}`, fix: 'update the doc that describes it, or add a "Docs-Unchanged: <reason>" trailer' });
      }
    }
  }
  return { problems, changed };
}

export function run(argv, root) {
  const flag = (name) => argv.includes(name);
  const at = argv.indexOf('--base');
  const base = at >= 0 ? argv[at + 1] : undefined;
  let map;
  try {
    map = JSON.parse(read(root, 'docs/docs-map.json'));
  } catch (error) {
    return { ok: false, problems: [{ check: 'map', file: 'docs/docs-map.json', message: `unreadable: ${error.message}`, fix: 'create it (STANDARD (e))' }] };
  }
  const files = visibleFiles(root);
  const problems = checkMap(root, map, files);
  const result = { ok: false, problems };
  if (!flag('--map-only')) {
    const range = commitRange(root, base);
    if (range.error) problems.push({ check: 'range', file: '-', message: range.error, fix: 'git fetch origin main, or pass --base <ref>' });
    else {
      const { problems: rangeProblems, changed } = checkRange(root, map, range.commits);
      problems.push(...rangeProblems, ...checkReferences(root, map, files, changed));
      Object.assign(result, { base: range.base, commits: range.commits.length });
    }
    problems.push(...checkFacts(root, map, files));
  }
  result.ok = problems.length === 0;
  return result;
}

const isMain = () => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  const argv = process.argv.slice(2);
  const root = (git(process.cwd(), 'rev-parse', '--show-toplevel') ?? process.cwd()).trim();
  const result = run(argv, root);
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const p of result.problems) console.log(`check-docs: [${p.check}] ${p.file}: ${p.message} — ${p.fix}`);
    const scope = argv.includes('--map-only') ? 'map and limits' : `map, limits and ${result.commits ?? 0} commit(s) since ${result.base ?? '?'}`;
    console.log(result.ok ? `check-docs: ok — ${scope}` : `check-docs: ${result.problems.length} problem(s)`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
