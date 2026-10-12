import type { JsonObject } from '@autom8x/automation-sdk';

import { callsOf, lines, setUp } from './fixtures.js';

/** The run as `find-accounts` sees it: its line, what it sent, and how the run ended. */

/**
 * The IN text `find-accounts` sends for `names`, each as written here (already escaped) and in the
 * form QuickBooks gives an inactive account, "<name> (deleted)"; two rows a value.
 */
export const query = (names: string[], max = names.length * 4) =>
  `SELECT * FROM Account WHERE FullyQualifiedName IN (${names.map((name) => `'${name}', '${name} (deleted)'`).join(', ')}) AND Active IN (true, false) MAXRESULTS ${max}`;

export async function find(
  config: JsonObject,
  edit: (world: ReturnType<typeof setUp>) => void = () => undefined,
) {
  const world = setUp({ config });
  edit(world);
  const result = await world.run();
  const line = lines(world.platform).find(([stepId]) => stepId === 'find-accounts');
  const sent = callsOf(world.platform, world.request, 'find-accounts');
  return { ...world, result, line, sent };
}

export const failed = (failureReason: string) => ({ outcome: 'failed', failureReason });

/** A config holding only the default category, or none when `undefined`. */
export const only = (setting: unknown): JsonObject =>
  setting === undefined ? {} : { expenseAccount: setting as string };
