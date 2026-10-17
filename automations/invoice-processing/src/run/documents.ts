import { cleanText } from '@autom8x/automation-kit/values';
import type {
  InvokeRequest,
  JsonObject,
  RunDocument,
  RunDocumentType,
} from '@autom8x/automation-sdk';

import { QUICKBOOKS, quickBooksStateOf, vendorChoiceOf } from '../quickbooks-path.js';
import { RECORD_WORDS, SPEND_TYPE_WORDS, dayWords, money } from '../words.js';
import { nextStepOf, payeeNameOf } from '../writes/lines.js';
import { createdOf, newVendorOf, readSaved, statementOf } from '../writes/saved-state.js';
import type { ReadType } from './answer.js';
import type { Entry } from './state.js';
import { NO_RECORD_FOR, statusText, totalWords, type Outcome, type Summarised } from './words.js';

/**
 * Each document as the run's result carries it (`RunDocument`, the platform's ADR-0039): what was
 * read of it, whole, and what became of it — its status, its line, where it was recorded and the
 * lines a person reads beside it. The same object is the result's, the run's row's, the run
 * page's, the JSON file's and the run's emails' (the platform renders them, the owner's AM3).
 */

/** v3's read types as the wire names a document: a supplier's statement is `statement`; any other financial document or page, `other`. */
export const RUN_TYPES: Readonly<Record<ReadType, RunDocumentType>> = {
  bill: 'bill',
  invoice: 'invoice',
  receipt: 'receipt',
  credit_note: 'credit_note',
  supplier_statement: 'statement',
  bank_statement: 'bank_statement',
  quote: 'quote',
  purchase_order: 'purchase_order',
  other_financial: 'other',
  not_financial: 'other',
};

/** The record a recorded document became: its noun, its Id, and the decision. */
interface Recorded {
  readonly outcome: Extract<Outcome, { status: 'recorded' }>;
  readonly id: string;
}

function recordedOf(entry: Entry): Recorded | undefined {
  const created = createdOf(entry.engine);
  if (!created) return undefined;
  const saved = readSaved(entry.engine);
  const newVendor = newVendorOf(entry.engine) ?? null;
  const words = RECORD_WORDS[created.record as keyof typeof RECORD_WORDS];
  // A record QuickBooks holds is named whatever else the state lacks: never "saved" (v2's guard).
  const vendor =
    (saved ? payeeNameOf(saved, created, newVendor) : created.payeeName) ??
    saved?.seller ??
    cleanText(entry.read.vendor.name) ??
    'the seller';
  const cents = created.totalCents ?? saved?.plan.amountCents ?? null;
  return {
    id: created.id,
    outcome: {
      status: 'recorded',
      noun: words?.noun ?? 'record',
      vendor,
      total: cents === null ? '' : money(cents),
    },
  };
}

/** What became of one document, from what its steps left. */
export function outcomeOf(entry: Entry, request: Pick<InvokeRequest, 'config'>): Outcome {
  if (entry.stage === 'waiting') return { status: 'waiting', reason: entry.waitingFor ?? '' };
  const recorded = recordedOf(entry);
  if (recorded) return recorded.outcome;
  const statement = statementOf(entry.engine);
  if (statement) return { status: 'compared', missing: statement.listedNotInQuickBooks.length };
  const stop = quickBooksStateOf(entry.engine);
  if (stop && 'unconfirmed' in stop) return { status: 'unconfirmed' };
  if (stop) return { status: 'not_recorded', reason: stop.notRecorded };
  const quickBooks = vendorChoiceOf(request.config) === QUICKBOOKS;
  return { status: 'saved', why: quickBooks ? (NO_RECORD_FOR[entry.read.type] ?? null) : null };
}

type Line = readonly [label: string, value: string | null];

/** The lines with a value. */
const kept = (lines: readonly Line[]) =>
  lines.flatMap(([label, value]) => (value === null || value === '' ? [] : [{ label, value }]));

/** The lines a person reads beside one document (§3.5), each left out when it has no value. */
function detailsOf(entry: Entry, outcome: Outcome): { label: string; value: string }[] {
  const { read } = entry;
  const amount = (value: string | null) => totalWords(value, read.currency);
  const printed: Line[] = [
    ['Due', read.dueDate === null ? null : dayWords(read.dueDate)],
    ['Shipping', amount(read.shipping)],
  ];
  if (outcome.status === 'recorded') {
    const saved = readSaved(entry.engine);
    return kept([
      ['Category', saved?.plan.accounts.category.name ?? null],
      ['Paid from', saved?.plan.accounts.paidFrom?.name ?? null],
      ['Decided', entry.afterApproval === true ? 'After approval' : 'Automatically'],
      ['Next', saved ? nextStepOf(saved) : null],
      ...printed,
    ]);
  }
  const statement = statementOf(entry.engine);
  if (statement) {
    return kept([
      ['Statement total', statement.closingCents === null ? null : money(statement.closingCents)],
      [
        'Open in QuickBooks',
        statement.quickBooksOpenCents === null ? null : money(statement.quickBooksOpenCents),
      ],
    ]);
  }
  const purchase = entry.kind === 'record';
  return kept([['Category', purchase ? SPEND_TYPE_WORDS[read.spendType] : null], ...printed]);
}

/** One document, whole, as the result carries it. */
export function runDocumentOf(entry: Entry, request: Pick<InvokeRequest, 'config'>): RunDocument {
  const { read } = entry;
  const outcome = outcomeOf(entry, request);
  const recorded = outcome.status === 'recorded' ? recordedOf(entry) : undefined;
  return {
    index: entry.index,
    status: outcome.status,
    statusText: statusText(outcome),
    type: RUN_TYPES[read.type],
    vendor: { ...read.vendor },
    number: read.number,
    numberLabel: read.numberLabel,
    references: read.references.map((reference) => ({ ...reference })),
    date: read.date,
    time: read.time,
    currency: read.currency,
    lineItems: read.lineItems.map((line) => ({ ...line })),
    lineItemsComplete: read.lineItemsComplete,
    subtotal: read.subtotal,
    tax: read.tax,
    tip: read.tip,
    discount: read.discount,
    total: read.total,
    payment: { ...read.payment },
    recordedIn:
      recorded === undefined
        ? null
        : { providerId: QUICKBOOKS, recordType: recorded.outcome.noun, recordId: recorded.id },
    details: detailsOf(entry, outcome),
  };
}

/** One document as the run's summary counts it. */
export function summarised(entry: Entry, request: Pick<InvokeRequest, 'config'>): Summarised {
  return {
    outcome: outcomeOf(entry, request),
    type: entry.read.type,
    seller: cleanText(entry.read.vendor.name),
    total: totalWords(entry.read.total, entry.read.currency),
  };
}

/** The documents a state holds, whole; none for a state that holds none. */
export function runDocumentsOf(
  documents: readonly Entry[],
  request: Pick<InvokeRequest, 'config'>,
): RunDocument[] {
  return documents.map((entry) => runDocumentOf(entry, request));
}

/** Whether a state's documents include one QuickBooks may hold now: recorded, or written unconfirmed. */
export function written(engine: JsonObject): 'recorded' | 'unconfirmed' | null {
  if (createdOf(engine)) return 'recorded';
  const stop = quickBooksStateOf(engine);
  return stop && 'unconfirmed' in stop ? 'unconfirmed' : null;
}
