import { Buffer } from 'node:buffer';

import type { KeptType, PaymentMethod, RefundMethod, Route } from '../document.js';
import type { DecideState } from './contract.js';
import type { HoldCode } from './holds.js';
import { readOf, type SavedRead } from '../details.js';
import { originalBillAccount, type Matches } from './matches.js';
import type { RecordPlan } from './plan.js';
import type { Recheck } from './recheck.js';

/**
 * What decide saves for after approval (the plan's §2.8): built by ONE function for both the held
 * and the straight-through path, so the steps after it read one shape either way; the platform
 * keeps a held one verbatim and hands it back on approval. It never holds a line item, a
 * statement's row or a word of the model's answer, and over 32 KiB it is refused: decide fails
 * cleanly rather than send a result the platform would turn away. It is the ONLY input of the
 * steps after decide (19–24): what they check, what create-record writes, what notify mails.
 */

/** The most bytes the saved data may take: far inside the platform's 256 KiB callback body. */
export const SAVED_MAXIMUM_BYTES = 32 * 1024;

export interface SavedState {
  /** 2: v2's shape — the read kept for the details, no payer. A held v1 state is v1's container's. */
  readonly v: 2;
  readonly documentType: KeptType;
  readonly route: Route;
  /** The seller as printed, cleaned — carried by design, as on every line (the plan's §2.9). */
  readonly seller: string;
  /** The document's own number, cleaned; null when none was read. Carried by design too. */
  readonly documentNumber: string | null;
  readonly plan: RecordPlan;
  /**
   * The document as read and checked, as the saved details show it (v2's §2.8): kept so a document
   * QuickBooks does not record after all — a failure after the approval (decision 6) — still has
   * its details saved.
   */
  readonly read: SavedRead;
  /** What a receipt's holds used. */
  readonly receipt: {
    readonly paymentMethod: PaymentMethod;
    readonly tipCents: number | null;
    readonly tipAdded: boolean;
    readonly cardLast4: string | null;
  } | null;
  /** What a credit's used: how it is given back, and the original bill it reduces. */
  readonly credit: {
    readonly refundMethod: RefundMethod;
    readonly originalBillId: string | null;
  } | null;
  /** Every record the duplicate lookups saw, by kind: the approver saw them, so the re-check allows them. */
  readonly duplicates: Matches['seen'] & { readonly docNumberLeftOut: boolean };
  /** confirm-no-duplicate's one query and what its rule compares (`recheck.ts`). */
  readonly recheck: Recheck;
  readonly holdReasons: readonly HoldCode[];
  /** For confirm-company: the company it was checked against, and when its file was created. */
  readonly company: {
    readonly name: string;
    readonly legalName: string | null;
    readonly country: string;
    readonly createdAt: string | null;
  };
  readonly preferences: { readonly homeCurrency: string; readonly multiCurrencyEnabled: boolean };
  readonly artifactId: string;
  readonly modelServed: { readonly first: string; readonly second: string | null };
}

export function savedStateOf(
  state: DecideState,
  plan: RecordPlan,
  matches: Matches,
  holdReasons: readonly HoldCode[],
  recheck: Recheck,
): SavedState {
  const { document, company, preferences, verification } = state;
  const route = document.route;
  const receipt = document.type === 'receipt';
  const credit = document.type === 'credit_note';
  return {
    v: 2,
    documentType: document.type,
    route,
    seller: document.seller,
    documentNumber: document.number,
    plan,
    read: readOf(document),
    receipt: receipt
      ? {
          paymentMethod: document.paymentMethod,
          tipCents: document.tipCents,
          tipAdded: document.tip === 'added',
          cardLast4: document.cardLast4,
        }
      : null,
    credit: credit
      ? {
          refundMethod: document.refundMethod,
          originalBillId: originalBillAccount(state)?.billId ?? null,
        }
      : null,
    duplicates: {
      ...matches.seen,
      docNumberLeftOut: document.number !== null && plan.docNumber === null,
    },
    recheck,
    holdReasons: [...holdReasons],
    company: {
      name: company.name,
      legalName: company.legalName,
      country: company.country,
      createdAt: company.createdAt ?? null,
    },
    preferences: {
      homeCurrency: preferences.homeCurrency,
      multiCurrencyEnabled: preferences.multiCurrencyEnabled,
    },
    artifactId: state.file.artifactId,
    modelServed: {
      first: state.modelServed,
      second: verification.status === 'made' ? verification.modelServed : null,
    },
  };
}

/** The saved data's size in bytes, as the platform counts its JSON. */
export function savedBytes(saved: SavedState): number {
  return Buffer.byteLength(JSON.stringify(saved), 'utf8');
}
