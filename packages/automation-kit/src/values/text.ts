/**
 * Text as the design cleans it (ip-review design-checks-rules-and-approval.json, cross_cutting[0]
 * item 1; Group 3's D1, D3 and D4): one cleaning, done once, so every later comparison, lookup
 * and line uses the same value.
 */

/**
 * A name or a number as the design cleans one: Unicode NFC; typographic quotes and dashes made
 * plain; invisible format characters (zero-width spaces and joiners, the soft hyphen,
 * bidirectional controls, the byte-order mark) removed; each run of control characters and white
 * space made one space; trimmed. `null` when nothing is left, or for a value that is not text.
 * Case, punctuation, `#`, leading zeros and inner spaces stay as printed.
 */
export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFC')
    .replace(/[‘’‚‛′]/gu, "'")
    .replace(/[“”„‟″]/gu, '"')
    .replace(/[‐-―−]/gu, '-')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\s\p{Z}]+/gu, ' ')
    .trim();
  return cleaned === '' ? null : cleaned;
}

/** The most characters a name may have: QuickBooks' display-name limit ("Maximum of 500 chars"). */
export const MAXIMUM_NAME_LENGTH = 500;

/** The most characters a document number may have before it is not read cleanly (Group 3's D3). */
export const MAXIMUM_NUMBER_LENGTH = 100;

/** The most characters QuickBooks takes as a transaction's own number (`DocNumber`, "maximum of 21 chars"). */
export const QUICKBOOKS_NUMBER_LENGTH = 21;

/** Two names are one when, cleaned, they differ only in case; nothing is no name. */
export function sameName(left: unknown, right: unknown): boolean {
  const a = cleanText(left);
  const b = cleanText(right);
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * `text` in at most `maximum` characters: as it is when it fits, else cut and ended with '…' —
 * never inside a character, so an astral one is never split into a lone surrogate. Nothing for a
 * maximum below 1.
 */
export function shorten(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  if (maximum < 1) return '';
  let kept = '';
  for (const point of text) {
    if (kept.length + point.length > maximum - 1) break;
    kept += point;
  }
  return `${kept.trimEnd()}…`;
}
