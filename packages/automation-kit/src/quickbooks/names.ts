import type { JsonObject } from '@autom8x/automation-sdk';

/**
 * QuickBooks' mark on a name it made inactive (sandbox G4–5 and S1, 2026-10-12): a vendor or an
 * employee made inactive has its `DisplayName`, and an account its `Name` and
 * `FullyQualifiedName`, renamed "<name> (deleted)" — so a lookup by the name alone never finds it,
 * and the name is free again for a new record. A vendor's `CompanyName` and `PrintOnCheckName`
 * keep their words. A lookup that must tell "inactive" from "no match" asks for both forms
 * (`withDeletedForm`) and reads the rows back with `rowsNaming`.
 */
export const DELETED_MARK = ' (deleted)';

/** A name, and the name QuickBooks gives the record that had it once it is inactive. */
export function withDeletedForm(name: string): [string, string] {
  return [name, `${name}${DELETED_MARK}`];
}

/** A missing Active is Intuit's default, true. */
const inactive = (row: JsonObject): boolean => row.Active === false;

/**
 * A row's `field` as it read before QuickBooks marked it: an INACTIVE row's "Acme (deleted)" is
 * "Acme", so a line shows the name once and marks it inactive once; any other value as it is —
 * an active record a person named "… (deleted)" keeps its name.
 */
export function unmarkedName(row: JsonObject, field: string): unknown {
  const value = row[field];
  return inactive(row) && typeof value === 'string' && value.endsWith(DELETED_MARK)
    ? value.slice(0, -DELETED_MARK.length)
    : value;
}

/** What a lookup of both forms found for one name. */
export interface NamedRows {
  /**
   * The rows that hold the name as it is; only when none does, the inactive rows QuickBooks renamed
   * from it. So an active record made with a name an inactive one once had is that record, as
   * QuickBooks shows it — as a lookup by the name alone found it and nothing else — and an inactive
   * record renamed from the name reaches the caller's "inactive" answer instead of its "none".
   */
  readonly rows: JsonObject[];
  /** The rows that name neither form: a match QuickBooks made some other way, for the caller to ignore. */
  readonly others: number;
}

/** The rows of `rows` naming `name` in `field`, `same` comparing a row's value with it. */
export function rowsNaming(
  rows: readonly JsonObject[],
  field: string,
  name: string,
  same: (value: unknown, name: string) => boolean,
): NamedRows {
  const live = rows.filter((row) => same(row[field], name));
  // A row whose name carries no mark reads as itself, so only a renamed one can match here.
  const renamed = rows.filter((row) => !live.includes(row) && same(unmarkedName(row, field), name));
  return {
    rows: live.length > 0 ? live : renamed,
    others: rows.length - live.length - renamed.length,
  };
}
