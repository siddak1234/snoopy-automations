/**
 * `@autom8x/automation-kit/values` — the one cleaning of a value read from a document, done once
 * so every later check, lookup and line uses the same value (the plan of 2026-10-11, §2.2 and
 * §2.11; ip-review design-checks-rules-and-approval.json, cross_cutting[0]): text (`text.ts`),
 * whole cents (`money.ts`), real dates (`dates.ts`), the dated ISO 4217 list (`currency.ts`), lines
 * fitted to the platform's bound (`lines.ts`), and the receipt and credit rules — card digits
 * (`card.ts`), the tip (`tip.ts`), the credit sign (`credit.ts`). Pure functions on Node built-ins.
 */
export { cardDigits, sameCard } from './card.js';
export type { CardReading } from './card.js';
export { creditSignRule } from './credit.js';
export type { CreditSigns } from './credit.js';
export { ISO_4217_LIST_ONE, cleanCurrency } from './currency.js';
export type { CurrencyReading } from './currency.js';
export { EARLIEST_YEAR, addDays, isWithin, parseDate, utcDay } from './dates.js';
export type { DateReading } from './dates.js';
export {
  LINE_MAXIMUM,
  NAME_ROOM,
  capitalised,
  fitLine,
  fitReasonLine,
  phrasesKept,
} from './lines.js';
export type { LinePiece } from './lines.js';
export {
  MAXIMUM_CENTS,
  floorCents,
  formatLimit,
  formatMoney,
  groupedDigits,
  toCents,
  withinOneCent,
} from './money.js';
export type { CentsReading } from './money.js';
export {
  MAXIMUM_NAME_LENGTH,
  MAXIMUM_NUMBER_LENGTH,
  QUICKBOOKS_NUMBER_LENGTH,
  cleanText,
  sameName,
  shorten,
} from './text.js';
export { tipRule } from './tip.js';
export type { TipOutcome } from './tip.js';
