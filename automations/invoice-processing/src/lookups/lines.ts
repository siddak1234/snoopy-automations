import type { FoundRecord, LookupKey } from '../decide/contract.js';
import { sameNumber } from '../decide/duplicate-rule.js';
import type { DocumentState } from '../state.js';

/**
 * The record lookups' timeline lines (§3.E): `Possible duplicate` when QuickBooks has a record for
 * this amount or with this number — or more than the search returned — and `No duplicate` when not;
 * decide weighs every record by the one rule. A statement's lookups compare it with the vendor's
 * bills, so theirs say what they checked, in the step's own words. Nothing from the document,
 * nothing QuickBooks named: the approver reads decide's reasons.
 */

/** What a lookup found, as its line says it. */
export interface Found {
  readonly document: DocumentState;
  readonly key: LookupKey;
  readonly records: readonly FoundRecord[];
  readonly reachedMax: boolean;
}

/** A statement's lookups, by what they check (the manifest's titles). */
const STATEMENT_LINES: Readonly<Partial<Record<LookupKey, string>>> = {
  numberLookup: 'Number checked',
  amountLookup: 'Amount checked',
};

/** A record for the document's amount or with its number: what a line calls a possible duplicate. */
function concerns(record: FoundRecord, document: DocumentState): boolean {
  const amount = document.amountCents;
  if (record.kind === 'journal_entry') {
    return record.lines.some((line) => line.amountCents === amount);
  }
  return record.totalCents === amount || sameNumber(record, document.number);
}

export function lookupLine(found: Found): string {
  if (found.document.route === 'statement') {
    return STATEMENT_LINES[found.key] ?? 'No duplicate';
  }
  const possible =
    found.reachedMax || found.records.some((record) => concerns(record, found.document));
  return possible ? 'Possible duplicate' : 'No duplicate';
}

/**
 * A lookup that applies but has no number QuickBooks could hold to search for (none read, or over
 * its 21 characters: G4-4): nothing was searched, so nothing was found.
 */
export function notCheckedLine(document: DocumentState, key: LookupKey): string {
  return lookupLine({ document, key, records: [], reachedMax: false });
}
