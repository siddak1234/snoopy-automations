import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { wordsIn } from '../candidates.js';
import { inFamily } from '../families.js';
import type { Diagnosis } from '../reading.js';
import type { CodeTable } from '../tables.js';

/**
 * The one word-overlap score of v2's choices: for a diagnosis's statement, how many words
 * (`wordsIn`) a code's title shares with it. `rankCandidates` ranks a diagnosis's codes by it, and
 * v3's `otherCodes` (`child-steps.ts`) the other codes it keeps.
 */
export function sharedWords(statement: string, codes: CodeTable): (code: string) => number {
  const said = wordsIn(statement);
  return (code) => [...wordsIn(codes[code] ?? '')].filter((word) => said.has(word)).length;
}

/**
 * v2's candidates (the spec, "v2", F1): every flag-1 code of the visit's table under a diagnosis's
 * categories, never limited — v1's 60 left 40,646 of the table's codes never offerable — with the
 * clinic's preference families first, then the codes the clinic accepted before (its memory,
 * `remembered`, the most accepted first), then, inside each part, v1's rank: the words its title
 * shares with the statement (`sharedWords`), then the shorter codes, then the table's order.
 * The specialties are NUCC codes (`automations/icd10-code-check/assets/v2/specialties.json`);
 * their families are `automations/icd10-code-check/assets/v2/preferences.json`'s, built by
 * `automations/icd10-code-check/scripts/build-v2-assets.ts`. Which NUCC codes a run uses — the
 * setup's picks, else the NPI's taxonomies read at run time — is `specialtiesForRun`; v1's
 * `find-codes` still uses v1's six specialties.
 */
export function rankCandidates(
  diagnosis: Pick<Diagnosis, 'statement' | 'categories'>,
  codes: CodeTable,
  preferred: readonly string[],
  remembered: Readonly<Record<string, number>> = {},
): string[] {
  const categories = new Set(diagnosis.categories);
  const shared = sharedWords(diagnosis.statement, codes);
  return Object.keys(codes)
    .filter((code) => categories.has(code.slice(0, 3)))
    .map((code, order) => ({
      code,
      order,
      first: preferred.length > 0 && inFamily(code, preferred) ? 1 : 0,
      accepted: remembered[code] ?? 0,
      shared: shared(code),
    }))
    .sort(
      (a, b) =>
        b.first - a.first ||
        b.accepted - a.accepted ||
        b.shared - a.shared ||
        a.code.length - b.code.length ||
        a.order - b.order,
    )
    .map((entry) => entry.code);
}

/** Per NUCC code, its families: the built asset. */
export type Preferences = Readonly<Record<string, readonly string[]>>;

let loaded: Preferences | undefined;

/** `automations/icd10-code-check/assets/v2/preferences.json`'s `preferences`, read once. */
export function loadPreferences(): Preferences {
  loaded ??= (
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../assets/v2/preferences.json', import.meta.url)),
        'utf8',
      ),
    ) as { preferences: Preferences }
  ).preferences;
  return loaded;
}

/** The families of the chosen NUCC codes, in their order, each once; a code with none adds none. */
export const preferredFamilies = (
  chosen: readonly string[],
  preferences: Preferences,
): string[] => [...new Set(chosen.flatMap((code) => preferences[code] ?? []))];

/**
 * The NPI registry's taxonomies (`results[].taxonomies[]`, `code` and `primary`), the primary
 * first, each once; anything out of shape left out.
 */
export function taxonomiesOf(registry: unknown): string[] {
  const results =
    typeof registry === 'object' &&
    registry !== null &&
    Array.isArray((registry as never)['results'])
      ? ((registry as { results: unknown[] }).results ?? [])
      : [];
  const found = results.flatMap((result) => {
    const list = (result as { taxonomies?: unknown })?.taxonomies;
    return Array.isArray(list) ? list : [];
  }) as { code?: unknown; primary?: unknown }[];
  const codes = found
    .filter((t) => typeof t?.code === 'string' && /^[0-9A-Z]{10}$/u.test(t.code))
    .sort((a, b) => Number(b.primary === true) - Number(a.primary === true))
    .map((t) => t.code as string);
  return [...new Set(codes)];
}

/**
 * The specialties a run uses ("Fills your specialties when none are picked. Optional."): the
 * setup's picks when there are any, else the NPI's taxonomies read at this run; only codes the
 * dropdown holds.
 */
export function specialtiesForRun(
  picked: readonly string[],
  fromNpi: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  const chosen = picked.length > 0 ? picked : fromNpi;
  return [...new Set(chosen.filter((code) => known.has(code)))];
}
