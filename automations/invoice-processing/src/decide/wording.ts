import {
  LINE_MAXIMUM,
  NAME_ROOM,
  fitLine,
  fitReasonLine,
  formatLimit,
  formatMoney,
  phrasesKept,
  shorten,
  type LinePiece,
} from '@autom8x/automation-kit/values';

import type { DecideState } from './contract.js';
import type { Hold } from './holds.js';
import { limitCentsOf } from './holds.js';
import type { Matches } from './matches.js';
import type { RecordPlan } from './plan.js';

/**
 * What a person reads (the plan's §2.7, replacing Group 3's D7): the wording under decide's line,
 * which says what approving creates; the end of the approval's reason line, which says what the
 * record is; and decide's own timeline line. Each at most 200 characters; names — from QuickBooks,
 * the settings, or printed on the document — are shortened first with '…', and the amount always
 * stays.
 */

const nameOf = (state: DecideState, plan: RecordPlan): string =>
  plan.payee.kind === 'none' || plan.payee.kind === 'owner' || plan.payee.kind === 'employee'
    ? state.document.seller
    : plan.payee.name;

/** The number on a line: cut to 30 characters. */
const numberOf = (state: DecideState) =>
  state.document.number === null ? null : shorten(state.document.number, 30);

/**
 * Who paid, as the lines name them (§2.7: "Names come from QuickBooks, from your settings, or from
 * the document itself"): an employee as QuickBooks shows them (find-payer keeps its DisplayName),
 * an owner as "Owners and partners" writes them, and a contractor as the vendor find-vendor
 * matched, as QuickBooks shows it — never as typed in "Who paid".
 */
function payerName(state: DecideState): string {
  if (state.document.route === 'contractor' && state.vendor?.status === 'matched') {
    return state.vendor.displayName;
  }
  return state.payer?.name ?? '';
}

/** The wording under decide's line: what approving creates — and, for a receipt matching a bill, a warning. */
export function approvalWording(state: DecideState, plan: RecordPlan, matches: Matches): string {
  const amount = formatMoney(plan.amountCents);
  const payer = payerName(state);
  const paidFrom = { name: plan.accounts.paidFrom?.name ?? '' };
  switch (state.document.route) {
    case 'bill':
      return plan.payee.kind === 'new_vendor'
        ? 'Approve to create this vendor and bill in QuickBooks'
        : 'Approve to create this bill in QuickBooks';
    case 'company_receipt': {
      const bill = matches.matchedBill;
      if (bill !== null) {
        // An expense must not pay an existing bill (H1).
        const number = bill.docNumber === null ? null : shorten(bill.docNumber, 30);
        if (!bill.paid) {
          return number === null
            ? 'Approve only if this is a different purchase. If it pays that open bill, reject it and record the payment in Pay bills.'
            : `Approve only if this is a different purchase. If it pays bill ${number}, reject it and record the payment in Pay bills.`;
        }
        const which = number === null ? 'A bill from this seller' : `Bill ${number}`;
        const forAmount = bill.sameAmount ? ' for this amount' : '';
        return `Approve only if this is a different purchase. ${which}${forAmount} is already recorded and paid.`;
      }
      return fitLine(['Approve to record this expense, paid from ', paidFrom]);
    }
    case 'card_refund':
      return fitLine(['Approve to record this refund to ', paidFrom]);
    case 'vendor_credit':
      return fitLine(['Approve to record this vendor credit for ', { name: nameOf(state, plan) }]);
    case 'employee':
      return fitLine([
        'Approve to record this expense and that the company owes ',
        { name: payer },
        ` ${amount}`,
      ]);
    case 'owner':
      return fitLine([
        'Approve to record this expense as ',
        { name: payer },
        "'s owner investment",
      ]);
    case 'contractor':
      return fitLine([
        'Approve to create a bill so the company repays ',
        { name: payer },
        ` ${amount}`,
      ]);
    case 'statement':
      throw new Error('a statement is never approved');
  }
}

/** The end of the approval's reason line: what the record is, by path. */
export function reasonEnding(state: DecideState, plan: RecordPlan): LinePiece[] {
  const amount = formatMoney(plan.amountCents);
  const number = numberOf(state);
  const name = { name: nameOf(state, plan) };
  const seller = { name: state.document.seller };
  const payer = { name: payerName(state) };
  switch (state.document.route) {
    case 'bill':
      return [name, number === null ? '' : `, ${number}`, `, ${amount}`];
    case 'company_receipt':
      return [name, `, ${amount} from `, { name: plan.accounts.paidFrom?.name ?? '' }];
    case 'card_refund':
      return ['refund from ', name, `, ${amount}`];
    case 'vendor_credit':
      return ['credit from ', name, number === null ? '' : `, ${number}`, `, ${amount}`];
    case 'employee':
    case 'owner':
      return [payer, ' paid ', seller, `, ${amount}`];
    case 'contractor': {
      const marked =
        state.vendor?.status === 'matched' && state.vendor.vendor1099 === true
          ? ' (1099 vendor) paid '
          : ' (vendor, not marked 1099) paid ';
      return [payer, marked, seller, `, ${amount}`];
    }
    case 'statement':
      throw new Error('a statement is never approved');
  }
}

/** The approval's reason line: every hold's phrase, then the ending — "Paid personally; over the $500 limit: Jane Doe paid Brightquill Office Mart, $612.40". */
export function reasonLine(state: DecideState, plan: RecordPlan, holds: readonly Hold[]): string {
  return fitReasonLine(
    holds.map((hold) => hold.phrase),
    reasonEnding(state, plan),
  );
}

/** What decide's line notes, not holds (the plan's §2.4). */
export interface Notes {
  /**
   * The category used, and why (D27) — on every line decide writes, whatever else is left out:
   * "category Office Supplies (office supplies)"; where room is short, the account's name and the
   * why are shortened as names are, never under `NAME_ROOM` characters.
   */
  readonly category: readonly LinePiece[];
  /** A number kept in the memo, a web address in the name, and the rest: as room allows. */
  readonly others: readonly string[];
}

/** The fewest characters pieces take: their words, and each name cut no shorter than `NAME_ROOM`. */
function least(pieces: readonly LinePiece[]): number {
  return pieces.reduce(
    (total, piece) =>
      total + (typeof piece === 'string' ? piece.length : Math.min(piece.name.length, NAME_ROOM)),
    0,
  );
}

/** The characters pieces take with every name whole. */
const wholeLength = (pieces: readonly LinePiece[]) =>
  pieces.reduce(
    (total, piece) => total + (typeof piece === 'string' ? piece : piece.name).length,
    0,
  );

/** Pieces in at most `room` characters — names shortened first — but never fewer than `least`. */
const within = (pieces: readonly LinePiece[], room: number) =>
  fitLine(pieces, Math.max(room, least(pieces)));

export function notesOf(state: DecideState, plan: RecordPlan): Notes {
  const { document, company, preferences } = state;
  const others: string[] = [];
  const numberKept =
    document.number !== null &&
    plan.docNumber === null &&
    (document.route === 'bill' || document.route === 'vendor_credit');
  if (numberKept) others.push('number kept in the memo');
  if (document.sellerHasWebAddress) others.push('name has a web address');
  if (document.termsDiffer) others.push('terms differ from the printed due date');
  if (document.route === 'employee' && company.payrollFeature === true) {
    others.push('repay through a Reimbursement pay item that posts to the same liability');
  }
  if (preferences.bookCloseDate === null) others.push('no closing date from QuickBooks');
  const { category } = plan.accounts;
  return {
    category: [
      'category ',
      { name: shorten(category.name, 40) },
      ' (',
      { name: category.why },
      ')',
    ],
    others,
  };
}

const CREATING: Readonly<Record<RecordPlan['record'], string>> = {
  bill: 'creating the bill',
  expense: 'recording the expense',
  card_refund: 'recording the refund',
  vendor_credit: 'recording the vendor credit',
  journal_entry: 'recording the journal entry',
};

const HELD = 'Held: ';

/**
 * decide's line when the run holds, at most 200 characters (ip-review
 * design-checks-rules-and-approval.json cross_cutting[5] item 3; the plan's §2.4 and D27): 'Held: ',
 * the reasons in the plan's order, the other notes, and the category last — always. The reason line
 * names the holds by their phrases, and what it gave up to '+N more' is named here before anything
 * else, by its phrase where its detail does not fit — the category's name and why shortened for it,
 * if they must be; then the two reads' values and what is recorded (Group 2's D4); then each
 * reason's detail, or its phrase; then the notes. Whatever does not fit is left out, and the parts
 * after it are still tried. Only when what was given up is longer than any line could hold beside
 * the category does this line, too, say '+N more' for the reasons it cannot name: all of them are
 * in the saved data's `holdReasons`.
 */
export function heldSummary(
  state: DecideState,
  plan: RecordPlan,
  holds: readonly Hold[],
  notes: Notes,
): string {
  const kept = phrasesKept(
    holds.map((hold) => hold.phrase),
    reasonEnding(state, plan),
  );
  const indexed = holds.map((hold, index) => ({ hold, index }));
  const givenUp = indexed.filter(({ index }) => index >= kept);
  const briefest = (hold: Hold) =>
    hold.detail.length < hold.phrase.length ? hold.detail : hold.phrase;
  // Each part costs its words and the '; ' after it; the category ends the line.
  const givenUpCost = givenUp.reduce((total, { hold }) => total + briefest(hold).length + 2, 0);
  const category = within(notes.category, LINE_MAXIMUM - HELD.length - givenUpCost);
  let room = LINE_MAXIMUM - HELD.length - category.length;
  // What cannot all be named keeps room to be counted.
  const counted = givenUpCost > room;
  if (counted) room -= `+${givenUp.length} more`.length + 2;
  // The holds' parts, then the notes', in the order they are shown.
  const chosen: (string | undefined)[] = Array.from(
    { length: holds.length + notes.others.length },
    () => undefined,
  );
  /** `words` for the part at `index`, in place of what it had, when they fit: whether they do. */
  const put = (index: number, words: string): boolean => {
    const before = chosen[index];
    const cost = before === undefined ? words.length + 2 : words.length - before.length;
    if (cost > room) return false;
    chosen[index] = words;
    room -= cost;
    return true;
  };
  // The reason line's '+N more': here first, in the fewest words.
  const unnamed = givenUp.filter(({ hold, index }) => !put(index, briefest(hold))).length;
  // Both reads' values and what is recorded.
  for (const { hold, index } of indexed) {
    if (hold.code === 'reads_disagree') put(index, hold.detail);
  }
  // What was given up, by its detail; then the reasons the reason line names, by their details
  // or, where a detail does not fit, their phrases; then the notes.
  for (const { hold, index } of givenUp) {
    if (chosen[index] !== undefined) put(index, hold.detail);
  }
  for (const { hold, index } of indexed.slice(0, kept)) {
    if (!put(index, hold.detail)) put(index, hold.phrase);
  }
  notes.others.forEach((note, index) => put(holds.length + index, note));
  const named = (from: number, to: number) =>
    chosen.slice(from, to).filter((words): words is string => words !== undefined);
  return `${HELD}${[
    ...named(0, holds.length),
    ...(unnamed > 0 ? [`+${unnamed} more`] : []),
    ...named(holds.length, chosen.length),
    category,
  ].join('; ')}`;
}

/**
 * decide's line when nothing holds: why, then what it creates and the notes as they fit whole, and
 * the category last — always. The names in it share the room left, shortened first, so the amounts
 * and the words around them stay whole.
 */
export function straightSummary(
  state: DecideState,
  plan: RecordPlan,
  config: Parameters<typeof limitCentsOf>[0],
  notes: Notes,
): string {
  const amount = formatMoney(plan.amountCents);
  const limit = formatLimit(limitCentsOf(config));
  const vendor = state.vendor;
  const why = `No reason to hold: ${amount} within the ${limit} limit, `;
  let line: LinePiece[] =
    vendor?.status === 'matched'
      ? [
          why,
          { name: shorten(vendor.displayName, 40) },
          ` matched by ${vendor.matchedBy}, no duplicate`,
        ]
      : [`${why}no vendor to link, so no payee, no duplicate`];
  const end: LinePiece[] = ['; ', ...notes.category];
  for (const part of [CREATING[plan.record], ...notes.others]) {
    const longer = [...line, `; ${part}`];
    if (wholeLength([...longer, ...end]) <= LINE_MAXIMUM) line = longer;
  }
  return fitLine([...line, ...end]);
}
