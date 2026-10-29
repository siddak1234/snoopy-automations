import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { SPECIALTIES, inFamily } from '../src/families.js';
import {
  formatted,
  layoutFrom,
  readOrderFile,
  tabularNotes,
  unzip,
  withDot,
} from './order-file.js';

/**
 * Builds `assets/` from the official CMS and CDC files (the spec, section 4, "The assets"), so a
 * person can rebuild and compare. Two commands, each run from the flow's folder:
 *
 *   npx tsx scripts/build-assets.ts download <downloads>
 *   npx tsx scripts/build-assets.ts build <downloads> <assets>
 *
 * `download` fetches each file below into its own new, empty folder under `<downloads>` (a
 * download is untrusted data: nothing is run from it, and the folder is refused if it exists);
 * `build` reads them back by path. For each table it reads the order file's layout from
 * `icd10OrderFiles.pdf` inside the same download (through poppler's `pdftotext`, which must be
 * installed: Node has no PDF reader) and refuses an order file that does not match it; keeps only
 * flag-1 codes, keyed by the code with its dot, with its long title (`order-file.ts`); reads the
 * tabular list's "code first" and "use additional code" notes for the specialties' families
 * (section 7's T1); and logs what the FY2027 order addenda change for the codes section 7 checks.
 * The April 1, 2026 update was found on CMS's ICD-10 page on 2026-10-28 ("April 1, 2026 Code
 * Descriptions in Tabular Order"), so its table is built and no visit is held for it.
 */

interface Source {
  /** The folder it is downloaded into, and the table it builds. */
  readonly id: 'codes-2026-oct' | 'codes-2026-apr' | 'codes-2027-oct';
  /** The year in the files' own names (`icd10cm_order_<year>.txt`). */
  readonly year: string;
  readonly codes: string;
  readonly tabular: string;
}

const CDC = 'https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM';
const CMS = 'https://www.cms.gov/files/zip';

export const SOURCES: readonly Source[] = [
  {
    id: 'codes-2026-oct',
    year: '2026',
    codes: `${CDC}/2026/icd10cm-Code%20Descriptions-2026.zip`,
    tabular: `${CDC}/2026/icd10cm-table%20and%20index-2026.zip`,
  },
  {
    id: 'codes-2026-apr',
    year: '2026',
    codes: `${CMS}/april-1-2026-code-descriptions-tabular-order.zip`,
    tabular: `${CMS}/april-1-2026-code-tables-tabular-index.zip`,
  },
  {
    id: 'codes-2027-oct',
    year: '2027',
    codes: `${CDC}/2027/icd10cm-code-descriptions-2027.zip`,
    tabular: `${CDC}/2027/icd10cm-table-and-index-2027.zip`,
  },
];

/** The codes section 7's checks name, whose FY2027 changes the log reports (`p4-rules-5`). */
const CHECKED = /^(N18|I1[0-6]|E(08|09|10|11|13)\.22|Z99\.2|Z94\.0|Z49|D63\.1)/u;

const folderOf = (root: string, id: string, part: 'codes' | 'tabular') =>
  join(root, `${id}-${part}`);

async function download(root: string): Promise<void> {
  for (const source of SOURCES) {
    for (const part of ['codes', 'tabular'] as const) {
      const folder = folderOf(root, source.id, part);
      if (existsSync(folder))
        throw new Error(`${folder} exists: each download needs a new, empty folder`);
      mkdirSync(folder, { recursive: true });
      const response = await fetch(source[part], { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`${source[part]} answered ${response.status}`);
      const file = join(folder, decodeURIComponent(basename(new URL(source[part]).pathname)));
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      console.log(`downloaded ${file}`);
    }
  }
}

/**
 * The one ZIP in a download's folder, and its one file named as `file` says, in any folder of it
 * (CDC's names use hyphens where CMS's use underscores, and once both: `icd10cm-tabular_-2027.xml`).
 */
function fileIn(folder: string, file: RegExp): Buffer {
  const zips = readdirSync(folder).filter((name) => name.endsWith('.zip'));
  if (zips.length !== 1) throw new Error(`${folder} must hold exactly one .zip`);
  const files = unzip(readFileSync(join(folder, zips[0]!)));
  const found = [...files.entries()].filter(([name]) => file.test(basename(name)));
  if (found.length !== 1) throw new Error(`${zips[0]} holds no single ${String(file)}`);
  return found[0]![1];
}

/** A PDF's text, by poppler's `pdftotext`: written beside its download, then read. */
function pdfText(folder: string, pdf: Buffer): string {
  const path = join(folder, 'icd10OrderFiles.pdf');
  writeFileSync(path, pdf);
  return execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8', timeout: 60_000 });
}

function build(root: string, out: string): void {
  mkdirSync(out, { recursive: true });
  const tables: Record<string, Record<string, string>> = {};
  for (const source of SOURCES) {
    const folder = folderOf(root, source.id, 'codes');
    const layout = layoutFrom(pdfText(folder, fileIn(folder, /^icd10OrderFiles\.pdf$/u)));
    const name = `icd10cm order ${source.year}`;
    const order = fileIn(folder, new RegExp(`^icd10cm[-_]+order[-_]+${source.year}\\.txt$`, 'u'));
    const codes = readOrderFile(order.toString('latin1'), layout, name);
    tables[source.id] = codes;
    writeFileSync(join(out, `${source.id}.json`), `${JSON.stringify(codes, null, 2)}\n`);
    const xml = fileIn(
      folderOf(root, source.id, 'tabular'),
      new RegExp(`^icd10cm[-_]+tabular[-_]+${source.year}\\.xml$`, 'u'),
    );
    const notes = tabularNotes(xml.toString('utf8'), (code) =>
      SPECIALTIES.some((s) => inFamily(code, s.families)),
    );
    const table = source.id.replace('codes-', '');
    writeFileSync(join(out, `code-notes-${table}.json`), `${JSON.stringify(notes, null, 2)}\n`);
    console.log(
      `${source.id}: ${Object.keys(codes).length} flag-1 codes; notes on ${Object.keys(notes).length} codes`,
    );
  }
  logChanges(root, tables['codes-2026-apr']!, tables['codes-2027-oct']!);
  writeFileSync(join(out, 'specialties.json'), formatted({ specialties: SPECIALTIES }));
}

/** What FY2027 changes for the checked codes: its order addenda's lines, and the two tables' difference. */
function logChanges(
  root: string,
  before: Record<string, string>,
  after: Record<string, string>,
): void {
  const addenda = fileIn(
    folderOf(root, 'codes-2027-oct', 'codes'),
    /^icd10cm[-_]+order[-_]+addenda[-_]+2027\.txt$/u,
  )
    .toString('latin1')
    .split(/\r?\n/u)
    .map((row) => /^(Add|Delete|Revise from|Revise to):\s+\d+\s+([A-Z0-9]+)\s+(.*)$/u.exec(row))
    .filter((match) => match !== null && CHECKED.test(withDot(match[2]!)));
  console.log(`FY2027 order addenda, the checked codes: ${addenda.length} lines`);
  for (const match of addenda) console.log(`  ${match![1]} ${withDot(match![2]!)}`);
  const codes = new Set(
    [...Object.keys(before), ...Object.keys(after)].filter((code) => CHECKED.test(code)),
  );
  for (const code of [...codes].sort()) {
    if (before[code] !== after[code])
      console.log(`  ${code}: ${before[code] ?? '(none)'} → ${after[code] ?? '(none)'}`);
  }
}

const [command, first, second] = process.argv.slice(2);
if (command === 'download' && first) await download(resolve(first));
else if (command === 'build' && first && second) build(resolve(first), resolve(second));
else {
  console.error('usage: build-assets.ts download <downloads> | build <downloads> <assets>');
  process.exitCode = 2;
}
