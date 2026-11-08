// autom8x-kit v1 — canonical: snoopy-backend/.claude/hooks/guard.mjs
// PreToolUse guard (STANDARD (h), rows 1–9). Blocks, with exit 2 and a one-line
// reason naming the allowed alternative, only the exact patterns its table names;
// row 9 never blocks: it asks the owner (stdout `permissionDecision: "ask"`, exit 0)
// before a write outside the scratch root and a project's memory, a Bash write into
// ~/Downloads, ~/Desktop, ~/Documents or iCloud Drive, or an Artifact publish or delete.
// Rows 1–5 decide first: a block wins over an ask, in the same part of a command or another.
// Anything it cannot read, including its own errors, exits 0 (fail open).
// `decide(input, env)` is the whole policy and runs nothing: the only process it
// may start is `git rev-parse --show-toplevel` (1 s) for an `rm -rf` target.
// Shell text is tokenised (lib/shell-words.mjs) with quotes respected, split on
// && || ; | & and newlines, heredoc bodies skipped, `cd` tracked per part and wrappers
// (`perl -e '… exec @ARGV'`, caffeinate, timeout, env, sudo, bash -c) unwrapped. A variable
// the same text sets (`NAME=value`, `export NAME=value`) is read in its later words, HOME too;
// a path still naming an unknown one is never resolved against the cwd: row 9 does not ask on
// it, and row 2 still refuses an `rm -rf` of it.
// Cases: cases.json, run by scripts/kit/kit.test.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchRoot } from './lib/quick-hygiene.mjs';
import { tokenize } from './lib/shell-words.mjs';

const ALLOW = Object.freeze({ exit: 0, reason: '' });
const REASONS = {
  1: 'git push --no-verify (or core.hooksPath) skips the pre-push gate — make the gate green and push without it',
  2: 'rm -rf outside this repo, /tmp and the scratch root (or on /, ~, $HOME, an unexpanded $VAR) — name a path inside one of them',
  3: 'install/build/test under ~/Desktop or iCloud Drive — run it in a scratch clone under /private/tmp',
  4: 'writing into iCloud Drive (~/Library/Mobile Documents) — write into the repo or the scratch folder',
  5: 'npm run hygiene --execute changes production hosts — the owner runs it; --clean prints the commands',
};
const block = (row, detail) => ({ exit: 2, row, reason: `guard #${row}: ${REASONS[row]}${detail ? ` (${detail})` : ''}` });
// Row 9, the owner's rule of 2026-11-06, in the words the owner sees in the prompt.
const OUTSIDE = "Outside the repositories and the scratchpad only on the owner's explicit ask (the owner, 2026-11-06).";
const ask = (detail) => ({ exit: 0, ask: true, row: 9, reason: `${OUTSIDE} guard #9: ${detail}` });

const base = (word) => String(word ?? '').split('/').pop();
const strictlyUnder = (path, root) => !!root && path.startsWith(`${root.replace(/\/+$/u, '')}/`);
const within = (path, root) => path === root || strictlyUnder(path, root);
// macOS: /tmp, /var and /etc are links into /private.
const variants = (p) => (/^\/(?:tmp|var|etc)(?:\/|$)/u.test(p) ? [p, `/private${p}`] : [p]);

// A shell assignment, `NAME=value`, alone or after export/declare/local/readonly/typeset: the
// later words of the same command text read its value (2026-11-08: row 9 had asked the owner 27
// times about `$R/plan.md`, a scratchpad path, read as a folder of the cwd).
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su;
const DECLARES = ['export', 'declare', 'local', 'readonly', 'typeset'];
/** `$NAME` and `${NAME}` as `vars` holds them; an unknown one stays as written. */
const expand = (word, vars) =>
  String(word).replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu, (whole, a, b) => vars.get(a ?? b) ?? whole);

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
const NPM_RUN = ['run', 'run-script', 'rum', 'urn'];

/** Where an npm command runs: its `--prefix`, else the cwd. */
function npmDir(args, cwd, ctx) {
  const i = args.findIndex((a) => a === '--prefix' || a.startsWith('--prefix='));
  if (i < 0) return cwd;
  return ctx.abs(args[i].includes('=') ? args[i].slice(9) : args[i + 1] ?? '', cwd);
}

/** The package.json script an `npm run` names and where it runs, read only where `zoned`; else null. */
function npmScript(args, cwd, ctx, zoned) {
  const { sub, at } = subcommand(args, NPM_VALUED);
  const name = subcommand(args.slice(at + 1), []).sub;
  const dir = NPM_RUN.includes(sub) && name ? npmDir(args, cwd, ctx) : null;
  if (!dir || !zoned(dir)) return null;
  try {
    const text = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).scripts?.[name];
    return typeof text === 'string' ? { dir, text } : null;
  } catch {
    return null;
  }
}

function pushBypass(args) {
  const { sub, at } = subcommand(args, GIT_VALUED);
  if (sub !== 'push') return false;
  const globals = args.slice(0, at);
  const hooksPath = globals.some((a, i) => /^core\.hookspath=/iu.test(a) && ['-c', '--config-env'].includes(globals[i - 1]))
    || globals.some((a) => /^--config-env=core\.hookspath=/iu.test(a));
  const noVerify = args.slice(at + 1).some((a) => a.length > 5 && '--no-verify'.startsWith(a) && a.startsWith('--no-v'));
  return hooksPath || noVerify;
}

/** A command's operands: its words that are not options (nor `valued` options' values); after `--`, every word. */
function operands(args, valued = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return [...out, ...args.slice(i + 1)];
    if (!args[i].startsWith('-')) out.push(args[i]);
    else if (valued.includes(args[i])) i++;
  }
  return out;
}

// curl's flags that take no value, as a combined short option holds them before `o` or `O`.
const CURL_FLAGS = 'sSLfkvi#';

/**
 * Row 9: what a command writes, by the forms the owner's rule names — a redirect, `cp`, `mv` (its
 * sources too: a move takes them away), `tee`, `touch`, `mkdir`, `rm` and curl's output (`-o`,
 * `--output`, or `-O` into `--output-dir` or the cwd). `writes` holds row 4's: the redirects,
 * `tee`'s files and `cp`/`mv`'s destination. `open -a` writes nothing.
 */
function rowNineWrites(b, args, writes) {
  const out = [...writes];
  if (b === 'touch') out.push(...operands(args, ['-t', '-d', '-r', '-A']));
  if (b === 'mkdir') out.push(...operands(args, ['-m']));
  if (b === 'rm' || b === 'mv') out.push(...operands(args));
  if (b === 'curl') {
    let dir = '.';
    let remote = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const long = /^--(output|output-dir)(?:=(.*))?$/u.exec(a);
      if (long) {
        const value = long[2] ?? args[++i];
        if (long[1] === 'output') out.push(value);
        else dir = value;
      } else if (/^--remote-name(?:-all)?$/u.test(a)) remote = true;
      else if (new RegExp(`^-[${CURL_FLAGS}]*o$`, 'u').test(a)) out.push(args[++i]);
      else if (/^-o./u.test(a)) out.push(a.slice(2));
      else if (new RegExp(`^-[${CURL_FLAGS}]*O[${CURL_FLAGS}]*$`, 'u').test(a)) remote = true;
    }
    if (remote) out.push(dir);
  }
  return out.filter((t) => typeof t === 'string' && t !== '' && t !== '-');
}

/** Where a build command builds: its `--prefix`, else the cwd; null when it is no build. */
function buildDir(b, args, cwd, ctx) {
  if (b === 'npm') {
    const { sub, at } = subcommand(args, NPM_VALUED);
    const script = subcommand(args.slice(at + 1), []).sub ?? '';
    // `release:ios` builds with EAS through a shell script, so its text cannot say so.
    const isRun = NPM_RUN.includes(sub) && /^(?:build|verify)(?::|$)|^release:ios$/u.test(script);
    if (!NPM_INSTALL.includes(sub) && !isRun) return null;
    return npmDir(args, cwd, ctx);
  }
  const words = b === 'npx' ? args.slice(subcommand(args, ['-p', '--package']).at) : [b, ...args];
  const [tool, ...rest] = words;
  // `npx eas-cli@27.2.0 build` names the package with its version; a scoped name keeps its `@`.
  const pkg = base(tool ?? '').replace(/(?<=.)@[^/@]*$/u, '');
  const first = subcommand(rest, DOCKER_VALUED).sub;
  const built =
    (['expo'].includes(pkg) && first === 'export') ||
    (['next', 'eas', 'eas-cli'].includes(pkg) && first === 'build') ||
    (base(tool) === 'pod' && first === 'install') ||
    base(tool) === 'xcodebuild' ||
    (base(tool) === 'docker' && (first === 'build' || ((first === 'buildx' || first === 'image') && rest.includes('build')) || (first === 'compose' && rest.includes('up')))) ||
    (base(tool) === 'docker-compose' && rest.includes('up'));
  return built ? cwd : null;
}

function judgeCommand(words, redirects, cwd, ctx, depth) {
  const { argv, inner } = unwrap(words);
  // An ask inside `bash -c` stands unless this command blocks.
  let nested = ALLOW;
  if (inner !== undefined && depth < 3) {
    nested = evaluate(inner, cwd, ctx, depth + 1);
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
  // Row 9, decided after every block: the first write into a folder of the owner's.
  const asking = () => {
    const owned = rowNineWrites(b, args, writes)
      // A target still naming a variable or a substitution: where it is cannot be read, so row 9
      // fails open on it, as on anything else it cannot read (never resolved against the cwd).
      .filter((t) => !/[$`]/u.test(t))
      .map((t) => ctx.abs(t, cwd))
      .find((p) => p && ctx.owned.some((zone) => inZone(p, zone)));
    return owned ? ask(`Bash writes ${owned}`) : nested;
  };
  if (!cmd) return asking();
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
  // An npm script whose own text builds (`eas build`, …) is that build.
  const run = b === 'npm' && depth < 3 ? npmScript(args, cwd, ctx, (p) => inZone(p, ctx.desktop) || inZone(p, ctx.icloud)) : null;
  if (run && evaluate(run.text, run.dir, ctx, depth + 1).row === 3) return block(3, b);
  const execute = args.some((a) => /^--execute(?:=|$)/u.test(a));
  if (execute && b === 'npm' && ['run', 'run-script'].includes(subcommand(args, NPM_VALUED).sub) && args.includes('hygiene')) return block(5);
  if (execute && b === 'node' && args.some((a) => /(?:^|\/)hygiene\.mjs$/u.test(a))) return block(5);
  return asking();
}

/** Every simple command in `src`, in order, with the cwd `cd` leaves it in: a block, else the first ask. */
function evaluate(src, startCwd, ctx, depth = 0) {
  const tokens = tokenize(src);
  const stack = [];
  let cwd = startCwd;
  let words = [];
  let redirects = [];
  let asked = null;
  // What this command text has set so far, and HOME; every word is read through it.
  const vars = new Map([['HOME', ctx.home]]);
  const finish = () => {
    const expanded = words.map((w) => expand(w, vars));
    const verdict = judgeCommand(expanded, redirects.map((r) => expand(r, vars)), cwd, ctx, depth);
    const set = (w) => {
      const [, name, value] = ASSIGNMENT.exec(w);
      vars.set(name, value);
    };
    if (expanded.length && expanded.every((w) => ASSIGNMENT.test(w))) expanded.forEach(set);
    else if (DECLARES.includes(expanded[0])) expanded.slice(1).filter((w) => ASSIGNMENT.test(w)).forEach(set);
    const [cmd, ...args] = unwrap(expanded).argv;
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
      if (verdict.ask) asked ??= verdict;
      if (t.op === '(') stack.push(cwd);
      if (t.op === ')' && stack.length) cwd = stack.pop();
    }
  }
  const last = finish();
  return last.exit === 2 ? last : (asked ?? last);
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
      owned: ['Downloads', 'Desktop', 'Documents', 'Library/Mobile Documents'].map((d) => `${home}/${d}`),
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
      if (!p) return ALLOW;
      const forms = variants(p.toLowerCase());
      if (forms.some((v) => within(v, ctx.icloud.toLowerCase()))) return block(4);
      // Row 9: files go in the scratch root (sessions' scratchpads and their clones) or a project's memory.
      const escaped = home.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const memory = new RegExp(`^${escaped}/\\.claude/projects/[^/]+/memory/`, 'u');
      return forms.some((v) => strictlyUnder(v, ctx.scratch.toLowerCase()) || memory.test(v)) ? ALLOW : ask(`${tool} ${p}`);
    }
    // Row 9: an Artifact call publishes when it names no action.
    if (tool === 'Artifact') {
      const action = ti.action;
      return action == null || action === 'publish' || action === 'delete' ? ask(`Artifact ${action ?? 'with no action (a publish)'}`) : ALLOW;
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
  // Row 9: PreToolUse's JSON decision, which Claude Code reads only on exit 0 (code.claude.com/docs/en/hooks.md).
  const output = { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: verdict.reason };
  if (verdict.ask) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: output })}\n`);
  process.exitCode = verdict.exit === 2 ? 2 : 0;
}
