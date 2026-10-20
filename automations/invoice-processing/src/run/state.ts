import {
  artifactIdProblem,
  isObject,
  type JsonObject,
  type RunDocumentLineItem,
  type RunDocumentPayment,
  type RunDocumentReference,
  type RunDocumentVendor,
} from '@autom8x/automation-sdk';

import type { DocumentRule } from '../checks/rules.js';
import type { SpendType } from '../spend-types.js';
import { READ_TYPES, type ReadType } from './answer.js';

/**
 * v3's run state: v2's envelope for what the run shares — the file, the model that read it, and on
 * the QuickBooks path the company, its settings and its chart (`automations/invoice-processing/src/state.ts`) — and `documents`,
 * one entry per document the file holds, in its order. Each entry carries what was read of it,
 * cleaned once for the run's result (`read`), and `engine`: exactly the state v2's steps kept for
 * ONE document, so v2's checks, lookups, decide and writes run on each document unchanged.
 *
 * A held state travels to the platform and back verbatim, so every step reads it through
 * `runStateOf`, which refuses a malformed one.
 */

/** How a document goes through the run, from what it is (the owner's AM8, 2026-10-15). */
export type Kind =
  /** A bill, an invoice, a receipt or a credit note: checked, then recorded or saved. */
  | 'record'
  /** A supplier's statement: checked, then compared with QuickBooks or saved. */
  | 'statement'
  /** Any other financial document — a quote, an order, a bank statement: saved with all its data. */
  | 'kept'
  /** A page that is clearly not a financial document: held for review. */
  | 'not_financial';

export const KIND_OF: Readonly<Record<ReadType, Kind>> = {
  bill: 'record',
  invoice: 'record',
  receipt: 'record',
  credit_note: 'record',
  supplier_statement: 'statement',
  bank_statement: 'kept',
  quote: 'kept',
  purchase_order: 'kept',
  other_financial: 'kept',
  not_financial: 'not_financial',
};

/** What was read of one document, cleaned once for the run's result: every value, nothing cut. */
export interface DocumentRead {
  readonly type: ReadType;
  readonly vendor: RunDocumentVendor;
  readonly number: string | null;
  readonly numberLabel: string | null;
  readonly references: readonly RunDocumentReference[];
  readonly date: string | null;
  readonly time: string | null;
  readonly currency: string | null;
  readonly lineItems: readonly RunDocumentLineItem[];
  readonly lineItemsComplete: boolean;
  readonly subtotal: string | null;
  readonly tax: string | null;
  readonly tip: string | null;
  readonly discount: string | null;
  readonly total: string | null;
  /** Beside the wire's amounts, for the document's detail lines. */
  readonly shipping: string | null;
  readonly amountDue: string | null;
  readonly dueDate: string | null;
  readonly payment: RunDocumentPayment;
  readonly spendType: SpendType;
}

/**
 * Where a document is in the run: read and being checked; decided — ready to record, waiting for
 * approval, or done; and, in an approval's continuation, done after it.
 */
export type Stage = 'read' | 'ready' | 'waiting' | 'done';

export interface Entry {
  /** Its place in the file, from 1. */
  readonly index: number;
  readonly kind: Kind;
  readonly read: DocumentRead;
  /** The first read's answer as v2's checks read it (`v2AnswerOf`); dropped once decided. */
  readonly answer?: JsonObject;
  /** Why it waits, found before decide: lowercase phrases, in the order found. */
  readonly doubts: readonly string[];
  /** The rule its first read could not be used under, while a second read may settle it. */
  readonly unsettled?: DocumentRule | 'answer_unusable';
  /** v2's state for this one document: before decide its keys; after, decide's saved data. */
  readonly engine: JsonObject;
  readonly stage: Stage;
  /** Why it waits for approval, as the approval and its status line say it: lowercase, joined. */
  readonly waitingFor?: string;
  /** Recorded or saved once an approval let it go on. */
  readonly afterApproval?: boolean;
}

/** The whole run state as v3's steps read it. */
export interface RunState extends JsonObject {
  readonly documents: readonly Entry[];
}

const KINDS: readonly string[] = ['record', 'statement', 'kept', 'not_financial'];
const STAGES: readonly string[] = ['read', 'ready', 'waiting', 'done'];

function isEntry(value: unknown): value is Entry {
  if (!isObject(value)) return false;
  const { read } = value;
  return (
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    value.index >= 1 &&
    KINDS.includes(String(value.kind)) &&
    STAGES.includes(String(value.stage)) &&
    isObject(read) &&
    (READ_TYPES as readonly unknown[]).includes(read.type) &&
    isObject(read.vendor) &&
    Array.isArray(read.lineItems) &&
    Array.isArray(read.references) &&
    isObject(read.payment) &&
    Array.isArray(value.doubts) &&
    value.doubts.every((doubt) => typeof doubt === 'string') &&
    isObject(value.engine) &&
    (value.answer === undefined || isObject(value.answer)) &&
    (value.waitingFor === undefined || typeof value.waitingFor === 'string')
  );
}

/** The upload `receive` kept, in the platform's id shape; undefined before it, or malformed. */
export function artifactIdOf(state: JsonObject): string | undefined {
  const id = isObject(state.file) ? state.file.artifactId : undefined;
  return typeof id === 'string' && artifactIdProblem(id) === undefined ? id : undefined;
}

/** The state with its documents, each well formed and in the file's order; undefined otherwise. */
export function runStateOf(state: JsonObject): RunState | undefined {
  const { documents } = state;
  if (!Array.isArray(documents) || documents.length === 0 || !documents.every(isEntry)) {
    return undefined;
  }
  const ordered = documents.every(
    (entry, at) => at === 0 || entry.index > documents[at - 1]!.index,
  );
  return ordered ? (state as RunState) : undefined;
}

/** The state with one step's entries in place of the old. */
export function withEntries(state: JsonObject, documents: readonly Entry[]): JsonObject {
  return { ...state, documents: documents as unknown as JsonObject[] };
}

/** The keys the run shares, which v2's steps read beside one document's own. */
export const SHARED_KEYS = ['file', 'modelServed', 'company', 'preferences', 'chart'] as const;

/**
 * v2's state for one document, as v2's steps read it: before decide, what the run shares and the
 * document's own keys; after decide, decide's saved data alone, which carries everything they read.
 */
export function engineState(state: JsonObject, entry: Entry): JsonObject {
  if (entry.stage !== 'read') return entry.engine;
  const shared = Object.fromEntries(
    SHARED_KEYS.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]),
  );
  return { ...shared, ...entry.engine };
}

/** What a v2 step left for one document: its own keys, the run's shared ones taken out. */
export function engineOf(entry: Entry, next: JsonObject): JsonObject {
  if (entry.stage !== 'read') return next;
  const own = { ...next };
  for (const key of [...SHARED_KEYS, 'documents']) delete own[key];
  return own;
}
