import { inflateRawSync } from 'node:zlib';

/**
 * A Word file's text (.docx), read here with Node's `zlib` alone — no dependency (the spec's §4:
 * a Word file is not sent to the model as a file; its text is sent as the prompt's input).
 *
 * A .docx is a ZIP archive whose body is `word/document.xml`. That entry is found through the
 * archive's central directory — never by scanning for local headers, which a crafted file can
 * plant — and inflated, bounded against a ZIP bomb: an entry that would inflate past
 * `DOCX_LIMITS.inflatedBytes`, or by more than `DOCX_LIMITS.ratio` times its stored size, is
 * refused before it is inflated, and the inflation itself stops at the size the entry claims.
 * An encrypted entry, or one not stored with deflate, is refused too. A refusal is a reason word
 * for a test, never shown: the person reads "could not be read".
 */

export const DOCX_LIMITS = {
  /** The most `word/document.xml` may inflate to: 5 MB. */
  inflatedBytes: 5_000_000,
  /** The most it may inflate by: 100 times its stored size. */
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
/** Bit 0 of an entry's flags: the entry is encrypted. */
const ENCRYPTED = 0x0001;
const DEFLATE = 8;

const refused = (refusal: DocxRefusal): DocxText => ({ ok: false, refusal });

/** `word/document.xml`'s text: paragraphs one a line, tabs and breaks kept. */
export function docxText(bytes: Uint8Array): DocxText {
  const entry = documentEntry(bytes);
  if (!('offset' in entry)) return entry;
  let xml: Buffer;
  try {
    // Stopped at the size the entry claims, itself within the bound: an entry that inflates
    // past its claim is refused before more of it is written.
    xml = inflateRawSync(entry.data, { maxOutputLength: Math.max(1, entry.inflated) });
  } catch {
    return refused('corrupt');
  }
  return { ok: true, text: textOf(xml.toString('utf8')) };
}

interface Entry {
  offset: number;
  data: Uint8Array;
  inflated: number;
}

/** The document's entry, read through the central directory and held to the bounds. */
function documentEntry(bytes: Uint8Array): Entry | DocxText {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOfDirectory(view);
  if (end === undefined) return refused('not-a-zip');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count > DOCX_LIMITS.entries) return refused('corrupt');
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== DIRECTORY_ENTRY) {
      return refused('corrupt');
    }
    const nameLength = view.getUint16(at + 28, true);
    const skip = 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (at + 46 + nameLength > view.byteLength) return refused('corrupt');
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (name === DOCUMENT) return bounded(view, bytes, at);
    at += skip;
  }
  return refused('no-document');
}

/** The entry at this central-directory record, or why it is refused. */
function bounded(view: DataView, bytes: Uint8Array, at: number): Entry | DocxText {
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
  return { offset, data: bytes.subarray(offset, offset + stored), inflated };
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
  for (const match of xml.matchAll(/<([^>]*)>|([^<]+)/gu)) {
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
