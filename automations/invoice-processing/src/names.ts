/**
 * Two readings of a seller's name: whether it carries a web or e-mail address (Group 3's D4), and
 * whether two reads printed "roughly" the same name (the second read's agreement rule, the plan's
 * §4). Each takes a name already cleaned (`cleanText`).
 */

/**
 * The suffixes a word ends in when it is a web address (ip-review
 * design-checks-rules-and-approval.json, steps[0].logic[10]), and `example`, the domain reserved
 * for documentation (RFC 6761) that this public repository's made-up documents print.
 */
const WEB_SUFFIXES = [
  'com',
  'net',
  'org',
  'io',
  'ai',
  'co',
  'us',
  'biz',
  'info',
  'app',
  'dev',
  'shop',
  'store',
  'online',
  'site',
  'example',
];

const WEB_ADDRESS = [
  /https?:\/\//iu,
  /\bwww\./iu,
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/iu,
  new RegExp(`[a-z0-9-]\\.(?:${WEB_SUFFIXES.join('|')})(?![a-z0-9])`, 'iu'),
];

/**
 * A web or e-mail address in a name: `http://` or `https://`, `www.`, an e-mail address, or a word
 * ending in a common web suffix. A note on the line when the run holds, not a hold of its own (D4).
 */
export function hasWebAddress(name: string): boolean {
  return WEB_ADDRESS.some((pattern) => pattern.test(name));
}

/** The words a business's name may end in, or begin with, that do not tell two businesses apart. */
const LEGAL_FORMS = new Set([
  'inc',
  'incorporated',
  'llc',
  'lc',
  'ltd',
  'limited',
  'co',
  'corp',
  'corporation',
  'company',
  'plc',
  'lp',
  'llp',
  'pc',
  'pllc',
]);

/**
 * A seller's name with what does not tell two businesses apart taken out: accents, case, dots,
 * punctuation and spaces, `&` read as "and", a leading "the" and trailing legal forms — so
 * "Bluefinch Print & Sign" and "BLUEFINCH PRINT AND SIGN, INC." are one key.
 */
export function sellerKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replaceAll('.', '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
  if (words.length > 1 && words[0] === 'the') words.shift();
  while (words.length > 1 && LEGAL_FORMS.has(words.at(-1)!)) words.pop();
  return words.join('');
}

/** The second read's vendor rule: the same name, roughly — equal keys, or equal text when neither has one. */
export function roughlySameSeller(first: string, second: string): boolean {
  const [a, b] = [sellerKey(first), sellerKey(second)];
  return a === '' && b === '' ? first.toLowerCase() === second.toLowerCase() : a === b;
}
