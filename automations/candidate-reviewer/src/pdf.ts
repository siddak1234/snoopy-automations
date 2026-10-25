import { inflateSync } from 'node:zlib';

/**
 * The web addresses a PDF links to (the spec's §4), read here with Node's `zlib` alone — no
 * dependency. A resume often prints a word ("LinkedIn") whose address is only in the file's link;
 * the model, sent the file, reads what is printed, so the addresses come from the bytes: every
 * URI action's `/URI` string — a literal `( … )` with its escapes, or a hex `< … >` — in the file
 * as written and in each `/FlateDecode` stream, object streams among them, where a compressed
 * annotation sits. Each inflation stops at `PDF_LIMITS.streamBytes`, and a stream that would pass
 * it is not read; all of them together at `PDF_LIMITS.inflatedBytes`, after which nothing more is
 * inflated; at most `PDF_LIMITS.streams` are. An encrypted PDF, or bytes that are not a PDF, give
 * none — never a failure: the model reads the file either way. What an address may be is
 * `fileLinks`' (`reading.ts`): http and https only.
 */

export const PDF_LIMITS = {
  /** The most one stream may inflate to: 5 MB. */
  streamBytes: 5_000_000,
  /** The most every stream inflated may come to, together: 20 MB. */
  inflatedBytes: 20_000_000,
  /** The most streams inflated. */
  streams: 500,
  /** The most addresses read from one file. */
  addresses: 200,
  /** The longest address read: the platform keeps a link of up to 2,048 characters. */
  addressLength: 2_048,
} as const;

/** How far a string is read for its end: an address escaped in full, four characters a byte. */
const WINDOW = PDF_LIMITS.addressLength * 4;

/** The key of a URI action's address, then the string's first character. */
const URI_KEY = /\/URI\s*([(<])/gu;

/** A stream's keyword (never `endstream`'s) and the line end its data starts after. */
const STREAM = /\bstream(?:\r\n|\n|\r)/gu;

/** The trailer's key of an encrypted file: its strings are ciphertext. */
const ENCRYPTED = /\/Encrypt\b/u;

/** The addresses `bytes` links to, in the order found: as written, then stream by stream. */
export function pdfLinks(bytes: Uint8Array): string[] {
  try {
    // One character a byte: an index in the text is an offset in the bytes.
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    if (!text.slice(0, 1024).includes('%PDF-') || ENCRYPTED.test(text)) return [];
    const found: string[] = [];
    addressesIn(text, found);
    let budget = PDF_LIMITS.inflatedBytes;
    let streams = 0;
    for (const data of flateStreams(text, bytes)) {
      if (found.length >= PDF_LIMITS.addresses || streams >= PDF_LIMITS.streams || budget <= 0) {
        break;
      }
      streams += 1;
      const cap = Math.min(PDF_LIMITS.streamBytes, budget);
      let inflated: Buffer;
      try {
        inflated = inflateSync(data, { maxOutputLength: cap });
      } catch {
        // Past its cap, or not a stream that inflates: not read, and charged its whole cap.
        budget -= cap;
        continue;
      }
      budget -= inflated.byteLength;
      addressesIn(inflated.toString('latin1'), found);
    }
    return found;
  } catch {
    return [];
  }
}

/** The data of each stream whose dictionary names `/FlateDecode`, in the file's order. */
function* flateStreams(text: string, bytes: Uint8Array): Generator<Uint8Array> {
  let from = 0;
  for (const match of text.matchAll(STREAM)) {
    // A keyword inside an earlier stream's data is that data's, not a stream.
    if (match.index < from) continue;
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) return;
    // The dictionary is read back to its `obj`, searched within `WINDOW` alone: a search to the
    // file's start for each keyword would take time that grows with the square of its size.
    const floor = Math.max(from, match.index - WINDOW);
    const before = text.slice(floor, match.index);
    const head = floor + Math.max(0, before.lastIndexOf('obj'));
    from = end;
    if (/\/FlateDecode\b/u.test(text.slice(head, match.index))) yield bytes.subarray(start, end);
  }
}

/** Every URI action's address in `text`, added to `found` up to the bound; each read once. */
function addressesIn(text: string, found: string[]): void {
  const key = new RegExp(URI_KEY.source, URI_KEY.flags);
  for (let match = key.exec(text); match !== null; match = key.exec(text)) {
    if (found.length >= PDF_LIMITS.addresses) return;
    const at = match.index + match[0].length - 1;
    const read = match[1] === '(' ? literal(text, at) : hex(text, at);
    // Read on from the string's end, or from where its search stopped: each character once.
    key.lastIndex = Math.max(key.lastIndex, read.next);
    if (read.value !== undefined && read.value !== '') found.push(read.value);
  }
}

interface Read {
  value: string | undefined;
  next: number;
}

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '(': '(',
  ')': ')',
  '\\': '\\',
};

/**
 * A literal string from its `(` at `at`: balanced parentheses kept, `\n` `\r` `\t` `\b` `\f`
 * `\(` `\)` `\\` and up to three octal digits decoded, a backslash before a line end a
 * continuation, any other backslash dropped. No value when it does not end within `WINDOW`, or
 * is longer than an address may be.
 */
function literal(text: string, at: number): Read {
  const stop = Math.min(text.length, at + WINDOW);
  let depth = 0;
  let value = '';
  for (let index = at; index < stop; index += 1) {
    const character = text[index]!;
    if (character === '\\') {
      index += 1;
      const next = text[index] ?? '';
      if (next in ESCAPES) value += ESCAPES[next];
      else if (/[0-7]/u.test(next)) {
        let digits = next;
        while (digits.length < 3 && /[0-7]/u.test(text[index + 1] ?? '')) {
          index += 1;
          digits += text[index];
        }
        value += String.fromCharCode(parseInt(digits, 8) & 0xff);
      } else if (next === '\r' && text[index + 1] === '\n') index += 1;
      else if (next !== '\r' && next !== '\n') value += next;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    if (depth === 0) {
      return { value: value.length <= PDF_LIMITS.addressLength ? value : undefined, next: index };
    }
    if (index > at) value += character;
  }
  return { value: undefined, next: stop };
}

/** A hex string from its `<` at `at`: white space ignored, an odd last digit followed by 0. */
function hex(text: string, at: number): Read {
  // `<<` opens a dictionary — the catalog's `/URI << /Base … >>` — not a string.
  if (text[at + 1] === '<') return { value: undefined, next: at + 2 };
  const end = text.slice(at, at + WINDOW).indexOf('>');
  if (end === -1) return { value: undefined, next: at + WINDOW };
  const digits = text.slice(at + 1, at + end).replace(/\s/gu, '');
  if (!/^[0-9a-f]*$/iu.test(digits)) return { value: undefined, next: at + end };
  const value = Buffer.from(digits.length % 2 === 0 ? digits : `${digits}0`, 'hex').toString(
    'latin1',
  );
  return { value: value.length <= PDF_LIMITS.addressLength ? value : undefined, next: at + end };
}
