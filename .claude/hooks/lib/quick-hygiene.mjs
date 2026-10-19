// autom8x-kit v1 — canonical: snoopy-backend/.claude/hooks/lib/quick-hygiene.mjs
// Quick, read-only facts about what Claude sessions on this machine left behind:
// processes under the scratch root, autom8x-* temp folders, scratch sessions, the
// gate lock and the tail of the hygiene warnings log (STANDARD (h)). Facts only, no
// thresholds: those live in the backend's hygiene config (STANDARD (j)). Every probe
// has a 1 s timeout and reports nothing rather than throwing. `makeProbes(deps)`
// takes fake readers for tests (scripts/kit/kit.test.mjs); the named exports use
// the real ones. Home and uid are read at runtime, never written down.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL = {
  uid: () => (typeof process.getuid === 'function' ? process.getuid() : 0),
  tmpdir: () => tmpdir(),
  now: () => Date.now(),
  readdir(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  stat(path) {
    try {
      const s = statSync(path);
      return { mtimeMs: s.mtimeMs, dir: s.isDirectory() };
    } catch {
      return null;
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  ps() {
    const r = spawnSync('ps', ['-axo', 'pid,etime,command'], { encoding: 'utf8', timeout: 1000 });
    return r.status === 0 ? r.stdout : '';
  },
};

/** `3d4h`, `5h12m`, `40m`, `30s`: an age, short. */
export function age(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${m}m`;
  return m ? `${m}m` : `${s}s`;
}

export function makeProbes(deps = {}) {
  const d = { ...REAL, ...deps };
  const scratchRoot = () => `/private/tmp/claude-${d.uid()}`;
  // Claude Code names a project's scratch folder after its cwd, every character
  // that is not a letter or digit turned into '-' (observed; a fact, not a rule).
  const slug = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/gu, '-');
  function sessionDir(cwd, sessionId) {
    const project = join(scratchRoot(), slug(cwd));
    if (sessionId && /^[\w-]+$/u.test(sessionId)) {
      const own = join(project, sessionId);
      if (d.stat(own)?.dir) return own;
    }
    return project;
  }
  function processesUnder(dir, exclude = [process.pid, process.ppid]) {
    const skip = new Set(exclude.map(String));
    return d
      .ps()
      .split('\n')
      .slice(1)
      .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/u.exec(line))
      .filter((m) => m && m[3].includes(dir) && !skip.has(m[1]))
      .map((m) => ({ pid: Number(m[1]), etime: m[2], command: m[3] }));
  }
  function tempDirs() {
    const roots = [...new Set(['/private/tmp', d.tmpdir()])];
    return roots.flatMap((root) =>
      d
        .readdir(root)
        .filter((name) => name.startsWith('autom8x-'))
        .map((name) => join(root, name))
        .map((path) => ({ path, ageMs: d.now() - (d.stat(path)?.mtimeMs ?? d.now()) })),
    );
  }
  function scratchSessions() {
    const root = scratchRoot();
    const out = [];
    for (const project of d.readdir(root)) {
      const pdir = join(root, project);
      if (!project.startsWith('-') || !d.stat(pdir)?.dir) continue;
      for (const session of d.readdir(pdir)) {
        const s = d.stat(join(pdir, session));
        if (s?.dir) out.push({ path: join(pdir, session), ageMs: d.now() - s.mtimeMs });
      }
    }
    return out.sort((a, b) => b.ageMs - a.ageMs);
  }
  function gateLock() {
    const lock = join(scratchRoot(), 'autom8x-gate.lock');
    const holder = d.readFile(join(lock, 'holder'));
    if (holder === null) return null;
    return { holder: holder.trim(), ageMs: d.now() - (d.stat(lock)?.mtimeMs ?? d.now()) };
  }
  const warningsLog = () => join(scratchRoot(), 'hygiene-warnings.log');
  function warningsTail(n = 3) {
    const text = d.readFile(warningsLog()) ?? '';
    return text.split('\n').filter((line) => line.trim() !== '').slice(-n);
  }
  function quickSummary() {
    const procs = processesUnder(scratchRoot());
    const temps = tempDirs();
    const sessions = scratchSessions();
    const lock = gateLock();
    const lines = [
      `hygiene: scratch processes ${procs.length} · autom8x temp dirs ${temps.length} · ` +
        `scratch sessions ${sessions.length}` +
        (sessions.length ? ` (oldest ${age(sessions[0].ageMs)})` : '') +
        ` · gate lock ${lock ? `held by ${lock.holder} for ${age(lock.ageMs)}` : 'free'}`,
    ];
    for (const p of procs.slice(0, 3)) {
      lines.push(`  pid ${p.pid} ${p.etime} ${p.command.slice(0, 100)}`);
    }
    const tail = warningsTail(3);
    if (tail.length) lines.push('hygiene warnings (latest):', ...tail.map((l) => `  ${l.slice(0, 160)}`));
    return lines;
  }
  return {
    scratchRoot,
    sessionDir,
    processesUnder,
    tempDirs,
    scratchSessions,
    gateLock,
    warningsLog,
    warningsTail,
    quickSummary,
  };
}

const probes = makeProbes();
export const {
  scratchRoot,
  sessionDir,
  processesUnder,
  tempDirs,
  scratchSessions,
  gateLock,
  warningsLog,
  warningsTail,
  quickSummary,
} = probes;
