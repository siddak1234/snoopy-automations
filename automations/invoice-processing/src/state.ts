import type { JsonObject } from '@autom8x/automation-sdk';

import type { FileKind } from './file.js';

/**
 * The run's state between steps — this automation's own envelope, which a held run
 * hands back verbatim in its continuation.
 *
 * A step's returned state REPLACES the whole state (the SDK's runner), so every step
 * returns `{ ...state, <its key>: value }` and writes no other step's key. Bytes, links
 * and filenames never enter it: a held state travels to the platform and back.
 */

/** `receive`: the file, as the platform measured it. */
export interface FileState {
  readonly artifactId: string;
  readonly kind: FileKind;
  readonly sizeBytes: number;
  /** A PDF's pages; null for an image. */
  readonly pages: number | null;
  /** The store's digest of the bytes, when it gave one. */
  readonly sha256: string | null;
}

/** `read-company`: the names kept for the checks that compare them later. */
export interface CompanyState {
  readonly name: string;
  readonly legalName: string | null;
  /** As QuickBooks returned it. */
  readonly country: string;
}

/** `read-preferences`: the settings later steps read. */
export interface PreferencesState {
  readonly homeCurrency: string;
  readonly multiCurrencyEnabled: boolean;
  readonly customTxnNumbers: boolean | null;
  readonly warnDuplicateBillNumber: boolean | null;
  /** The books' closing date, `YYYY-MM-DD`, when QuickBooks returned a real one. */
  readonly bookCloseDate: string | null;
}

/** `find-account`: the account the bill's line posts to. */
export interface AccountState {
  readonly id: string;
  readonly fullyQualifiedName: string;
}

/**
 * `extract`: the model's answer, whole — the 18 fields of `prompts/extract-invoice.v1.json`,
 * held to its schema by the platform — kept only until the step that checks it replaces it
 * with the fields it cleans, so a held state never carries a line's raw text; and the model
 * that served, as the router reported it, which may differ from the id asked for.
 */
export interface ExtractionState {
  readonly extraction: JsonObject;
  readonly modelServed: string;
}
