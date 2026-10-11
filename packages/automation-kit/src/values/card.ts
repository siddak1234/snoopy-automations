/**
 * A card's last four digits (the plan's §2.2 and D19): kept only when they are exactly four
 * digits; anything else printed is unclear and never compared.
 */

/** Card digits as read: none printed, exactly four digits, or something else — unclear, not used. */
export type CardReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'digits'; readonly digits: string }
  | { readonly kind: 'unclear' };

/** Four ASCII digits after trimming: `4417` is; `****4417`, `441`, `44 17` and `４４１７` are unclear. */
export function cardDigits(value: unknown): CardReading {
  if (value === null || value === undefined) return { kind: 'none' };
  if (typeof value !== 'string') return { kind: 'unclear' };
  const text = value.trim();
  if (text === '') return { kind: 'none' };
  return /^[0-9]{4}$/u.test(text) ? { kind: 'digits', digits: text } : { kind: 'unclear' };
}

/**
 * The card check (D19): the digits printed against the company card's, `unknown` unless both are
 * four digits.
 */
export function sameCard(
  printed: CardReading,
  company: CardReading,
): 'same' | 'different' | 'unknown' {
  if (printed.kind !== 'digits' || company.kind !== 'digits') return 'unknown';
  return printed.digits === company.digits ? 'same' : 'different';
}
