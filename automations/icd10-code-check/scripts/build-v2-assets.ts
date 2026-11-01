import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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

const [command, ...args] = process.argv.slice(2);
if (command === 'download' && args.length === 1) await download(resolve(args[0]!));
else if (command === 'build' && args.length === 3)
  build(resolve(args[0]!), resolve(args[1]!), resolve(args[2]!));
else {
  console.error(
    'usage: build-v2-assets.ts download <downloads> | build <downloads> <codes-table.json> <out>',
  );
  process.exit(2);
}
