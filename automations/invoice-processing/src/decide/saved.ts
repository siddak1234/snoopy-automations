import { Buffer } from 'node:buffer';

import type { KeptType, PaymentMethod, RefundMethod, Route } from '../document.js';
import type { DecideState } from './contract.js';
import type { HoldCode } from './holds.js';
import { originalBillAccount, type Matches } from './matches.js';
import type { RecordPlan } from './plan.js';

/**
 * What decide saves for after approval (the plan's §2.8): built by ONE function for both the held
 * and the straight-through path, so the steps after it read one shape either way; the platform
 * keeps a held one verbatim and hands it back on approval. It never holds a line item, a
 * statement's row or a word of the model's answer, and over 32 KiB it is refused: decide fails
 * cleanly rather than send a result the platform would turn away.
 */

/** The most bytes the saved data may take: far inside the platform's 256 KiB callback body. */
export const SAVED_MAXIMUM_BYTES = 32 * 1024;

export interface SavedState {
  readonly v: 1;
  readonly documentType: KeptType;
  readonly route: Route;
  readonly plan: RecordPlan;
  /** Who paid: the route, their QuickBooks Id ("owner" for an owner), name, and a contractor's 1099 mark. */
  readonly payer: {
    readonly route: 'employee' | 'owner' | 'contractor';
    readonly id: string;
    readonly name: string;
    readonly vendor1099: boolean | null;
  } | null;
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
  /** Every record the duplicate lookups saw, by kind, for the re-check after approval. */
  readonly duplicates: Matches['seen'] & { readonly docNumberLeftOut: boolean };
  readonly holdReasons: readonly HoldCode[];
  /** For confirm-company: the company it was checked against. */
  readonly company: {
    readonly name: string;
    readonly legalName: string | null;
    readonly country: string;
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
): SavedState {
  const { document, payer, vendor, company, preferences, verification } = state;
  const route = document.route;
  const personal = route === 'employee' || route === 'owner' || route === 'contractor';
  const receipt = document.type === 'receipt';
  const credit = document.type === 'credit_note';
  return {
    v: 1,
    documentType: document.type,
    route,
    plan,
    payer:
      personal && payer !== null
        ? {
            route,
            id:
              route === 'owner'
                ? 'owner'
                : route === 'employee'
                  ? (payer.employeeId ?? '')
                  : vendor?.status === 'matched'
                    ? vendor.id
                    : '',
            name: payer.name,
            vendor1099:
              route === 'contractor' && vendor?.status === 'matched' ? vendor.vendor1099 : null,
          }
        : null,
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
    holdReasons: [...holdReasons],
    company: { name: company.name, legalName: company.legalName, country: company.country },
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
