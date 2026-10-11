/**
 * Money in whole cents (ip-review design-checks-rules-and-approval.json, cross_cutting[0] item 2;
 * Group 3's D1): every sum and comparison is in integers, never in floating point.
 */

/**
 * The largest amount QuickBooks takes, in cents: $9,999,999,999.99, from its amount format, "max
 * 15 digits in 10.5 format" (Intuit's model file, `Amount` on an expense line).
 */
export const MAXIMUM_CENTS = 999_999_999_999;

/** One amount as read: none printed, too large to read at all, or whole cents. */
export type CentsReading =
  | { readonly kind: 'none' }
  /** |n| of 1e21 or more, which JavaScript only writes with an exponent. */
  | { readonly kind: 'out_of_range'; readonly negative: boolean }
  /** `fraction`: a digit past the cents, rounded half away from zero — the field is then unclear. */
  | { readonly kind: 'cents'; readonly cents: number; readonly fraction: boolean };

const NONE: CentsReading = { kind: 'none' };

/** The digits of a number from 1e-6 to below 1e21, as its shortest decimal form writes them. */
function digitsOf(magnitude: number): { whole: bigint; cents: bigint; rest: string } {
  // `String(n)` repeats what the model wrote — `412.5`, `0.30000000000000004` — and uses
  // no exponent between 1e-6 and 1e21, the only range read here.
  const [whole = '0', decimals = ''] = String(magnitude).split('.');
  const padded = decimals.padEnd(2, '0');
  return { whole: BigInt(whole), cents: BigInt(padded.slice(0, 2)), rest: padded.slice(2) };
}

/**
 * An amount in whole cents, read from its shortest decimal form: the whole part times 100 plus
 * the first two decimals. A further non-zero digit is a fraction of a cent: rounded half away
 * from zero and marked (`412.505` → 41251, `0.30000000000000004` → 30). Below 1e-6 rounds to 0,
 * marked; `-0` is 0; null, anything not a finite number, is none printed.
 */
export function toCents(value: unknown): CentsReading {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NONE;
  if (value === 0) return { kind: 'cents', cents: 0, fraction: false };
  const magnitude = Math.abs(value);
  if (magnitude >= 1e21) return { kind: 'out_of_range', negative: value < 0 };
  if (magnitude < 1e-6) return { kind: 'cents', cents: 0, fraction: true };
  const { whole, cents, rest } = digitsOf(magnitude);
  const fraction = /[1-9]/u.test(rest);
  const rounded = whole * 100n + cents + (fraction && rest[0]! >= '5' ? 1n : 0n);
  const signed = Number(rounded) * (value < 0 ? -1 : 1);
  return { kind: 'cents', cents: signed === 0 ? 0 : signed, fraction };
}

/**
 * A limit in whole cents, cut down to the cent and read exactly from its decimal form —
 * `499.995` → 49999, `500.005` → 50000 — or undefined for anything but a finite number of 0 or
 * more. Past any amount QuickBooks takes, it is the largest safe integer.
 */
export function floorCents(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (value === 0 || value < 1e-6) return 0;
  if (value >= 1e21) return Number.MAX_SAFE_INTEGER;
  const { whole, cents } = digitsOf(value);
  const floored = whole * 100n + cents;
  return floored > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(floored);
}

/** Two amounts that differ by at most one cent: the design's tolerance for every check that adds up. */
export function withinOneCent(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1;
}

/** Digits grouped in threes, as `1,250`, without a locale. */
export function groupedDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/**
 * Cents as a QuickBooks query's amount: whole dollars, a dot and two digits, with no sign,
 * separator or symbol — `125000` is `1250.00`, `50` is `0.50` — the form Intuit's own examples
 * quote (`TotalAmt > '1000.0'`), built from the integer, never through floating point. Anything
 * but whole cents of 0 or more is the caller's mistake, refused.
 */
export function queryAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error('a searched amount is whole cents, 0 or more');
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Cents as a person reads them: `$1,250.00` in US dollars, `1,250.00 CAD` in any other code. */
export function formatMoney(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const magnitude = Math.abs(cents);
  const text = `${groupedDigits(Math.floor(magnitude / 100))}.${String(magnitude % 100).padStart(2, '0')}`;
  return currency === 'USD' ? `${sign}$${text}` : `${sign}${text} ${currency}`;
}

/** An approval limit as a person reads it: `$500`, or `$500.50` when it has cents. */
export function formatLimit(cents: number): string {
  const text = formatMoney(cents);
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}
