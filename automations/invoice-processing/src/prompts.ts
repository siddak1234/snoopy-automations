import { fileURLToPath } from 'node:url';

import { loadPrompts, type PromptModule } from '@autom8x/automation-sdk';

/**
 * The prompts this automation ships: `prompts/*.json` beside `src/` and `dist/`, copied into
 * the image beside `dist/` by the Dockerfile, loaded once when the container starts and
 * registered with the runner, which sends only a registered module. Any change to a word of
 * a prompt file is a new version, a new image and new recordings (the owner's design of
 * 2026-10-10); `test/recordings.ts` refuses a recording made for another version or bytes.
 */
export const PROMPTS: readonly PromptModule[] = loadPrompts(
  fileURLToPath(new URL('../prompts/', import.meta.url)),
);

/** `extract`'s instruction and answer schema: 13 rules, 18 fields. */
export const EXTRACT_INVOICE_V1: PromptModule = promptOf('extract-invoice', 1);

function promptOf(id: string, version: number): PromptModule {
  const found = PROMPTS.find((prompt) => prompt.id === id && prompt.version === version);
  if (!found) throw new Error(`prompts/${id}.v${version}.json is missing`);
  return found;
}
