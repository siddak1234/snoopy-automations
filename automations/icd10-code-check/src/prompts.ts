import { fileURLToPath } from 'node:url';

import { loadPrompts, type PromptModule } from '@autom8x/automation-sdk';

/** The prompts the steps send: `prompts/*.json` beside `src/`, in the image too. */
export const prompts = loadPrompts(fileURLToPath(new URL('../prompts/', import.meta.url)));

/**
 * A prompt by id and version: v1's steps send version 1, v2's version 2. A missing file stops the
 * container before it answers a probe.
 */
export function prompt(
  id: 'read-note' | 'match-codes' | 'categorize-pages',
  version: 1 | 2 = 1,
): PromptModule {
  const found = prompts.find((one) => one.id === id && one.version === version);
  if (!found) throw new Error(`prompts/${id}.v${version}.json is missing`);
  return found;
}
