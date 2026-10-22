// Every file path this repository's documents name, and whether it exists: no
// document names a file that does not exist. Lists each reference it could not
// find and exits 1 if there is one. Ported from snoopy-backend's
// scripts/audit-doc-references.mjs (2853e16, 2026-09-28) for the engineering
// standard's D (section (e), check 5); `npm run verify` runs it on every tracked
// document, `.claude/`'s included, and `test/doc-references.test.ts` holds it.
//
// A reference is a backticked path with a folder and a file type the documents
// name (`packages/automation-sdk/src/runner.ts`, `packages/automation-sdk/src/runner.ts:42`,
// `contract/README.md:10,20`, `automations/invoice-processing/Dockerfile`), found from the repository root or from the document's own
// folder — or a relative Markdown link, inline or by definition (`[x](README.md)`,
// `[x](path "title")`, `[x](<path>)`, `[id]: path`), found only where the link
// lands: from its document's folder, or from the root when it starts with `/`, as
// GitHub resolves it. A link cannot carry a line: a browser reads `[x](app.ts:10)`
// as a URL whose scheme is `app.ts`, so a link whose scheme is a file's name is a
// mistaken file link, read and reported missing. A query, `?plain=1`, is not part
// of the name. A code span that starts with `/` or `~` is a host's or a
// container's path, not a repository's. A built entrypoint is checked through its
// source (`packages/automation-sdk/dist/runner.js` is `packages/automation-sdk/src/runner.ts`),
// so a mistyped one is missing. A short form (src/runner.ts, without the folder that
// holds it) is not accepted: it can match the wrong file.
// It audits this repository, `snoopy-automations`, or a planted one standing in
// for it. Link syntax inside a code span or a fenced
// block is text (a fenced block's backticked paths are still read, as the
// records' own fenced blocks use them), and a form these documents do not use —
// an HTML link, a link text spanning paragraphs — is not read.
// A path in another repository says so — `snoopy/lib/tenancy.ts`, or a link that
// leaves this checkout — and is reported as not checked, never as found, unless
// the run opts into reading the sibling checkouts (below). So is a
// build's output or an installed package (`.next/…`, `@supabase/…`), which no
// repository tracks.
//
// A removed file stays namable in a record, struck through: ~~`automations/invoice-intake/src/run.ts`~~
// names a file that was there when the sentence was written and is gone since. The
// strike is believed only when a commit once added the file (a built entrypoint's
// source counts); a struck name that is still here is found, and one no commit ever
// added is missing — a strike cannot hide a file that never existed. A strike is
// read across the lines of one paragraph or list item, never from one table cell,
// list item or paragraph into the next.
//
// The documents read and the files they may name are one view: what git sees —
// tracked files still on disk, and untracked ones it does not ignore — never
// whatever is on disk, in this checkout and in a sibling's. A path git ignores is
// a build output or an install, there only once the checkout is built, so it is
// not checked (the web repository's F59: a built checkout passed three references
// CI's clean one failed).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `node scripts/audit-doc-references.mjs [repository] [--all]`, in either order.
const [target] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const root = resolve(target ?? resolve(import.meta.dirname, '..'));
const OWN = 'snoopy-automations';
const SIBLINGS = ['snoopy', 'snoopy-mobile', 'snoopy-n8n', 'snoopy-backend'];
const siblingRoot = (name) =>
  resolve(
    root,
    process.env[`AUDIT_ROOT_${name.replace(/-/gu, '_').toUpperCase()}`] || `../${name}`,
  );

const FILE =
  /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|json|ya?ml|md|sql|css|sh|toml|txt|html|pem|png|svg|hcl|crt|prisma|example)$|(?:^|\/)(?:Caddyfile|Dockerfile|Makefile|Procfile)$/u;
const CODE = /`([^`\s]+)`/dgu;
// An inline code span, as CommonMark reads one: a run of backticks not escaped,
// closed by a run of the same length.
const CODE_SPAN = /(?<!\\)(`+)(?:(?!\1)[\s\S])+?\1/gu;
// `[x](path)`, `[x](path#part)`, `[x](path "title")` (or 'title', or (title)),
// `[x](<path>)` and `[x](app/(group)/page.tsx)`; never a fragment of the document itself.
const LINK =
  /\]\((?:<([^<>\n]+)>|((?:[^()\s#]|\([^()\s]*\))+)(?:#[^()\s]*)?)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\)/dgu;
// A footnote, `[^1]: …`, is no definition; one inside a quote is.
const DEFINITION =
  /^(?:[ \t]*>)*[ \t]{0,3}\[(?!\^)[^\]\n]+\]:[ \t]*\n?(?:[ \t]*>)*[ \t]*(?:<([^<>\n]+)>|([^\s#]+))/dgmu;
// A scheme, `https:` or `mailto:` — and when what precedes the colon is a file's
// name (`app.ts:10`, `Caddyfile:L12`), a file link written with a line, which no
// browser can follow (`candidate()`).
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const STRUCK = /~~(?:(?!~~)[\s\S])+?~~/gu;
const STRUCK_IN_CELL = /~~(?:(?!~~)[^|])+?~~/gu;
// `:12`, `:12-20`, `:12–20` and lists of them, `:1058,1091`.
const LINES = /:\d+(?:[-–]\d+)?(?:,\d+(?:[-–]\d+)?)*$/u;
// A built entrypoint, and the sources each kind is built from.
const BUILT = /^(.*)\/dist\/(.+)\.(js|mjs|cjs)$/u;
const SOURCE = { js: ['ts', 'tsx'], mjs: ['mts'], cjs: ['cts'] };
const sources = (path) => {
  const built = BUILT.exec(path);
  return built ? SOURCE[built[3]].map((type) => `${built[1]}/src/${built[2]}.${type}`) : [];
};

/** What git sees in one checkout, and every path a commit there ever added. */
function gitView(directory) {
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  const list = (...options) =>
    git('ls-files', '-z', ...options)
      .split('\0')
      .filter(Boolean);
  const deleted = new Set(list('--deleted'));
  let added;
  return {
    visible: new Set(
      list('--cached', '--others', '--exclude-standard').filter((file) => !deleted.has(file)),
    ),
    ignored: (path) =>
      spawnSync('git', ['check-ignore', '-q', path], { cwd: directory }).status === 0,
    // undefined when this checkout cannot say: a shallow clone lacks the history.
    everAdded(path) {
      if (added === undefined) {
        const shallow = git('rev-parse', '--is-shallow-repository').trim() === 'true';
        const born = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], {
          cwd: directory,
        });
        added = shallow
          ? null
          : new Set(
              born.status === 0
                ? git(
                    'log',
                    '--all',
                    '--no-renames',
                    '--diff-filter=A',
                    '--format=',
                    '--name-only',
                    '-z',
                  )
                    .split('\0')
                    .map((file) => file.trim())
                    .filter(Boolean)
                : [],
            );
      }
      return added === null ? undefined : added.has(path);
    },
  };
}

const own = gitView(root);

// Another repository's files are its own facts: the default run never reads a
// sibling. `AUDIT_DOC_SIBLINGS=1` checks them against
// what git sees in the checkouts beside this one, for a dated read by hand — a
// test plants its own, and never reads a real one.
const checkSiblings = process.env.AUDIT_DOC_SIBLINGS === '1';
const siblings = new Map();
function sibling(name) {
  if (!siblings.has(name)) {
    const base = siblingRoot(name);
    siblings.set(name, checkSiblings && existsSync(join(base, '.git')) ? gitView(base) : null);
  }
  return siblings.get(name);
}

// Not a repository's file: a build's output, an installed package, a local link.
const UNTRACKED = /^(?:\.next|\.vercel|node_modules)\/|^@[a-z0-9-]+\/[a-z0-9.-]+\//u;

/** Where `path`, read from the folder `base`, lands among the checkouts beside this one. */
function landing(base, path) {
  const landed = relative(resolve(root, '..'), resolve(base, path));
  const [name, ...rest] = landed.split(sep);
  return { name, rest: rest.join('/'), outside: !name || landed.startsWith('..') };
}

/**
 * The places a reference may name — a checkout and the paths to ask it, or why
 * none can answer. A link has one: where it lands. A code span has two, read from
 * the root and from its document's folder, and it is as good as the better.
 */
function places(doc, path, kind) {
  if (UNTRACKED.test(path)) return [{ status: 'not checked' }];
  const inSibling = (name, rest) => {
    const view = sibling(name);
    return view ? { view, paths: [normalize(rest)] } : { status: 'not checked' };
  };
  // This checkout by its folder's name, or by its own, `snoopy-automations`, as a
  // worktree or a clone under another name still is.
  const at = ({ name, rest, outside }) => {
    if (outside) return { status: 'missing' };
    if (name === basename(root) || name === OWN) return { view: own, paths: [rest] };
    return SIBLINGS.includes(name) ? inSibling(name, rest) : { status: 'missing' };
  };
  const folder = join(root, dirname(doc));
  if (kind === 'link') {
    return path.startsWith('/')
      ? [{ view: own, paths: [normalize(path.slice(1))] }]
      : [at(landing(folder, path))];
  }
  const prefixed = path.match(/^(snoopy(?:-[a-z0-9]+)?)\/(.+)$/u);
  if (prefixed && prefixed[1] === OWN) {
    return [{ view: own, paths: [normalize(prefixed[2])] }];
  }
  if (prefixed && SIBLINGS.includes(prefixed[1])) return [inSibling(prefixed[1], prefixed[2])];
  return [at(landing(root, path)), at(landing(folder, path))];
}

function judge(place, struck) {
  if (place.status) return place.status;
  const { view, paths } = place;
  const named = paths.flatMap((candidate) => [candidate, ...sources(candidate)]);
  if (named.some((candidate) => view.visible.has(candidate))) return 'found';
  if (!paths.some((candidate) => BUILT.test(candidate)) && paths.some(view.ignored)) {
    return 'not checked';
  }
  if (!struck) return 'missing';
  const once = named.map((candidate) => view.everAdded(candidate));
  if (once.includes(true)) return 'struck';
  return once.includes(undefined) ? 'not checked' : 'missing';
}

const BEST = ['found', 'struck', 'not checked', 'missing'];
function status(doc, path, kind, struck) {
  const outcomes = places(doc, path, kind).map((place) => judge(place, struck));
  return BEST.find((state) => outcomes.includes(state));
}

function candidate(reference, kind) {
  let path = reference.replace(/#.*$/u, '');
  if (kind === 'code') {
    path = path.replace(LINES, '');
    // A code span needs a folder: a bare `README.md` could be any folder's. One
    // that starts with `/` or `~` is a host's or a container's path.
    if (!path.includes('/') || /^[/~]/u.test(path)) return null;
  } else {
    // A query is not part of a file's name: `README.md?plain=1` is `README.md`.
    path = path.replace(/\?.*$/u, '');
    try {
      path = decodeURIComponent(path);
    } catch {
      return null;
    }
    // `//host/…` is a URL too. A scheme that is a file's name, `Caddyfile:L12`,
    // is a file link written with a line: read, and missing.
    if (path.startsWith('//') || (SCHEME.test(path) && !FILE.test(path.split(':')[0]))) {
      return null;
    }
  }
  if (path.includes('://') || /[*<>{}$…]/u.test(path) || path.includes('...')) return null;
  // A link keeps its line: `app.ts:10` and `app.ts:L10` name no file, so such a
  // link is read, and missing.
  return FILE.test(kind === 'link' ? path.replace(/:[^/]*$/u, '') : path) ? path : null;
}

/**
 * A document as the pieces a `~~` pair cannot cross, each with its first line:
 * a paragraph or a list item (its wrapped lines together), a table row (and in
 * it, a cell), a heading, and each line of a fenced block, where `~~` is only text.
 */
function blocks(text) {
  const out = [];
  let open = null;
  let fence = null;
  text.split('\n').forEach((line, index) => {
    const body = line.replace(/^(?:\s*>)*\s?/u, '');
    const marker = /^\s*(`{3,}|~{3,})/u.exec(body)?.[1];
    if (fence !== null || marker) {
      if (marker && (fence === null || body.trim().startsWith(fence))) {
        fence = fence === null ? marker : null;
      }
      out.push({ line: index + 1, text: line, fenced: true });
      open = null;
      return;
    }
    if (body.trim() === '') {
      open = null;
      return;
    }
    const alone = /^\s*(?:#{1,6}\s|\|)/u.test(body);
    const starts = alone || /^\s*(?:[-*+]|\d+[.)])\s/u.test(body);
    if (open && !starts) {
      open.text += `\n${line}`;
      return;
    }
    open = { line: index + 1, text: line };
    out.push(open);
    if (alone) open = null;
  });
  return out;
}

/** The documents the audit reads: what git sees, never what is merely on disk. */
const documents = () => [...own.visible].filter((file) => file.endsWith('.md')).sort();

function auditDocReferences() {
  const references = [];
  for (const doc of documents()) {
    for (const block of blocks(readFileSync(join(root, doc), 'utf8'))) {
      const strike = /^(?:\s*>)*\s*\|/u.test(block.text) ? STRUCK_IN_CELL : STRUCK;
      const struck = [...block.text.matchAll(strike)].map((m) => [m.index, m.index + m[0].length]);
      // Link syntax inside a code span is text: the spans are blanked, keeping
      // every offset, before links and definitions are read. In a fenced block
      // there are no links at all.
      const prose = block.text.replace(CODE_SPAN, (span) => ' '.repeat(span.length));
      const readers = [[CODE, 'code', block.text]];
      if (!block.fenced) readers.push([LINK, 'link', prose], [DEFINITION, 'link', prose]);
      for (const [pattern, kind, text] of readers) {
        for (const match of text.matchAll(pattern)) {
          const path = candidate(match[1] ?? match[2], kind);
          if (!path) continue;
          const inside = struck.some(([start, end]) => match.index >= start && match.index < end);
          // The line the path is on, which a definition may put below its label.
          const at = (match.indices[1] ?? match.indices[2])[0];
          references.push({
            doc,
            line: block.line + (block.text.slice(0, at).match(/\n/gu)?.length ?? 0),
            path,
            status: status(doc, path, kind, inside),
          });
        }
      }
    }
  }
  return references;
}

// Paths, not URLs: a URL percent-encodes a space (`My Projects/`), and the
// audit then never ran — a silent pass (`snoopy`'s second Round 14 review).
if (realpathSync(resolve(process.argv[1] ?? '')) === fileURLToPath(import.meta.url)) {
  const references = auditDocReferences();
  const count = (state) => references.filter((entry) => entry.status === state).length;
  for (const entry of references) {
    if (entry.status === 'missing' || process.argv.includes('--all')) {
      console.log(`${entry.status}\t${entry.doc}:${entry.line}\t${entry.path}`);
    }
  }
  console.log(
    `doc references: ${references.length} — found ${count('found')}, struck ${count('struck')}, not checked ${count('not checked')}, missing ${count('missing')}`,
  );
  process.exit(count('missing') > 0 ? 1 : 0);
}
