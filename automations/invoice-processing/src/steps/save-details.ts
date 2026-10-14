import { isObject, type JsonObject, type Step } from '@autom8x/automation-sdk';

import { readOf, type SavedRead } from '../details.js';
import { runFails } from '../outcome.js';
import { onQuickBooksPath, quickBooksStateOf } from '../quickbooks-path.js';
import type { DocumentState } from '../state.js';
import { lineWith, money } from '../words.js';
import { readSaved } from '../writes/saved-state.js';

/**
 * `save-details` (v2) — the document's details saved for the team: what it is, the seller, its
 * number, dates and amounts, its category and how it was paid. It runs when the flow's vendor is
 * "None" — the owner's "Quickbooks is optional … or just a none" (build 19) — and when QuickBooks
 * did not record the document after all: one of its rules (the spec's S2), or QuickBooks failing
 * mid-run (the session's decision 6). Code only: the run's result carries the details
 * (`src/output.ts`), which the platform keeps with the run and shows to the workspace (its
 * ADR-0037). Skipped on the QuickBooks path, where the record, or the statement compared, is the
 * result.
 *
 * Line (§3.E): `Saved: Harrowgate Office Supply, $461.53`.
 */

/** What save-details keeps: the read, and why QuickBooks has none of it, when it was chosen. */
export interface SavedDetailsState extends SavedRead {
  /** §3.F's reason, when QuickBooks was chosen and did not record it; else null. */
  readonly notRecorded: string | null;
  /** A write nothing answered: QuickBooks may hold it. */
  readonly unconfirmed: boolean;
}

/** The read: check-document's document, or — after decide — the plan's saved copy of it. */
function readFrom(state: JsonObject): SavedRead | undefined {
  const document = documentOf(state);
  if (document) return readOf(document);
  return readSaved(state)?.read;
}

/** check-document's document as the details read it: a statement or a record, whatever its amounts. */
function documentOf(state: JsonObject): DocumentState | undefined {
  const { document } = state;
  return isObject(document) &&
    typeof document.seller === 'string' &&
    typeof document.type === 'string' &&
    isObject(document.arithmetic)
    ? (document as unknown as DocumentState)
    : undefined;
}

export const saveDetails: Step = ({ request, state }) => {
  if (onQuickBooksPath(request, state)) return Promise.resolve({ outcome: 'skipped' });
  const read = readFrom(state);
  const quickBooks = quickBooksStateOf(state);
  // check-document leaves the document before this step on every path: a guard.
  if (!read || quickBooks === undefined) {
    return Promise.resolve(runFails('other', 'state_incomplete'));
  }
  const saved: SavedDetailsState = {
    ...read,
    notRecorded: quickBooks !== null && 'notRecorded' in quickBooks ? quickBooks.notRecorded : null,
    unconfirmed: quickBooks !== null && 'unconfirmed' in quickBooks,
  };
  const total = read.totalCents === null ? '' : `, ${money(read.totalCents, read.currency)}`;
  return Promise.resolve({
    outcome: 'ok',
    summary: lineWith('Saved: ', read.seller, total),
    state: { ...state, savedDetails: saved as unknown as JsonObject },
  });
};

/** `state.savedDetails`: absent until save-details ran. */
export function savedDetailsOf(state: JsonObject): SavedDetailsState | undefined {
  const value = state.savedDetails;
  return isObject(value) &&
    typeof value.seller === 'string' &&
    typeof value.unconfirmed === 'boolean'
    ? (value as unknown as SavedDetailsState)
    : undefined;
}
