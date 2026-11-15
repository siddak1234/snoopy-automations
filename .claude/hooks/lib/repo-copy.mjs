// autom8x-kit v1 — canonical: snoopy-backend/.claude/hooks/lib/repo-copy.mjs
// Guard row 10's question (STANDARD (h); BUILD-PLAN 30.17, the owner, 2026-11-14): inside the
// scratch root a write lands only in a repository copy — a git work tree whose top level is under
// the root and which has an `origin` remote (a bare `git init` makes none), anywhere in it, its
// `.git` included — or in a session's one Docker settings folder,
// `<root>/<project>/<session>/scratchpad/docker-config`. Outside the root it says nothing.
// It starts only `git rev-parse --show-toplevel` (from the nearest existing directory, real path)
// and `git config --get remote.origin.url` (once per top level), all within one budget of
// `budgetMs` per guard decision; one answer per directory. A timeout, a spawn error, or any git
// failure but exit 128 "not a git repository" allows (fail open).
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** macOS: /tmp, /var and /etc are links into /private. */
export const variants = (p) => (/^\/(?:tmp|var|etc)(?:\/|$)/u.test(p) ? [p, `/private${p}`] : [p]);
const DOCKER = /^[^/]+\/[^/]+\/scratchpad\/docker-config(?:\/|$)/u;
// git's repository variables would point git at another repository than the folder it is given,
// and its config variables could inject `remote.origin.url` (a work tree with no origin would read as
// a copy): `git rev-parse --local-env-vars` lists the first set; the config set and
// GIT_CEILING_DIRECTORIES are added. None of them reaches row 10's git.
const GIT_REPO_VARS =
  /^GIT_(?:ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|OBJECT_DIRECTORY|DIR|WORK_TREE|IMPLICIT_WORK_TREE|GRAFT_FILE|INDEX_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|PREFIX|INTERNAL_SUPER_PREFIX|SHALLOW_FILE|COMMON_DIR|CEILING_DIRECTORIES)$/u;

/**
 * One guard decision's row 10. `scratch` is the scratch root; `run`, `stat`, `real` and `now` are
 * spawnSync, statSync, realpathSync and Date.now unless a test gives fakes.
 */
export function makeRowTen({ scratch, budgetMs = 1000, run = spawnSync, stat = statSync, real = realpathSync, now = Date.now }) {
  const deadline = now() + budgetMs;
  const lc = (p) => p.toLowerCase().replace(/\/+$/u, '');
  const tryReal = (p) => { try { return real(p); } catch { return null; } };
  // The root as given and as the file system names it: git prints real paths.
  const roots = [...new Set([scratch, tryReal(scratch)].filter(Boolean).flatMap((r) => variants(lc(r))))];
  /** `path` relative to the scratch root, lower case; null outside it. */
  const rel = (path) => {
    for (const v of variants(lc(path))) for (const r of roots) if (v.startsWith(`${r}/`)) return v.slice(r.length + 1);
    return null;
  };
  // In English (LC_ALL=C), so "not a git repository" reads the same in any locale.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_REPO_VARS.test(key))), LC_ALL: 'C' };
  /** A git command's result, or null when the budget is spent or git could not be run (fail open). */
  const git = (args) => {
    const left = deadline - now();
    if (left <= 0) return null;
    const r = run('git', args, { encoding: 'utf8', timeout: left, env });
    return r.error || r.signal ? null : r;
  };
  /** The nearest existing directory at or above `path`, as a real path; a `.git` inside it cut off. */
  const nearest = (path) => {
    for (let p = path; ; p = dirname(p)) {
      try {
        const dir = real(stat(p).isDirectory() ? p : dirname(p));
        const at = dir.split('/').indexOf('.git');
        return at > 0 ? dir.split('/').slice(0, at).join('/') : dir;
      } catch {
        if (p === dirname(p)) return null;
      }
    }
  };
  const origins = new Map();
  const answers = new Map();
  const copy = (dir) => {
    const r = git(['-C', dir, 'rev-parse', '--show-toplevel']);
    if (!r) return true;
    if (r.status !== 0) return !(r.status === 128 && /not a git repository/iu.test(r.stderr ?? ''));
    const top = r.stdout.trim();
    if (rel(top) === null) return false;
    if (!origins.has(top)) {
      const o = git(['-C', top, 'config', '--get', 'remote.origin.url']);
      origins.set(top, !o || o.status !== 1);
    }
    return origins.get(top);
  };
  return {
    /** Whether `path` (absolute) lies inside the scratch root, under either of its names. */
    inside: (path) => rel(path) !== null,
    /** Row 10: false only for a write inside the scratch root that is in no copy and no docker-config. */
    allowed(path) {
      const r = rel(path);
      if (r === null || DOCKER.test(r)) return true;
      const dir = nearest(path);
      if (!dir) return true;
      if (!answers.has(dir)) answers.set(dir, copy(dir));
      return answers.get(dir);
    },
  };
}
