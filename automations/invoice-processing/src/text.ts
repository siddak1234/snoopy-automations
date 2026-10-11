/**
 * A name as the design cleans one (ip-review design-checks-rules-and-approval.json,
 * cross_cutting[0] item 1): Unicode NFC; typographic quotes and dashes made plain;
 * invisible format characters (zero-width spaces and joiners, the soft hyphen,
 * bidirectional controls, the byte-order mark) removed; each run of control characters
 * and white space made one space; trimmed. `null` when nothing is left, or for a value that
 * is not text. Case, punctuation and inner spaces stay as typed.
 */
export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/gu, '"')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\s\p{Z}]+/gu, ' ')
    .trim();
  return cleaned === '' ? null : cleaned;
}

/** The most characters a name may have: QuickBooks' display-name limit. */
export const MAXIMUM_NAME_LENGTH = 500;
