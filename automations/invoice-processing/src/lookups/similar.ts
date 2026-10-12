import { unmarkedName } from '@autom8x/automation-kit/quickbooks';
import { cleanText, fitLine, shorten, type LinePiece } from '@autom8x/automation-kit/values';
import type { JsonObject } from '@autom8x/automation-sdk';

import { sellerKey } from '../names.js';

/**
 * The similar-vendor list a new vendor's approver reads (decision 6; ip-review
 * design-quickbooks-lookups.json cross_cutting[5]): one distinctive word of the printed name,
 * searched with LIKE, and the names QuickBooks has with it — never a name from the document. It
 * only informs: it never holds or fails a run.
 */

/** Legal forms: they tell no business apart. */
const LEGAL_FORMS = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'lp',
  'ltd',
  'limited',
  'co',
  'corp',
  'corporation',
  'company',
  'plc',
  'pllc',
  'pc',
  'gmbh',
  'ag',
  'sa',
  'sarl',
  'srl',
  'bv',
  'nv',
  'pty',
]);

/** Filler words: too common to find the same supplier by. */
const FILLER = new Set([
  'the',
  'and',
  'of',
  'for',
  'de',
  'la',
  'le',
  'el',
  'group',
  'holdings',
  'holding',
  'international',
  'intl',
  'services',
  'service',
  'solutions',
  'enterprises',
  'industries',
  'systems',
  'global',
  'usa',
  'us',
  'com',
  'net',
  'org',
]);

/**
 * The word to search for: the name lower-cased and split into runs of letters and digits — any
 * other character parts words, so "O'Brien" is "o" and "brien" — legal forms and filler words
 * dropped; then the first word of 3 characters or more that is not all digits, else the first of
 * 2 or more, else none. "Acme Supplies, Inc." is "acme"; "3M Company" is "3m"; "A & B Co" none.
 */
export function distinctiveWord(name: string): string | null {
  const words = (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => !LEGAL_FORMS.has(word) && !FILLER.has(word),
  );
  return (
    words.find((word) => word.length >= 3 && !/^\p{N}+$/u.test(word)) ??
    words.find((word) => word.length >= 2) ??
    null
  );
}

/** A name QuickBooks has, as the list shows it. */
export interface SimilarName {
  readonly name: string;
  readonly inactive: boolean;
  /** The same name but for punctuation, case, "&" and a legal form: shown first. */
  readonly likelySame: boolean;
}

/**
 * The rows that hold the word, likely-the-same first, then in QuickBooks' order. An inactive
 * vendor's name is read without the "(deleted)" QuickBooks adds to it (sandbox G4–5), so it is
 * compared as the name it had and marked inactive once.
 */
export function similarNamesOf(
  rows: readonly JsonObject[],
  word: string,
  printed: string,
): SimilarName[] {
  const key = sellerKey(printed);
  const names: SimilarName[] = [];
  for (const row of rows) {
    const name = cleanText(unmarkedName(row, 'DisplayName'));
    // A re-check, as every lookup's: a row without the word is not one QuickBooks was asked for.
    if (name === null || !name.toLowerCase().includes(word)) continue;
    names.push({
      name,
      inactive: row.Active === false,
      likelySame: key !== '' && sellerKey(name) === key,
    });
  }
  return [...names.filter((each) => each.likelySame), ...names.filter((each) => !each.likelySame)];
}

/**
 * The step's line, at most 200 characters: "Vendors with 'acme' in the name: 'ACME Supplies Inc'
 * (likely the same); 'Acme Tools'; 'Acme Corp' (inactive); maybe more" — each name cut to 50
 * characters, then shortened further if the line needs it.
 */
export function similarLine(word: string, names: readonly SimilarName[], more: boolean): string {
  const shown = shorten(word, 30);
  if (names.length === 0) return `No vendor in QuickBooks has '${shown}' in its name`;
  const pieces: LinePiece[] = [`Vendors with '${shown}' in the name: `];
  names.forEach((each, index) => {
    if (index > 0) pieces.push('; ');
    const marks = `${each.likelySame ? ' (likely the same)' : ''}${each.inactive ? ' (inactive)' : ''}`;
    pieces.push("'", { name: shorten(each.name, 50) }, `'${marks}`);
  });
  if (more) pieces.push('; maybe more');
  return fitLine(pieces);
}
