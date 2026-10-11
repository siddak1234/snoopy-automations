import { LINE_MAXIMUM, shorten } from '@autom8x/automation-kit/values';

/**
 * Lines decide writes for a person — its timeline line and a statement's — fitted to the
 * platform's bound by leaving out what matters least, never by cutting an amount in half.
 */

/**
 * The parts joined by '; ', then `tail`, in at most `maximum` characters: the parts that do not
 * fit are left out from the end; the first is always kept, and shortened only when it alone is
 * too long. `tail` always stays.
 */
export function joinWithin(parts: readonly string[], tail: string, maximum = LINE_MAXIMUM): string {
  const room = maximum - tail.length;
  let line = '';
  for (const part of parts) {
    const next = line === '' ? part : `${line}; ${part}`;
    if (next.length > room) break;
    line = next;
  }
  if (line === '' && parts.length > 0) line = shorten(parts[0]!, room);
  return `${line}${tail}`;
}
