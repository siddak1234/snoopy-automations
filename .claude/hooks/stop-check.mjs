// autom8x-kit v1 — canonical: snoopy-backend/.claude/hooks/stop-check.mjs
// Stop and SubagentStop hook (STANDARD (h)): processes still running under this
// session's scratch folder, and files left in its scratchpad outside a repository copy
// and its docker-config (BUILD-PLAN 30.17), each become a stderr warning and one line
// appended to <scratch root>/hygiene-warnings.log, which SessionStart and the backend's
// hygiene surface. The loose-files warning is also printed on stdout as the hook's JSON
// `systemMessage`, which Claude Code shows the user at the end of the turn (the session's
// proposal, which the owner chose: "an end-of-turn check lists anything left behind"); the processes warning is not, since
// a session's own running builds would show every turn. It ALWAYS exits 0: a block would
// make Claude continue, and the rule is "warn, never loop".
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { counted, looseFiles, processesUnder, sessionDir, warningsLog } from './lib/quick-hygiene.mjs';

/** The warning for `input` (the hook's stdin JSON), or null; `append` writes the log lines. */
export function stopCheck(input, probes = { processesUnder, sessionDir, warningsLog, looseFiles }, append = appendFileSync) {
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const id = typeof input?.session_id === 'string' ? input.session_id : undefined;
  const dir = probes.sessionDir(cwd, id);
  const found = [];
  const left = probes.processesUnder(dir);
  if (left.length) {
    const list = left.map((p) => `pid ${p.pid} (${p.etime}) ${p.command.slice(0, 120)}`).join('; ');
    found.push([
      `${left.length} process(es) still running under ${dir}: ${list}`,
      `${left.length} process(es) still running under ${dir} — stop each one you started, or name it in your leftovers: ${list}`,
    ]);
  }
  // Only the session's own folder has a scratchpad; sessionDir falls back to the project's.
  const loose = id && probes.looseFiles && dir.endsWith(`/${id}`) ? probes.looseFiles(dir) : { count: 0 };
  if (loose.count) {
    const what = `${counted(loose)} loose file(s) in this session's scratchpad outside a repository copy: ${loose.paths.slice(0, 5).join(', ')}`;
    found.push([what, `${what} — answers go in the reply; move what a repository needs into its copy and remove the rest`]);
  }
  if (found.length === 0) return null;
  for (const [line] of found) {
    try {
      append(probes.warningsLog(), `${new Date().toISOString()} stop-check: ${line}\n`);
    } catch {
      // the log is a convenience; the warning still goes to stderr
    }
  }
  return found.map(([, warning]) => `stop-check: ${warning}`).join('\n');
}

/** The hook's stdout: the loose-files lines of `warning` as JSON `systemMessage`, or '' (nothing to show). */
export function userMessage(warning) {
  const loose = (warning ?? '').split('\n').filter((line) => /loose file\(s\) in this session's scratchpad/u.test(line));
  return loose.length ? `${JSON.stringify({ systemMessage: loose.join('\n') })}\n` : '';
}

const isMain = () => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  try {
    let input = null;
    try {
      input = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      input = null;
    }
    const warning = stopCheck(input);
    if (warning) process.stderr.write(`${warning}\n`);
    process.stdout.write(userMessage(warning));
  } catch {
    // fail open
  }
  process.exitCode = 0;
}
