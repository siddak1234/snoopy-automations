/**
 * How the lookups search expenses (Intuit's Purchase) for an amount — sandbox item S4 (the plan's
 * §7): Intuit's model file does not mark `Purchase.TotalAmt` filterable, though Intuit's own sample
 * query filters on it. Set from sandbox S4 before v1 registers — a registered version is never
 * edited — and S4 answered on 2026-10-12: Intuit filters `TotalAmt =` within a date range, leaving
 * out other totals and days outside it, so it stays `amount`; the `window` fallback worked too.
 *
 * - `amount` — D21 as the owner decided it, and the default: the bank-feed checks (a company
 *   receipt's, a card refund's, and hold 7's for a purchase someone paid personally) ask for
 *   expenses of the amount (`TotalAmt =`) dated from 1 day before the document to 20 days after,
 *   at most 3; the account and `Credit` are compared in code. A bill's D32 check asks for expenses
 *   of its total from 1 day before its date to 20 days after its due date.
 * - `window` — §5's fallback, when S4 shows the amount cannot be searched: those bank-feed checks
 *   ask for the window alone, newest first, as many rows as fit the 192 KiB answer (50), and code
 *   compares the amount and the account; a full answer is a possible duplicate (D6), its line "too
 *   many expenses to check". A bill's window is longer, so its D32 check is dropped and decision
 *   6's number check remains.
 */
export type ExpenseSearch = 'amount' | 'window';

/** Sandbox S4's answer (2026-10-12): D21's search by amount, which Intuit filters. */
export const EXPENSE_SEARCH: ExpenseSearch = 'amount';
