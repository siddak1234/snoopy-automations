import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * The shared kit (the engineering standard's section 0: `.claude/hooks/`,
 * `.claude/agents/`, `scripts/kit/`), byte-identical in all four repositories. Its
 * own tests run here, inside this repository's gate; then the kit is run against
 * this repository: `docs/MAP.md` is current, `docs/docs-map.json` is sound and the
 * line limits hold, and `.claude/settings.json` runs the three hooks.
 */
await import(new URL('../scripts/kit/kit.test.mjs', import.meta.url).href);

const repositoryRoot = resolve(import.meta.dirname, '..');
const run = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(repositoryRoot, script), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

test('docs/MAP.md is current (npm run map -- --check)', () => {
  const result = run('scripts/kit/map.mjs', '--check');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('docs/docs-map.json is sound and the line limits hold (check-docs --map-only)', () => {
  const result = run('scripts/kit/check-docs.mjs', '--map-only');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string; timeout: number }[];
}

test('.claude/settings.json runs the three kit hooks', () => {
  const settings = JSON.parse(
    readFileSync(join(repositoryRoot, '.claude/settings.json'), 'utf8'),
  ) as { hooks: Record<string, HookGroup[]> };
  const entries = (event: string) =>
    (settings.hooks[event] ?? []).flatMap((group) =>
      group.hooks.map((hook) => ({ matcher: group.matcher, ...hook })),
    );
  const hook = (file: string, timeout: number, matcher?: string) => ({
    matcher,
    type: 'command',
    command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${file}"`,
    timeout,
  });
  assert.deepEqual(entries('PreToolUse'), [hook('guard.mjs', 5, 'Bash|Write|Edit|NotebookEdit')]);
  assert.deepEqual(entries('SessionStart'), [hook('session-start.mjs', 10)]);
  assert.deepEqual(entries('Stop'), [hook('stop-check.mjs', 10)]);
  assert.deepEqual(entries('SubagentStop'), [hook('stop-check.mjs', 10)]);
});
