// autom8x-kit v1 — canonical: snoopy-backend/.claude/hooks/stop-check.mjs
// Stop and SubagentStop hook (STANDARD (h)): processes still running under this
// session's scratch folder become a stderr warning and one line appended to
// <scratch root>/hygiene-warnings.log, which SessionStart and the backend's
// hygiene surface. It ALWAYS exits 0: a block would make Claude continue, and the
// rule is "warn, never loop".
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { processesUnder, sessionDir, warningsLog } from './lib/quick-hygiene.mjs';

/** The warning for `input` (the hook's stdin JSON), or null; `append` writes the log line. */
export function stopCheck(input, probes = { processesUnder, sessionDir, warningsLog }, append = appendFileSync) {
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dir = probes.sessionDir(cwd, typeof input?.session_id === 'string' ? input.session_id : undefined);
  const left = probes.processesUnder(dir);
  if (left.length === 0) return null;
  const list = left.map((p) => `pid ${p.pid} (${p.etime}) ${p.command.slice(0, 120)}`).join('; ');
  const line = `${new Date().toISOString()} stop-check: ${left.length} process(es) still running under ${dir}: ${list}`;
  try {
    append(probes.warningsLog(), `${line}\n`);
  } catch {
    // the log is a convenience; the warning still goes to stderr
  }
  return `stop-check: ${left.length} process(es) still running under ${dir} — stop each one you started, or name it in your leftovers: ${list}`;
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
  } catch {
    // fail open
  }
  process.exitCode = 0;
}
