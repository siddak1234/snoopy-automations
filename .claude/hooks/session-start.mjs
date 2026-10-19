// autom8x-kit v1 — canonical: snoopy-backend/.claude/hooks/session-start.mjs
// SessionStart hook (STANDARD (h)): 15 lines or fewer on stdout, added to the
// session's context. Git state from local refs only (no fetch): repo, branch,
// ahead/behind origin/main, dirty count, worktrees, stashes; then the quick
// hygiene facts (lib/quick-hygiene.mjs). Facts only, no thresholds; every probe
// has a 1 s timeout; any error of its own exits 0 with what it has.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quickSummary } from './lib/quick-hygiene.mjs';

export const MAX_LINES = 15;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

const count = (text) => (text === null ? '?' : text === '' ? 0 : text.split('\n').length);

/** The git line(s) for `cwd`. */
export function gitLines(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  if (top === null) return [`not a git repository: ${cwd}`];
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') ?? '?';
  const lr = git(cwd, 'rev-list', '--left-right', '--count', 'origin/main...HEAD');
  const [behind, ahead] = lr ? lr.split(/\s+/u) : [];
  const worktrees = git(cwd, 'worktree', 'list', '--porcelain');
  return [
    `${basename(top)} · branch ${branch} · ` +
      (lr ? `origin/main ahead ${ahead} behind ${behind} (local refs, no fetch)` : 'no local origin/main') +
      ` · dirty ${count(git(cwd, 'status', '--porcelain'))}` +
      ` · worktrees ${worktrees === null ? '?' : worktrees.split('\n').filter((l) => l.startsWith('worktree ')).length}` +
      ` · stashes ${count(git(cwd, 'stash', 'list'))}`,
  ];
}

export function sessionLines(cwd, summary = quickSummary) {
  let lines;
  try {
    lines = gitLines(cwd);
  } catch {
    lines = [];
  }
  try {
    lines.push(...summary());
  } catch {
    // a probe failed; report what there is
  }
  return lines.slice(0, MAX_LINES);
}

function hookCwd() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (typeof input?.cwd === 'string' && input.cwd) return input.cwd;
  } catch {
    // no stdin, or not JSON: fall back
  }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const isMain = () => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  try {
    process.stdout.write(`${sessionLines(hookCwd()).join('\n')}\n`);
  } catch {
    // fail open
  }
  process.exitCode = 0;
}
