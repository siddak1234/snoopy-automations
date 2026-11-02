import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { levelOf } from '../src/v2/lookup.js';
import { TABLES } from '../src/tables.js';
import { unzip } from './order-file.js';

import {
  GUIDES,
  GUIDE_MAPPING,
  NEPHROLOGY,
  NUCC,
  commonCodesIn,
  guideUrl,
  keptCodes,
  nuccRows,
  preferencesFrom,
  specialtiesFrom,
  type Guide,
} from './v2-lists.js';

/**
 * Builds v2's `automations/icd10-code-check/assets/v2/specialties.json` and `automations/icd10-code-check/assets/v2/preferences.json` (`v2-lists.ts` says
 * what each holds and why), so a person can rebuild and compare. Two commands, from the flow's
 * folder:
 *
 *   npx tsx scripts/build-v2-assets.ts download <downloads>
 *   npx tsx scripts/build-v2-assets.ts build <downloads> <codes-table.json> <out>
 *
 * `download` fetches the NUCC file into `<downloads>/nucc/` and each CMS guide into
 * `<downloads>/cms-<Name>/`, each a new, empty folder (a download is untrusted data: nothing is run
 * from it, and a folder that exists is refused). `build` reads them back by path; a guide's text
 * through poppler's `pdftotext -layout` (Node has no PDF reader), the path passed as an argument.
 * `<codes-table.json>` is the current code table (`automations/icd10-code-check/assets/codes-2027-oct.json` for visits from
 * 2026-10-01): a listed code it does not hold as valid is kept as its three-character category,
 * and the log says which.
 *
 *   npx tsx scripts/build-v2-assets.ts index <downloads> <out>
 *
 * `index` reads each table's Alphabetic Index (`icd10cm-index-<year>.xml`, any of the files' own
 * spellings) from the "table and index" ZIP that `scripts/build-assets.ts download` fetched into
 * `<downloads>/codes-<table>-tabular/`, and writes `index-<table>.json` (`indexTerms`).
 */

const nuccFolder = (root: string) => join(root, 'nucc');
const guideFolder = (root: string, guide: Guide) => join(root, `cms-${guide}`);

async function fetchInto(folder: string, url: string): Promise<void> {
  if (existsSync(folder))
    throw new Error(`${folder} exists: each download needs a new, empty folder`);
  mkdirSync(folder, { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const file = join(folder, basename(new URL(url).pathname));
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  console.log(`downloaded ${file}`);
}

async function download(root: string): Promise<void> {
  await fetchInto(nuccFolder(root), NUCC.url);
  for (const guide of GUIDES) await fetchInto(guideFolder(root, guide), guideUrl(guide));
}

const pdfText = (path: string): string =>
  execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8', timeout: 60_000 });

function build(root: string, tablePath: string, out: string): void {
  const csv = readFileSync(join(nuccFolder(root), basename(new URL(NUCC.url).pathname)), 'utf8');
  const options = specialtiesFrom(csv);
  const table = JSON.parse(readFileSync(tablePath, 'utf8')) as Record<string, string>;
  const guides = {} as Record<Guide, string[]>;
  for (const guide of GUIDES) {
    const path = join(guideFolder(root, guide), basename(new URL(guideUrl(guide)).pathname));
    const listed = commonCodesIn(pdfText(path));
    const { kept, categories } = keptCodes(listed, table);
    guides[guide] = kept;
    console.log(
      `${guide}: ${listed.length} codes listed, ${kept.length} kept; as their category (not valid in ${basename(tablePath)}): ${categories.join(', ') || 'none'}; to ${GUIDE_MAPPING[guide].map((m) => m.code).join(', ')}`,
    );
  }
  const preferences = preferencesFrom(nuccRows(csv), guides);
  console.log(`Nephrology: ${NEPHROLOGY.families.join(', ')}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'specialties.json'),
    `${JSON.stringify({ source: { url: NUCC.url, version: NUCC.version, effective: NUCC.effective }, options }, null, 2)}\n`,
  );
  writeFileSync(
    join(out, 'preferences.json'),
    `${JSON.stringify({ table: basename(tablePath), guides: Object.fromEntries(GUIDES.map((g) => [g, guideUrl(g)])), preferences }, null, 2)}\n`,
  );
  console.log(
    `wrote ${options.length} specialties, ${Object.keys(preferences).length} with preferences`,
  );
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

/**
 * Every index path that names a code (`code`, `subcat` or `seecat`, its dash kept), each level as
 * `levelOf` stores it, levels joined by "|", the first code a path names kept; then each "see"
 * whose target ("Hypertension, kidney": a main term's first alternative, then its subterms) names
 * one, with the target's own subterms. `manif` and `seeAlso` are left out.
 */
export function indexTerms(xml: string): Record<string, string> {
  const terms: Record<string, string> = {};
  const sees: [string, string][] = [];
  const levels: string[] = [];
  let inTitle = false;
  const text = (raw: string) =>
    raw.replace(/&(\w+);/gu, (all, name: string) => ENTITIES[name] ?? all);
  const tags = /<(\/?)(mainTerm|term|title|nemod|code|subcat|seecat|see)(?:\s[^>]*)?>([^<]*)/gu;
  for (const [, close, tag, raw] of xml.matchAll(tags)) {
    const path = () => levels.map(levelOf).join('|');
    if (tag === 'mainTerm' || tag === 'term') {
      if (close) levels.pop();
      else levels.push('');
    } else if (tag === 'title') {
      inTitle = !close;
      if (inTitle) levels[levels.length - 1] = text(raw!);
    } else if (tag === 'nemod') {
      if (close && inTitle) levels[levels.length - 1] += text(raw!);
    } else if (!close && tag === 'see') sees.push([path(), text(raw!).trim()]);
    else if (!close) terms[path()] ??= raw!.trim();
  }
  // Each path under itself and its parent, the main term by its first alternative: a see's target.
  const under = new Map<string, [string, string][]>();
  for (const [path, code] of Object.entries(terms)) {
    const levels = path.split('|');
    const key = [levels[0]!.split(',')[0], ...levels.slice(1)];
    for (let depth = Math.max(1, key.length - 1); depth <= key.length; depth += 1) {
      const prefix = key.slice(0, depth).join('|');
      const rest = levels.slice(depth).join('|');
      under.set(prefix, [...(under.get(prefix) ?? []), [rest, code]]);
    }
  }
  for (const [path, target] of sees) {
    for (const [rest, code] of under.get(target.split(',').map(levelOf).join('|')) ?? []) {
      terms[rest === '' ? path : `${path}|${rest}`] ??= code;
    }
  }
  return terms;
}

function buildIndex(root: string, out: string): void {
  for (const table of TABLES) {
    const folder = join(root, `codes-${table}-tabular`);
    const zips = readdirSync(folder).filter((name) => name.endsWith('.zip'));
    if (zips.length !== 1) throw new Error(`${folder} must hold exactly one .zip`);
    const found = [...unzip(readFileSync(join(folder, zips[0]!)))].filter(([name]) =>
      /^icd10cm[-_]+index[-_]+\d{4}\.xml$/u.test(basename(name)),
    );
    if (found.length !== 1) throw new Error(`${zips[0]} holds no single index XML`);
    const [name, xml] = found[0]!;
    const terms = indexTerms(xml.toString('utf8'));
    writeFileSync(
      join(out, `index-${table}.json`),
      `${JSON.stringify({ file: basename(name), terms }, null, 2)}\n`,
    );
    console.log(`${table}: ${basename(name)}, ${Object.keys(terms).length} paths with a code`);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'download' && args.length === 1) await download(resolve(args[0]!));
else if (command === 'build' && args.length === 3)
  build(resolve(args[0]!), resolve(args[1]!), resolve(args[2]!));
else if (command === 'index' && args.length === 2) buildIndex(resolve(args[0]!), resolve(args[1]!));
else {
  console.error(
    'usage: build-v2-assets.ts download <downloads> | build <downloads> <codes-table.json> <out> | index <downloads> <out>',
  );
  process.exit(2);
}
