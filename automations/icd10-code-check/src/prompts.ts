import { fileURLToPath } from 'node:url';

import { loadPrompts, type PromptModule } from '@autom8x/automation-sdk';

/** The prompts the steps send: `prompts/*.json` beside `src/`, in the image too. */
export const prompts = loadPrompts(fileURLToPath(new URL('../prompts/', import.meta.url)));

/** A prompt by id, version 1; a missing file stops the container before it answers a probe. */
export function prompt(id: 'read-note' | 'match-codes'): PromptModule {
  const found = prompts.find((one) => one.id === id && one.version === 1);
  if (!found) throw new Error(`prompts/${id}.v1.json is missing`);
  return found;
}
