import { MAXIMUM_NAME_LENGTH, cleanText } from '@autom8x/automation-kit/values';

import { accountNameOf } from './account-settings.js';

/**
 * The reading of "Owners and partners" (the owner's D15): one entry per person, separated by
 * semicolons; an entry may add "= <equity account>" for that person's own account —
 * `Jane Doe = Partner investments:Jane; Sam Lee`. A name is cleaned as "Who paid" is, and the
 * two are compared without case. Read once by `find-accounts`, which resolves each own account
 * and keeps the owners in the run's state for `find-payer`.
 */

/** The most owners and partners one setting may name: room for a partnership, a bound on the query. */
export const MAXIMUM_OWNERS = 20;

export interface Owner {
  /** As written in the setting, cleaned. */
  readonly name: string;
  /** Their own equity account's full name, when the entry gives one. */
  readonly accountName: string | null;
}

/**
 * The owners, in the setting's order; `[]` when the setting is empty. `undefined` when it
 * cannot be read: an entry with no name, a name over 500 characters, an "=" with no account
 * name after it or an account name QuickBooks could not have, a person named twice, or more
 * than 20 people. Empty entries — a semicolon at the end — are skipped.
 */
export function readOwners(value: unknown): readonly Owner[] | undefined {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const owners: Owner[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(';')) {
    if (entry.trim() === '') continue;
    const equals = entry.indexOf('=');
    const name = cleanText(equals === -1 ? entry : entry.slice(0, equals));
    if (name === null || name.length > MAXIMUM_NAME_LENGTH) return undefined;
    let accountName: string | null = null;
    if (equals !== -1) {
      const account = accountNameOf(entry.slice(equals + 1));
      if (account === undefined) return undefined;
      accountName = account;
    }
    const folded = name.toLowerCase();
    if (seen.has(folded)) return undefined;
    seen.add(folded);
    owners.push({ name, accountName });
  }
  return owners.length > MAXIMUM_OWNERS ? undefined : owners;
}
