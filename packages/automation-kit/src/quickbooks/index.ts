/**
 * `@autom8x/automation-kit/quickbooks` — QuickBooks calls for an automation's steps:
 * the read (`read.ts`), the write (`write.ts`), readers for their answers (`answers.ts`)
 * and the query text (`query.ts`).
 */
export { entityOf, nameValueOf, queryRowsOf } from './answers.js';
export {
  TRANSACTION_ENTITIES,
  dateRange,
  lookupInQuery,
  lookupLikeQuery,
  lookupQuery,
  transactionQuery,
} from './query.js';
export type { Comparison, QueryCondition, TransactionEntity, TransactionSearch } from './query.js';
export { QUICKBOOKS_SENTENCES, readQuickBooks, systemClock } from './read.js';
export type {
  Clock,
  QuickBooksFailureReason,
  QuickBooksRead,
  QuickBooksReadRequest,
} from './read.js';
export { QUICKBOOKS_WRITES, writeQuickBooks, writeSentences } from './write.js';
export type {
  QuickBooksWrite,
  QuickBooksWriteFailure,
  QuickBooksWriteKind,
  QuickBooksWriteRequest,
} from './write.js';
