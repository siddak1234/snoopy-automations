import { inflateRawSync } from 'node:zlib';

/**
 * The pure half of `build-assets.ts`: reading the official downloads. Nothing here touches the
 * network or the disk, so the refusals are tested on made-up text (test/assets.test.ts).
 *
 * - `layoutFrom`: the order file's layout, read from the documentation's own table
 *   ("Position Length Contents"), never assumed (research.md, pass 4 Gaps: only the FY2021 layout
 *   was read);
 * - `readOrderFile`: every line held to that layout, refused at the first that does not match;
 *   only flag-1 codes kept (`p4-rules-8`), keyed by the code with its dot (`p4-rules-9`: the file
 *   has none), with the long title; headers and order numbers left out (`p4-rules-7`, `p4-rules-11`);
 * - `tabularNotes`: a tabular list's "code first" and "use additional code" notes;
 * - `unzip`: a ZIP's files, on Node's own inflate;
 * - `formatted`: JSON as the repository's formatter writes it.
 */

export interface Field {
  /** 1-based, as the documentation counts. */
  position: number;
  /** Characters; undefined for "To end". */
  length?: number;
}

export interface Layout {
  order: Field;
  code: Field;
  flag: Field;
  short: Field;
  long: Field;
  blanks: Field[];
  /** "never longer than N characters". */
  maxLine: number;
}

const FIELDS: readonly (readonly [keyof Omit<Layout, 'blanks' | 'maxLine'>, RegExp])[] = [
  ['order', /^Order number\b/u],
  ['code', /^ICD-10-CM or ICD-10-PCS code\b/u],
  ['flag', /^0 if the code is a\b/u],
  ['short', /^Short description\b/u],
  ['long', /^Long description\b/u],
];

/** The layout table of the order file's documentation, as text; refused when any part is missing. */
export function layoutFrom(documentation: string): Layout {
  const text = documentation.replace(/\r\n?/gu, '\n');
  const start = text.search(/Position\s+Length\s+Contents/u);
  if (start < 0) throw new Error('the documentation holds no "Position Length Contents" table');
  const found: Partial<Record<string, Field>> = {};
  const blanks: Field[] = [];
  for (const row of text.slice(start).split('\n').slice(1)) {
    const match = /^\s*(\d+)\s+(\d+|To end)\s+(\S.*)$/u.exec(row);
    if (!match) continue;
    const field: Field = {
      position: Number(match[1]),
      ...(match[2] === 'To end' ? {} : { length: Number(match[2]) }),
    };
    const contents = match[3]!.trim();
    if (/^Blank\b/u.test(contents)) {
      blanks.push(field);
      continue;
    }
    const named = FIELDS.find(([, pattern]) => pattern.test(contents));
    if (!named) continue;
    if (found[named[0]]) throw new Error(`the documentation names the ${named[0]} field twice`);
    found[named[0]] = field;
  }
  for (const [name] of FIELDS) {
    if (!found[name]) throw new Error(`the documentation's layout names no ${name} field`);
  }
  if (!/1 if the code is valid for submission/u.test(text)) {
    throw new Error('the documentation does not say which flag marks a valid code');
  }
  const maxLine = /never longer than\s+(\d+)/u.exec(text);
  if (!maxLine) throw new Error('the documentation names no longest line');
  return { ...(found as Omit<Layout, 'blanks' | 'maxLine'>), blanks, maxLine: Number(maxLine[1]) };
}

/** The dot after the category, as people write a code: `N1831` → `N18.31`, `I10` → `I10`. */
export const withDot = (code: string): string =>
  code.length > 3 ? `${code.slice(0, 3)}.${code.slice(3)}` : code;

const cut = (line: string, field: Field): string =>
  line.slice(
    field.position - 1,
    field.length === undefined ? undefined : field.position - 1 + field.length,
  );

/**
 * An order file's flag-1 codes, `{ "N18.31": "Chronic kidney disease, stage 3a" }`, in tabular
 * order. Every line is held to `layout` — its length, its blanks, a zero-filled rising order
 * number, a code of 3 to 7 letters and digits, a flag of 0 or 1 and both titles — and the first
 * that misses is refused by name and line number.
 */
export function readOrderFile(text: string, layout: Layout, name: string): Record<string, string> {
  const codes: Record<string, string> = {};
  let last = 0;
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new Error(`${name} holds no line`);
  lines.forEach((line, index) => {
    const refuse = (what: string) => {
      throw new Error(
        `${name} line ${index + 1} does not match its documentation's layout: ${what}`,
      );
    };
    if (line.length > layout.maxLine) refuse(`longer than ${layout.maxLine}`);
    const order = cut(line, layout.order);
    if (!new RegExp(`^\\d{${layout.order.length ?? 1}}$`, 'u').test(order)) refuse('order number');
    if (Number(order) <= last) refuse('order numbers out of order');
    last = Number(order);
    for (const blank of layout.blanks) if (cut(line, blank).trim() !== '') refuse('a blank');
    const code = cut(line, layout.code);
    if (!/^[A-Z][0-9A-Z]{2,6} *$/u.test(code) || code.length !== layout.code.length) refuse('code');
    const flag = cut(line, layout.flag);
    if (flag !== '0' && flag !== '1') refuse('flag');
    const short = cut(line, layout.short).trim();
    const long = cut(line, layout.long).trim();
    if (short === '' || long === '') refuse('description');
    if (flag === '1') codes[withDot(code.trim())] = long;
  });
  return codes;
}

/** One "code first" or "use additional code" note of a tabular list, in its own words. */
export interface TableNote {
  /** How the table heads it; the note's own words follow ("Use additional" + "code to identify…"). */
  kind: 'Code first' | 'Use additional';
  /** The note's words, its heading ("any associated:") before the item. */
  note: string;
}

const NOTE_KINDS = { codeFirst: 'Code first', useAdditionalCode: 'Use additional' } as const;

const unescape = (text: string): string =>
  text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim();

/**
 * Each `<diag>` of a tabular list whose name `keep` takes, with its own "code first" and "use
 * additional code" notes: one per `<note>` that names a code, a heading note (one that names none
 * and ends with a colon) put before the items it heads. A code's notes at run time are its own and
 * its parents' (`N18.6`, then `N18`), so each is kept once, where the table writes it.
 */
export function tabularNotes(
  xml: string,
  keep: (code: string) => boolean,
): Record<string, TableNote[]> {
  const notes: Record<string, TableNote[]> = {};
  const names: string[] = [];
  let kind: keyof typeof NOTE_KINDS | undefined;
  let heading = '';
  const tags = /<(\/?)(diag|name|codeFirst|useAdditionalCode|note)>([^<]*)/gu;
  for (const [, close, tag, text] of xml.matchAll(tags)) {
    if (tag === 'diag') {
      if (close) names.pop();
      else names.push('');
    } else if (tag === 'name' && !close && names.length > 0 && names.at(-1) === '') {
      names[names.length - 1] = unescape(text!);
    } else if (tag === 'codeFirst' || tag === 'useAdditionalCode') {
      kind = close ? undefined : tag;
      heading = '';
    } else if (tag === 'note' && !close && kind !== undefined) {
      const code = names.at(-1) ?? '';
      const words = unescape(text!);
      if (!/\b[A-Z]\d{2}/u.test(words)) {
        if (words.endsWith(':')) heading = words;
        continue;
      }
      if (code === '' || !keep(code)) continue;
      (notes[code] ??= []).push({
        kind: NOTE_KINDS[kind],
        note: heading === '' ? words : `${heading} ${words}`,
      });
    }
  }
  return notes;
}

/** A ZIP's files by their names, inflated with Node's own zlib (stored or deflated only). */
export function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a ZIP file: no central directory');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('not a ZIP file: a broken directory');
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(data, data + size);
    if (method === 0) files.set(name, Buffer.from(body));
    else if (method === 8) files.set(name, inflateRawSync(body));
    else throw new Error(`${name}: a ZIP method this script does not read (${method})`);
  }
  return files;
}

/** JSON as the repository's formatter writes it: a list of strings on one line when it fits in 100. */
export function formatted(value: unknown): string {
  const text = JSON.stringify(value, null, 2).replace(
    /^( *)("[^"\n]+": )\[\n((?:\1 {2}"[^"\n]*",?\n)+)\1\]/gmu,
    (whole, indent: string, key: string, items: string) => {
      const inline = `${indent}${key}[${items
        .trim()
        .split(/,\n\s*/u)
        .join(', ')}]`;
      return inline.length <= 100 ? inline : whole;
    },
  );
  return `${text}\n`;
}
