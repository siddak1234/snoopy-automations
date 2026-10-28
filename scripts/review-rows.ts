import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The review checklist's machine-checkable rows (Round 21, R3; `/create-flow`'s
 * `.claude/skills/create-flow/templates/review.md` marks them), for every flow a range touches:
 *
 *   tsx scripts/review-rows.ts [--base <ref>] [--summary <file>]
 *
 * prints one table per flow — §3 the menu, §4 the capabilities, §6 the steps, §7 the blocks, §8
 * the failure words, §9 the tests, Paths, Drill — appends it to `--summary` (CI's
 * `$GITHUB_STEP_SUMMARY`) and exits 1 on any FAIL. Without `--base` it reads every flow. The two
 * live flows are exempt from the rows the new standards add (§7, §8, §9, Drill) until their
 * after-pilot versions, the exemption `test/conformance.test.ts` names. `test/menu.test.ts` holds
 * the menu half (B2.4) on the whole tree, and `test/review-rows.test.ts` each row.
 */

export const root = resolve(import.meta.dirname, '..');
export const MENU_PATH = 'contract/schemas/platform-menu.json';
/** The flows built before `defineFlow`, exempt from its rows until their after-pilot versions. */
export const LIVE_FLOWS: ReadonlySet<string> = new Set([
  'invoice-processing',
  'candidate-reviewer',
]);
/** Files a flow's pull request may carry beside its folder and manifest: generated, folded by GitHub. */
const GENERATED = ['package-lock.json', 'docs/MAP.md', 'docs/repo-facts/snoopy-automations.json'];

export interface Menu {
  providers: { id: string; operations: { name: string }[] }[];
  capabilities: string[];
}

interface ManifestShape {
  templateId: string;
  version: number;
  requiredCapabilities?: string[];
  requiredConnections?: { providerId: string }[];
  pipeline?: { id: string; kicker?: string }[];
  items?: { pipeline?: { id: string }[] };
}

export const readMenu = (base = root): Menu =>
  JSON.parse(readFileSync(join(base, MENU_PATH), 'utf8')) as Menu;

const read = (path: string) => readFileSync(path, 'utf8');

/** Every file under `directory` (none when it is absent), skipping what is built or installed. */
export function filesUnder(directory: string, out: string[] = []): string[] {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) filesUnder(path, out);
    else out.push(path);
  }
  return out.sort();
}

/** A flow's manifests, oldest first. */
export function manifestsOf(base: string, id: string): ManifestShape[] {
  const directory = join(base, 'manifests');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(`${id}.v`) && name.endsWith('.json'))
    .map((name) => JSON.parse(read(join(directory, name))) as ManifestShape)
    .filter((manifest) => manifest.templateId === id)
    .sort((a, b) => a.version - b.version);
}

/** The quoted literals an `operation:` names, a type union included; never a `T['operation']` index. */
export function operationLiterals(text: string): { line: number; operation: string }[] {
  const found: { line: number; operation: string }[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    // The literals right after the colon, one or a union of several: never a `T['operation']`.
    const union = /\boperation\??\s*:\s*((?:(['"])[^'"]+\2\s*\|?\s*)+)/u.exec(line)?.[1];
    for (const literal of union?.matchAll(/(['"])([^'"]+)\1/gu) ?? []) {
      found.push({ line: index + 1, operation: literal[2]! });
    }
  }
  return found;
}

/** The menu's operations for these providers. */
const operationsOf = (menu: Menu, providers: Iterable<string>) =>
  new Set(
    [...providers].flatMap(
      (id) => menu.providers.find((p) => p.id === id)?.operations.map((o) => o.name) ?? [],
    ),
  );

/**
 * B2.4: every manifest's providers are the menu's, and every operation literal under a flow's
 * `src` (or the kit's) is an operation of a provider that flow's manifests (or that kit file's
 * `providerId: '…'` literals) declare. `only` limits it to one flow.
 */
export function menuProblems(base = root, menu = readMenu(base), only?: string): string[] {
  const problems: string[] = [];
  const known = new Set(menu.providers.map((provider) => provider.id));
  const flows = flowIds(base).filter((id) => only === undefined || id === only);
  for (const id of flows) {
    const declared = new Set<string>();
    for (const manifest of manifestsOf(base, id)) {
      for (const { providerId } of manifest.requiredConnections ?? []) {
        declared.add(providerId);
        if (!known.has(providerId)) {
          problems.push(
            `manifests/${id}.v${manifest.version}.json: ${providerId} is not in the menu`,
          );
        }
      }
    }
    problems.push(...literalProblems(base, join(base, 'automations', id, 'src'), menu, declared));
  }
  if (only === undefined) {
    for (const file of filesUnder(join(base, 'packages', 'automation-kit', 'src'))) {
      const providers = [...read(file).matchAll(/providerId:\s*'([^']+)'/gu)].map((m) => m[1]!);
      problems.push(...literalProblems(base, file, menu, new Set(providers)));
    }
  }
  return problems;
}

function literalProblems(base: string, under: string, menu: Menu, providers: Set<string>) {
  const offered = operationsOf(menu, providers);
  const files = existsSync(under) && !under.endsWith('.ts') ? filesUnder(under) : [under];
  return files
    .filter((file) => file.endsWith('.ts') && existsSync(file))
    .flatMap((file) =>
      operationLiterals(read(file))
        .filter(({ operation }) => !offered.has(operation))
        .map(
          ({ line, operation }) =>
            `${relative(base, file)}:${line}: ${operation} is not an operation of ${[...providers].join(', ') || 'a declared provider'} in the menu`,
        ),
    );
}

export const flowIds = (base = root): string[] =>
  existsSync(join(base, 'automations'))
    ? readdirSync(join(base, 'automations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

export type Verdict = 'PASS' | 'FAIL' | 'EXEMPT';
export interface Row {
  row: string;
  verdict: Verdict;
  note: string;
}

const pass = (row: string, note: string): Row => ({ row, verdict: 'PASS', note });
const fail = (row: string, note: string): Row => ({ row, verdict: 'FAIL', note });
const row = (name: string, problems: string[], ok: string): Row =>
  problems.length === 0 ? pass(name, ok) : fail(name, problems.join('; '));

/** The text of every file under a flow's folder part, joined. */
const textOf = (base: string, id: string, part: string) =>
  filesUnder(join(base, 'automations', id, part))
    .filter((file) => file.endsWith('.ts'))
    .map(read)
    .join('\n');

/** The flow's own words: its spec (README.md) and its words.md. */
export function flowWords(base: string, id: string): string {
  return ['README.md', 'words.md']
    .map((name) => join(base, 'automations', id, name))
    .filter((path) => existsSync(path))
    .map(read)
    .join('\n');
}

/** A table's rows under the spec's `## <n>.` heading, header and rule left out. */
export function specRows(spec: string, section: number): string[] {
  const start = spec.search(new RegExp(`^## ${section}\\. `, 'mu'));
  if (start < 0) return [];
  const rest = spec.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => /^## /u.test(line));
  const lines = (end < 0 ? rest : rest.slice(0, end)).filter((line) => /^\|/u.test(line));
  return lines.slice(2).filter((line) => line.replace(/[|\s-]/gu, '') !== '');
}

/** Every row for one flow; `changed` is the range's files, `isNew` whether its folder is new. */
export function rowsFor(base: string, id: string, changed: readonly string[], isNew: boolean) {
  const manifests = manifestsOf(base, id);
  const latest = manifests.at(-1);
  const live = LIVE_FLOWS.has(id);
  const exempt = (name: string): Row => ({
    row: name,
    verdict: 'EXEMPT',
    note: 'a live flow, until its after-pilot version',
  });
  const src = textOf(base, id, 'src');
  const tests = textOf(base, id, 'test');
  const rows: Row[] = [row('§3 menu', menuProblems(base, readMenu(base), id), 'within the menu')];
  if (!latest) return [...rows, fail('manifest', `no manifests/${id}.v<n>.json`)];
  const promptsDir = join(base, 'automations', id, 'prompts');
  const used = new Set(
    filesUnder(promptsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => (JSON.parse(read(file)) as { capability: string }).capability),
  );
  const declared = new Set(latest.requiredCapabilities ?? []);
  rows.push(
    row(
      '§4 capabilities',
      [...used]
        .filter((c) => !declared.has(c))
        .map((c) => `${c} is used, not declared`)
        .concat([...declared].filter((c) => !used.has(c)).map((c) => `${c} is declared, not used`)),
      'requiredCapabilities are the prompts’',
    ),
  );
  const pipeline = latest.pipeline ?? [];
  const ids = [...pipeline, ...(latest.items?.pipeline ?? [])].map((step) => step.id);
  const named = (text: string, step: string) =>
    new RegExp(`(?<![a-z0-9-])${step}(?![a-z0-9-])`, 'u').test(text);
  rows.push(
    row(
      '§6 steps',
      [
        ...(pipeline[0]?.kicker === 'TRIGGER' ? [] : ['the first step is not a TRIGGER']),
        ...pipeline
          .slice(1)
          .filter((s) => s.kicker === 'TRIGGER')
          .map((s) => `${s.id} is a second TRIGGER`),
        ...ids.filter((step) => !named(src, step)).map((step) => `${step} has no step in src`),
        ...ids.filter((step) => !named(tests, step)).map((step) => `${step} has no test`),
      ],
      'each step built and tested; one TRIGGER, first',
    ),
  );
  if (live) {
    rows.push(exempt('§7 blocks'), exempt('§8 failure words'), exempt('§9 tests'), exempt('Drill'));
  } else {
    const blocks = [
      ...(/\b(?:sections|details)\s*:/u.test(src)
        ? ['the result carries sections or details']
        : []),
      ...(/\bblocks\b/u.test(src) && !/\bboundedBlocks\(/u.test(src)
        ? ['blocks are not built through boundedBlocks']
        : []),
    ];
    rows.push(row('§7 blocks', blocks, 'blocks through boundedBlocks only'));
    const words = flowWords(base, id);
    const sentences = [...src.matchAll(/\bfailed\(\s*(['"])((?:(?!\1).)+)\1/gu)].map((m) => m[2]!);
    rows.push(
      row(
        '§8 failure words',
        sentences
          .filter((s) => !words.includes(s))
          .map((s) => `"${s}" is not in the spec or words.md`),
        'every failure sentence is in the spec or words.md',
      ),
    );
    const cases = specRows(words, 9).length;
    const written = [...tests.matchAll(/\btest\(\s*['"`]§9/gu)].length;
    rows.push(
      cases > 0 && written >= cases
        ? pass('§9 tests', `${written} tests for ${cases} rows`)
        : fail('§9 tests', `${written} tests for ${cases} rows of section 9`),
    );
    const drill = join(base, 'automations', id, 'test', 'drill.test.ts');
    rows.push(
      existsSync(drill) && /\bfailureDrill\(/u.test(read(drill))
        ? pass('Drill', 'test/drill.test.ts runs the failure drill')
        : fail('Drill', 'no test/drill.test.ts running failureDrill'),
    );
  }
  const outside = changed.filter(
    (path) =>
      !path.startsWith(`automations/${id}/`) &&
      !new RegExp(`^manifests/${id}\\.v[0-9]+\\.json$`, 'u').test(path) &&
      !GENERATED.includes(path) &&
      !path.startsWith('contract/'),
  );
  rows.push(
    !isNew
      ? pass('Paths', 'not a new flow: the reviewer reads the whole diff')
      : row(
          'Paths',
          outside.length ? [`also touches ${outside.join(', ')}`] : [],
          'its folder, its manifest and generated files',
        ),
  );
  return rows;
}

/** The flows a range touches: by folder or by manifest. */
export function touched(changed: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const path of changed) {
    const id =
      /^automations\/([^/]+)\//u.exec(path)?.[1] ??
      /^manifests\/(.+)\.v[0-9]+\.json$/u.exec(path)?.[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort();
}

export function table(id: string, rows: readonly Row[]): string {
  return [
    `### Review rows: ${id}`,
    '',
    '| Row | Verdict | Note |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.row} | ${r.verdict} | ${r.note.replaceAll('|', '\\|')} |`),
    '',
  ].join('\n');
}

function main(argv: readonly string[]): number {
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv[at + 1];
  };
  const base = flag('--base');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const changed = base
    ? git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean)
    : [];
  const ids = (base ? touched(changed) : flowIds()).filter((id) =>
    existsSync(join(root, 'automations', id)),
  );
  const existed = (id: string) =>
    base === undefined ||
    git('ls-tree', '--name-only', `${base}`, `automations/${id}`).trim() !== '';
  const out = ids.length
    ? ids.map((id) => table(id, rowsFor(root, id, changed, !existed(id)))).join('\n')
    : '### Review rows\n\nNo flow changed.\n';
  process.stdout.write(out);
  const summary = flag('--summary');
  if (summary) appendFileSync(summary, `${out}\n`);
  return /\| FAIL \|/u.test(out) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
