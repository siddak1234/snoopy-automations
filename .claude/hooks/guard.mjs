// autom8x-kit v1 — canonical: snoopy-backend/.claude/hooks/guard.mjs
// PreToolUse guard (STANDARD (h), rows 1–8). Blocks, with exit 2 and a one-line
// reason naming the allowed alternative, only the exact patterns its table names;
// anything it cannot read, including its own errors, exits 0 (fail open).
// `decide(input, env)` is the whole policy and runs nothing: the only process it
// may start is `git rev-parse --show-toplevel` (1 s) for an `rm -rf` target.
// Shell text is tokenised with quotes respected, split on && || ; | & and
// newlines, heredoc bodies skipped, `cd` tracked per part and wrappers
// (`perl -e '… exec @ARGV'`, caffeinate, timeout, env, sudo, bash -c) unwrapped.
// Cases: cases.json, run by scripts/kit/kit.test.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchRoot } from './lib/quick-hygiene.mjs';

const ALLOW = Object.freeze({ exit: 0, reason: '' });
const REASONS = {
  1: 'git push --no-verify (or core.hooksPath) skips the pre-push gate — make the gate green and push without it',
  2: 'rm -rf outside this repo, /tmp and the scratch root (or on /, ~, $HOME, an unexpanded $VAR) — name a path inside one of them',
  3: 'install/build/test under ~/Desktop or iCloud Drive — run it in a scratch clone under /private/tmp',
  4: 'writing into iCloud Drive (~/Library/Mobile Documents) — write into the repo or the scratch folder',
  5: 'npm run hygiene --execute changes production hosts — the owner runs it; --clean prints the commands',
};
const block = (row, detail) => ({ exit: 2, row, reason: `guard #${row}: ${REASONS[row]}${detail ? ` (${detail})` : ''}` });

/** A heredoc's delimiter at `i` (just after `<<`): the tag, `<<-`, and where it ends. */
function readTag(src, i) {
  const strip = src[i] === '-';
  if (strip) i++;
  while (src[i] === ' ' || src[i] === '\t') i++;
  let tag = '';
  while (i < src.length && !/[\s;&|<>()]/u.test(src[i])) {
    if (src[i] === "'" || src[i] === '"') {
      const j = src.indexOf(src[i], i + 1);
      tag += src.slice(i + 1, j < 0 ? src.length : j);
      i = j < 0 ? src.length : j + 1;
    } else if (src[i] === '\\') (tag += src[i + 1] ?? ''), (i += 2);
    else tag += src[i++];
  }
  return { tag, strip, next: i };
}

/** Past the heredoc bodies that start at `i` (just after a newline). */
function skipBodies(src, i, tags) {
  while (tags.length) {
    const { tag, strip } = tags.shift();
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const line = src.slice(i, nl < 0 ? src.length : nl);
      i = nl < 0 ? src.length : nl + 1;
      if ((strip ? line.replace(/^\t+/u, '') : line) === tag) break;
    }
  }
  return i;
}

/** The `)` closing a `$(` whose body starts at `i`: quotes, nesting and heredocs respected. */
function substEnd(src, i) {
  const tags = [];
  for (let depth = 0; i < src.length; ) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === "'") i = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1) + 1;
    else if (c === '"') i = quoteEnd(src, i + 1);
    else if (c === '\n') i = skipBodies(src, i + 1, tags);
    else if (src.startsWith('<<<', i)) i += 3;
    else if (src.startsWith('<<', i)) {
      const t = readTag(src, i + 2);
      tags.push(t);
      i = t.next;
    } else if (src.startsWith('$(', i)) i = substEnd(src, i + 2) + 1;
    else if (c === '(') (depth++, i++);
    else if (c === ')') {
      if (depth === 0) return i;
      depth--;
      i++;
    } else i++;
  }
  return src.length;
}

/** Just past the `"` closing a double-quoted string whose body starts at `i`. */
function quoteEnd(src, i) {
  while (i < src.length && src[i] !== '"') {
    if (src[i] === '\\') i += 2;
    else if (src.startsWith('$(', i)) i = substEnd(src, i + 2) + 1;
    else if (src[i] === '`') i = src.indexOf('`', i + 1) < 0 ? src.length : src.indexOf('`', i + 1) + 1;
    else i++;
  }
  return i + 1;
}

/** Shell text as words and operators; quotes respected, heredoc bodies dropped. */
export function tokenize(src) {
  const out = [];
  const heredocs = [];
  let word = null;
  let i = 0;
  const add = (s) => (word = (word ?? '') + s);
  const push = () => void (word !== null && out.push({ w: word }), (word = null));
  const redirect = (op, len) => {
    if (word !== null && /^\d+$/u.test(word)) word = null; // `2>`: the fd is not a word
    push();
    i += len;
    if (op === '>&' && /[\d-]/u.test(src[i] ?? '')) return void i++; // `2>&1`
    out.push({ op: op.includes('<') ? '<' : '>' });
  };
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      add(src.slice(i + 1, j < 0 ? src.length : j));
      i = j < 0 ? src.length : j + 1;
    } else if (c === '"') {
      const end = quoteEnd(src, i + 1);
      add(src.slice(i + 1, end - 1).replace(/\\(["\\$`])/gu, '$1').replace(/\\\n/gu, ''));
      i = end;
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') add(src[i + 1] ?? '');
      i += 2;
    } else if (two === '$(' || c === '`') {
      // A command substitution stays text inside its word.
      let j = c === '`' ? src.indexOf('`', i + 1) : substEnd(src, i + 2);
      j = j < 0 ? src.length : j;
      add(src.slice(i, j + 1));
      i = j + 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      push(), i++;
    } else if (c === '#' && word === null) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '\n') {
      push();
      out.push({ op: '\n' });
      i = skipBodies(src, i + 1, heredocs);
    } else if (src.startsWith('<<<', i)) {
      push();
      out.push({ op: '<' });
      i += 3;
    } else if (two === '<<') {
      push();
      const t = readTag(src, i + 2);
      heredocs.push(t);
      i = t.next;
    } else if (two === '&&' || two === '||' || two === ';;' || two === '|&') {
      push();
      out.push({ op: two === ';;' ? ';' : two[0] === '|' ? '|' : two });
      i += 2;
    } else if (two === '>>' || two === '&>' || two === '>&' || two === '>|' || two === '<&') {
      redirect(two === '>|' ? '>' : two, 2);
    } else if (c === '>' || c === '<') {
      redirect(c, 1);
    } else if (';|&()'.includes(c)) {
      push();
      out.push({ op: c });
      i++;
    } else {
      add(c);
      i++;
    }
  }
  push();
  return out;
}

const base = (word) => String(word ?? '').split('/').pop();
const strictlyUnder = (path, root) => !!root && path.startsWith(`${root.replace(/\/+$/u, '')}/`);
const within = (path, root) => path === root || strictlyUnder(path, root);
// macOS: /tmp, /var and /etc are links into /private.
const variants = (p) => (/^\/(?:tmp|var|etc)(?:\/|$)/u.test(p) ? [p, `/private${p}`] : [p]);

/** Peel wrappers off a command: env, caffeinate, timeout, perl alarm, sudo, bash -c. */
function unwrap(words) {
  let w = words.slice();
  for (let n = 0; n < 10 && w.length; n++) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(w[0])) w.shift();
    const b = base(w[0]);
    const skip = (valued) => {
      w.shift();
      while (w.length && w[0].startsWith('-')) if (valued.includes(w.shift())) w.shift();
    };
    if (b === 'env') {
      skip(['-u', '-C', '-S']);
      while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(w[0])) w.shift();
    } else if (['nohup', 'time', 'command', 'exec', 'builtin', 'noglob'].includes(b)) skip([]);
    else if (b === 'sudo' || b === 'doas') skip(['-u', '-g', '-C', '-D', '-h', '-p', '-R', '-r', '-T', '-t']);
    else if (b === 'nice') skip(['-n']);
    else if (b === 'caffeinate') skip(['-t', '-w']);
    else if (b === 'xargs') skip(['-I', '-J', '-L', '-n', '-P', '-s', '-E']);
    else if (b === 'timeout' || b === 'gtimeout') {
      skip(['-s', '-k']);
      w.shift();
    } else if (b === 'perl' && w.includes('-e')) {
      const at = w.indexOf('-e');
      if (!/exec\s*\(?\s*@ARGV/u.test(w[at + 1] ?? '')) return { argv: w };
      w = w.slice(at + 2);
    } else if (['bash', 'sh', 'zsh', 'dash'].includes(b)) {
      const at = w.findIndex((x, k) => k > 0 && /^-[a-z]*c[a-z]*$/u.test(x));
      return at > 0 && typeof w[at + 1] === 'string' ? { argv: w, inner: w[at + 1] } : { argv: w };
    } else break;
  }
  return { argv: w };
}

/** The first word that is not an option, skipping each option's value. */
function subcommand(args, valued) {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) return { sub: args[i], at: i };
    if (valued.includes(args[i])) i++;
  }
  return { sub: undefined, at: args.length };
}

const GIT_VALUED = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'];
const NPM_VALUED = ['--prefix', '-w', '--workspace', '--loglevel', '--cache', '--registry', '--userconfig'];
const NPM_INSTALL = ['ci', 'install', 'i', 'in', 'add', 'isntall', 'clean-install', 'cit', 'it', 'install-test', 'install-clean-test', 'test', 't', 'tst'];
const DOCKER_VALUED = ['-c', '--config', '--context', '-H', '--host', '-l', '--log-level'];

function pushBypass(args) {
  const { sub, at } = subcommand(args, GIT_VALUED);
  if (sub !== 'push') return false;
  const globals = args.slice(0, at);
  const hooksPath = globals.some((a, i) => /^core\.hookspath=/iu.test(a) && ['-c', '--config-env'].includes(globals[i - 1]))
    || globals.some((a) => /^--config-env=core\.hookspath=/iu.test(a));
  const noVerify = args.slice(at + 1).some((a) => a.length > 5 && '--no-verify'.startsWith(a) && a.startsWith('--no-v'));
  return hooksPath || noVerify;
}

/** Where a build command builds: its `--prefix`, else the cwd; null when it is no build. */
function buildDir(b, args, cwd, ctx) {
  if (b === 'npm') {
    const { sub, at } = subcommand(args, NPM_VALUED);
    const script = subcommand(args.slice(at + 1), []).sub ?? '';
    const isRun = ['run', 'run-script', 'rum', 'urn'].includes(sub) && /^(?:build|verify)(?::|$)/u.test(script);
    if (!NPM_INSTALL.includes(sub) && !isRun) return null;
    const i = args.findIndex((a) => a === '--prefix' || a.startsWith('--prefix='));
    if (i < 0) return cwd;
    return ctx.abs(args[i].includes('=') ? args[i].slice(9) : args[i + 1] ?? '', cwd);
  }
  const words = b === 'npx' ? args.slice(subcommand(args, ['-p', '--package']).at) : [b, ...args];
  const [tool, ...rest] = words;
  const first = subcommand(rest, DOCKER_VALUED).sub;
  const built =
    (['expo'].includes(base(tool)) && first === 'export') ||
    (['next', 'eas', 'eas-cli'].includes(base(tool)) && first === 'build') ||
    (base(tool) === 'pod' && first === 'install') ||
    base(tool) === 'xcodebuild' ||
    (base(tool) === 'docker' && (first === 'build' || ((first === 'buildx' || first === 'image') && rest.includes('build')) || (first === 'compose' && rest.includes('up')))) ||
    (base(tool) === 'docker-compose' && rest.includes('up'));
  return built ? cwd : null;
}

function judgeCommand(words, redirects, cwd, ctx, depth) {
  const { argv, inner } = unwrap(words);
  if (inner !== undefined && depth < 3) {
    const nested = evaluate(inner, cwd, ctx, depth + 1);
    if (nested.exit === 2) return nested;
  }
  const [cmd, ...args] = argv;
  const b = base(cmd);
  const lc = (p) => p.toLowerCase();
  const inZone = (p, zone) => !!p && variants(lc(p)).some((v) => within(v, lc(zone)));
  // Row 4: a redirect, cp/mv's destination or tee's files inside iCloud Drive.
  const writes = [...redirects];
  if (b === 'tee') writes.push(...args.filter((a) => !a.startsWith('-')));
  if (b === 'cp' || b === 'mv') {
    const t = args.findIndex((a) => a === '-t' || a.startsWith('--target-directory'));
    const plain = args.filter((a) => !a.startsWith('-'));
    if (t >= 0) writes.push(args[t].includes('=') ? args[t].split('=')[1] : args[t + 1]);
    else if (plain.length >= 2) writes.push(plain[plain.length - 1]);
  }
  if (writes.some((t) => inZone(ctx.abs(t ?? '', cwd), ctx.icloud))) return block(4);
  if (!cmd) return ALLOW;
  if (b === 'git' && pushBypass(args)) return block(1);
  if (b === 'rm') {
    let recursive = false;
    let force = false;
    const targets = [];
    let options = true;
    for (const a of args) {
      if (options && a === '--') options = false;
      else if (options && a === '--recursive') recursive = true;
      else if (options && a === '--force') force = true;
      else if (options && /^-[a-zA-Z]+$/u.test(a)) {
        recursive ||= /[rR]/u.test(a);
        force ||= a.includes('f');
      } else if (!options || !a.startsWith('--')) targets.push(a);
    }
    if (recursive && force) {
      for (const t of targets) {
        if (/^(?:\/+|~\/?|\$HOME\/?|\$\{HOME\}\/?)$/u.test(t)) return block(2, t);
        const p = ctx.abs(t, cwd);
        if (!p || /[$`]/u.test(p)) return block(2, `cannot tell where ${t} is`);
        const roots = ['/private/tmp', '/tmp', ctx.scratch];
        if (variants(p).some((v) => roots.some((r) => strictlyUnder(v, r)))) continue;
        const top = cwd ? ctx.toplevel(cwd) : null;
        if (top && variants(p).some((v) => variants(top).some((r) => strictlyUnder(v, r)))) continue;
        return block(2, t);
      }
    }
  }
  const dir = buildDir(b, args, cwd, ctx);
  if (dir && (inZone(dir, ctx.desktop) || inZone(dir, ctx.icloud))) return block(3, b);
  const execute = args.some((a) => /^--execute(?:=|$)/u.test(a));
  if (execute && b === 'npm' && ['run', 'run-script'].includes(subcommand(args, NPM_VALUED).sub) && args.includes('hygiene')) return block(5);
  if (execute && b === 'node' && args.some((a) => /(?:^|\/)hygiene\.mjs$/u.test(a))) return block(5);
  return ALLOW;
}

/** Every simple command in `src`, in order, with the cwd `cd` leaves it in. */
function evaluate(src, startCwd, ctx, depth = 0) {
  const tokens = tokenize(src);
  const stack = [];
  let cwd = startCwd;
  let words = [];
  let redirects = [];
  const finish = () => {
    const verdict = judgeCommand(words, redirects, cwd, ctx, depth);
    const [cmd, ...args] = unwrap(words).argv;
    if (cmd === 'cd' || cmd === 'pushd') {
      const target = args.find((a) => !a.startsWith('-') || a === '-');
      cwd = target === undefined ? ctx.home : target === '-' ? null : ctx.abs(target, cwd);
      if (cwd && /[$`]/u.test(cwd)) cwd = null;
    } else if (cmd === 'popd') cwd = null;
    words = [];
    redirects = [];
    return verdict;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.w !== undefined) words.push(t.w);
    else if (t.op === '>' || t.op === '<') {
      const target = tokens[i + 1]?.w;
      if (target !== undefined) i++;
      if (t.op === '>' && target !== undefined) redirects.push(target);
    } else {
      const verdict = finish();
      if (verdict.exit === 2) return verdict;
      if (t.op === '(') stack.push(cwd);
      if (t.op === ')' && stack.length) cwd = stack.pop();
    }
  }
  return finish();
}

/** The policy. `env`: HOME, SCRATCH (the scratch root) and `toplevel(cwd)` may be given. */
export function decide(input, env = process.env) {
  try {
    if (!input || typeof input !== 'object') return ALLOW;
    const home = (env.HOME || homedir()).replace(/\/+$/u, '');
    const ctx = {
      home,
      scratch: env.SCRATCH || scratchRoot(),
      desktop: `${home}/Desktop`,
      icloud: `${home}/Library/Mobile Documents`,
      toplevel: typeof env.toplevel === 'function' ? env.toplevel : gitToplevel,
      abs(word, cwd) {
        let p = String(word);
        if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
        p = p.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/u, home);
        if (isAbsolute(p)) return normalize(p);
        return cwd ? resolve(cwd, p) : null;
      },
    };
    const tool = input.tool_name;
    const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd();
    if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
      const path = ti.file_path ?? ti.notebook_path;
      if (typeof path !== 'string') return ALLOW;
      const p = ctx.abs(path, cwd);
      const zone = ctx.icloud.toLowerCase();
      return p && variants(p.toLowerCase()).some((v) => within(v, zone)) ? block(4) : ALLOW;
    }
    if (tool !== 'Bash' || typeof ti.command !== 'string') return ALLOW;
    return evaluate(ti.command, cwd, ctx);
  } catch {
    return ALLOW;
  }
}

function gitToplevel(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

const isMain = () => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  let verdict = ALLOW;
  try { verdict = decide(JSON.parse(readFileSync(0, 'utf8'))); } catch { verdict = ALLOW; }
  if (verdict.exit === 2) process.stderr.write(`${verdict.reason}\n`);
  process.exitCode = verdict.exit === 2 ? 2 : 0;
}
