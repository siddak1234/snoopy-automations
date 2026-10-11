import { shorten } from './text.js';

/**
 * A line a person reads — a timeline line, an approval's reason, the wording under it — fitted to
 * the platform's bound (its `automation-run-result.json`: every one-line field at most 200
 * characters) by shortening NAMES first, so an amount, a number or a fixed phrase is never cut
 * (ip-review design-checks-rules-and-approval.json, cross_cutting[5]; the plan's §2.7, "Names are
 * shortened first with '…', and the amount always stays").
 */

/** The platform's bound on a one-line field. */
export const LINE_MAXIMUM = 200;

/** A piece of a line: words kept whole, or a name that may be shortened with '…'. */
export type LinePiece = string | { readonly name: string };

/** The room a reason line keeps for its names before it gives up phrases for '+N more'. */
export const NAME_ROOM = 12;

function lengthOf(pieces: readonly LinePiece[], fixedOnly = false): number {
  return pieces.reduce(
    (total, piece) =>
      total + (typeof piece === 'string' ? piece.length : fixedOnly ? 0 : piece.name.length),
    0,
  );
}

/**
 * The length each name may keep so that all of them fit in `room`: a name shorter than an even
 * share keeps its length, and the longer ones share what is left ("water-filling", the longest
 * cut first), the odd characters going to the first of them.
 */
function capsFor(lengths: readonly number[], room: number): number[] {
  const order = lengths.map((length, index) => ({ length, index }));
  order.sort((a, b) => a.length - b.length);
  let left = room;
  for (const [position, { length }] of order.entries()) {
    const remaining = order.length - position;
    const share = Math.floor(left / remaining);
    if (length > share) {
      const cut = new Set(order.slice(position).map((each) => each.index));
      let extra = left - share * remaining;
      return lengths.map((each, index) => {
        if (!cut.has(index)) return each;
        if (extra > 0) {
          extra -= 1;
          return share + 1;
        }
        return share;
      });
    }
    left -= length;
  }
  return [...lengths];
}

/**
 * The pieces as one line of at most `maximum` characters: as they are when they fit; else each
 * name longer than the room allows is shortened with '…', the longest first, so the fixed words
 * always stay whole. Fixed words that alone exceed the bound — never the case for this
 * automation's lines, whose fixed parts are bounded — are cut last.
 */
export function fitLine(pieces: readonly LinePiece[], maximum = LINE_MAXIMUM): string {
  const whole = pieces.map((piece) => (typeof piece === 'string' ? piece : piece.name)).join('');
  if (whole.length <= maximum) return whole;
  const names = pieces.filter((piece): piece is { name: string } => typeof piece !== 'string');
  const room = maximum - lengthOf(pieces, true);
  const caps = capsFor(
    names.map((piece) => piece.name.length),
    Math.max(room, names.length),
  );
  let next = 0;
  const fitted = pieces
    .map((piece) => {
      if (typeof piece === 'string') return piece;
      const cap = caps[next] ?? 1;
      next += 1;
      return shorten(piece.name, Math.max(cap, 1));
    })
    .join('');
  return fitted.length <= maximum ? fitted : shorten(fitted, maximum);
}

/** The first letter upper-case. */
export function capitalised(text: string): string {
  return text === '' ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/**
 * An approval's reason line: the phrases in their order, joined by '; ', the first letter
 * upper-case, then ': ' and the ending — "Over the $500 limit; new vendor: Acme Supplies,
 * INV-1001, $1,250.00". When the phrases leave the names fewer than `NAME_ROOM` characters each
 * (or their whole length, when shorter), the last phrases give way to '+N more'; then only the
 * names are shortened. With no phrase it is the ending alone.
 */
export function fitReasonLine(
  phrases: readonly string[],
  ending: readonly LinePiece[],
  maximum = LINE_MAXIMUM,
): string {
  if (phrases.length === 0) return fitLine(ending, maximum);
  const names = ending.filter((piece): piece is { name: string } => typeof piece !== 'string');
  const needed = names.reduce((total, piece) => total + Math.min(piece.name.length, NAME_ROOM), 0);
  for (let kept = phrases.length; kept >= 1; kept -= 1) {
    const dropped = phrases.length - kept;
    const head = capitalised(
      [...phrases.slice(0, kept), ...(dropped > 0 ? [`+${dropped} more`] : [])].join('; '),
    );
    const line: LinePiece[] = [`${head}: `, ...ending];
    if (kept === 1 || maximum - lengthOf(line, true) >= needed) return fitLine(line, maximum);
  }
  return fitLine(ending, maximum);
}
