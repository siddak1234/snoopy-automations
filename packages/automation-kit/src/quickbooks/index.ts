/**
 * `@autom8x/automation-kit/quickbooks` — QuickBooks reads for an automation's steps:
 * the read itself (`read.ts`), readers for its answers (`answers.ts`) and the query
 * text (`query.ts`).
 */
export { entityOf, nameValueOf, queryRowsOf } from './answers.js';
export { lookupQuery } from './query.js';
export { QUICKBOOKS_SENTENCES, readQuickBooks, systemClock } from './read.js';
export type {
  Clock,
  QuickBooksFailureReason,
  QuickBooksRead,
  QuickBooksReadRequest,
} from './read.js';
