import { inflateRawSync } from 'node:zlib';

/**
 * A Word file's text (.docx), read here with Node's `zlib` alone — no dependency (the spec's §4:
 * a Word file is not sent to the model as a file; its text is sent as the prompt's input).
 *
 * A .docx is a ZIP archive whose body is `word/document.xml`; its page headers and footers
 * (`word/header<n>.xml`, `word/footer<n>.xml`) often hold a resume's name and contact lines, so
 * their text is read too, and comes first. Each entry is found through the archive's central
 * directory — never by scanning for local headers, which a crafted file can plant — and
 * inflated, bounded against a ZIP bomb: entries that together would inflate past
 * `DOCX_LIMITS.inflatedBytes`, or any that would by more than `DOCX_LIMITS.ratio` times its
 * stored size, are refused before anything is inflated, and each inflation stops at the size its
 * entry claims. An encrypted entry, or one not stored with deflate, is refused too. A refusal is
 * a reason word for a test, never shown: the person reads "could not be read". The addresses its
 * body links to are read through the same directory and bounds (`docxLinks`).
 */

export const DOCX_LIMITS = {
  /** The most the entries read may inflate to, together: 5 MB. */
  inflatedBytes: 5_000_000,
  /** The most any one may inflate by: 100 times its stored size. */
  ratio: 100,
  /** The most entries a central directory is read for. */
  entries: 10_000,
} as const;

export type DocxRefusal =
  'not-a-zip' | 'no-document' | 'encrypted' | 'not-deflate' | 'too-large' | 'ratio' | 'corrupt';

export type DocxText = { ok: true; text: string } | { ok: false; refusal: DocxRefusal };

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const DOCUMENT = 'word/document.xml';
/** The body's relationships: where Word keeps the address of each hyperlink. */
const RELATIONSHIPS = 'word/_rels/document.xml.rels';
/** A page header or footer, by the name Word gives it. */
const HEADER_OR_FOOTER = /^word\/(header|footer)\d*\.xml$/u;
/** Bit 0 of an entry's flags: the entry is encrypted. */
const ENCRYPTED = 0x0001;
const DEFLATE = 8;

const refused = (refusal: DocxRefusal): DocxText => ({ ok: false, refusal });

/**
 * The text of the headers, then the footers, then `word/document.xml`: paragraphs one a line,
 * tabs and breaks kept, a header or footer that repeats another's text read once.
 */
export function docxText(bytes: Uint8Array): DocxText {
  const entries = textEntries(bytes);
  if (!Array.isArray(entries)) return entries;
  const texts: string[] = [];
  for (const entry of entries) {
    const xml = inflated(entry);
    if (xml === undefined) return refused('corrupt');
    const text = textOf(xml);
    if (text !== '' && !texts.includes(text)) texts.push(text);
  }
  return { ok: true, text: texts.join('\n') };
}

/**
 * The addresses a Word file's body links to (the spec's §4), in the order written: each
 * relationship in `word/_rels/document.xml.rels` of the hyperlink type whose `TargetMode` is
 * `External`. None when the file holds none, or would be refused; never a failure.
 */
export function docxLinks(bytes: Uint8Array): string[] {
  const entries = archiveEntries(bytes, (name) => name === RELATIONSHIPS);
  const xml = Array.isArray(entries) && entries[0] !== undefined ? inflated(entries[0]) : undefined;
  if (xml === undefined) return [];
  const links: string[] = [];
  // A tag's attributes stop at the next `<` as well as at its `>` (`TAG`).
  for (const [, attributes = ''] of xml.matchAll(/<(?:[\w-]+:)?Relationship\b([^<>]*)>/gu)) {
    const type = attributeOf(attributes, 'Type');
    const target = attributeOf(attributes, 'Target');
    if (
      /\/relationships\/hyperlink$/u.test(type) &&
      attributeOf(attributes, 'TargetMode') === 'External'
    ) {
      if (target !== '') links.push(target);
    }
  }
  return links;
}

/** An attribute's value, its entities decoded; empty when it is not there. */
function attributeOf(attributes: string, key: string): string {
  const match = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u').exec(attributes);
  return decode(match?.[1] ?? match?.[2] ?? '');
}

/**
 * An entry's XML, or `undefined` when it will not inflate — stopped at the size the entry claims,
 * itself within the bound: an entry that inflates past its claim is refused before more of it is
 * written.
 */
function inflated(entry: Entry): string | undefined {
  try {
    return inflateRawSync(entry.data, { maxOutputLength: Math.max(1, entry.inflated) }).toString(
      'utf8',
    );
  } catch {
    return undefined;
  }
}

interface Entry {
  name: string;
  data: Uint8Array;
  inflated: number;
}

/**
 * The entries read, in reading order — headers, footers, the document — found through the
 * central directory and held to the bounds, one budget for all of them.
 */
function textEntries(bytes: Uint8Array): Entry[] | DocxText {
  const entries = archiveEntries(bytes, (name) => name === DOCUMENT || HEADER_OR_FOOTER.test(name));
  if (!Array.isArray(entries)) return entries;
  if (!entries.some((entry) => entry.name === DOCUMENT)) return refused('no-document');
  const total = entries.reduce((sum, entry) => sum + entry.inflated, 0);
  if (total > DOCX_LIMITS.inflatedBytes) return refused('too-large');
  const rank = (name: string) =>
    name.startsWith('word/header') ? 0 : name.startsWith('word/footer') ? 1 : 2;
  return entries.sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'en', { numeric: true }),
  );
}

/** The entries `wanted` names, found through the central directory, each held to the bounds. */
function archiveEntries(bytes: Uint8Array, wanted: (name: string) => boolean): Entry[] | DocxText {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOfDirectory(view);
  if (end === undefined) return refused('not-a-zip');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count > DOCX_LIMITS.entries) return refused('corrupt');
  const entries: Entry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== DIRECTORY_ENTRY) {
      return refused('corrupt');
    }
    const nameLength = view.getUint16(at + 28, true);
    const skip = 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (at + 46 + nameLength > view.byteLength) return refused('corrupt');
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (wanted(name)) {
      const entry = bounded(view, bytes, at, name);
      if (!('data' in entry)) return entry;
      entries.push(entry);
    }
    at += skip;
  }
  return entries;
}

/** The entry at this central-directory record, or why it is refused. */
function bounded(view: DataView, bytes: Uint8Array, at: number, name: string): Entry | DocxText {
  const flags = view.getUint16(at + 8, true);
  const method = view.getUint16(at + 10, true);
  const stored = view.getUint32(at + 20, true);
  const inflated = view.getUint32(at + 24, true);
  const local = view.getUint32(at + 42, true);
  if ((flags & ENCRYPTED) !== 0) return refused('encrypted');
  if (method !== DEFLATE) return refused('not-deflate');
  // A ZIP64 entry marks its sizes 0xFFFFFFFF: past the bound either way.
  if (inflated > DOCX_LIMITS.inflatedBytes) return refused('too-large');
  if (stored === 0 || inflated / stored > DOCX_LIMITS.ratio) return refused('ratio');
  if (local + 30 > view.byteLength || view.getUint32(local, true) !== LOCAL_ENTRY) {
    return refused('corrupt');
  }
  const offset = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (offset + stored > view.byteLength) return refused('corrupt');
  return { name, data: bytes.subarray(offset, offset + stored), inflated };
}

/** The end-of-central-directory record: in the last 22 bytes, or before a comment of up to 64 KiB. */
function endOfDirectory(view: DataView): number | undefined {
  const last = view.byteLength - 22;
  for (let at = last; at >= 0 && at >= last - 0xffff; at -= 1) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) return at;
  }
  return undefined;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** XML's five named entities and its numeric references; anything else left as written. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/gu, (whole, name: string) => {
    if (!name.startsWith('#')) return ENTITIES[name] ?? whole;
    const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : '';
  });
}

/**
 * A tag, or the text between two. A tag ends at its `>` and never runs past the next `<`, which
 * XML forbids inside one: a `<` with no `>` after it is no tag, and is not read to the end of the
 * entry once for every such `<` — time that would grow with the square of its size.
 */
const TAG = /<([^<>]*)>|([^<]+)/gu;

/**
 * The text of WordprocessingML: `w:t` runs, a `w:tab` a tab and a `w:br` or `w:cr` a line
 * break, each `w:p` its own line. A tab stop (`w:tab` inside `w:tabs`) is no tab, and a
 * `mc:Fallback` repeats what its `mc:Choice` holds, so neither is read.
 */
function textOf(xml: string): string {
  const lines: string[] = [];
  let line = '';
  let inText = false;
  let inTabs = 0;
  let inFallback = 0;
  for (const match of xml.matchAll(TAG)) {
    const tag = match[1];
    if (tag === undefined) {
      if (inText) line += decode(match[2] ?? '');
      continue;
    }
    if (tag.startsWith('?') || tag.startsWith('!')) continue;
    const closing = tag.startsWith('/');
    const empty = tag.endsWith('/');
    const name = /^\/?([^\s/]+)/u.exec(tag)?.[1];
    const depth = closing ? -1 : empty ? 0 : 1;
    if (name === 'mc:Fallback') inFallback += depth;
    else if (name === 'w:tabs') inTabs += depth;
    if (inFallback > 0) continue;
    if (name === 'w:t') inText = !closing && !empty;
    else if (name === 'w:tab' && !closing && inTabs === 0) line += '\t';
    else if ((name === 'w:br' || name === 'w:cr') && !closing) line += '\n';
    else if (name === 'w:p' && (closing || empty)) {
      lines.push(line.trimEnd());
      line = '';
    }
  }
  if (line !== '') lines.push(line.trimEnd());
  return lines
    .join('\n')
    .replace(/\u0000/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
