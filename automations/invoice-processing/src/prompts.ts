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

/** `extract`'s instruction and answer schema: 17 rules, 27 fields (the owner's plan of 2026-10-11, §4). */
export const EXTRACT_DOCUMENT_V1: PromptModule = promptOf('extract-document', 1);

/**
 * `verify-read`'s: read 1's own definitions for the 13 fields it re-reads — its rules 1–9, 12–15
 * and 17, with what names a field it does not ask for left out — and `uncertainFields`, 14 fields
 * of which 8 may be empty (the plan's §4, verify-read).
 */
export const VERIFY_DOCUMENT_V1: PromptModule = promptOf('verify-document', 1);

function promptOf(id: string, version: number): PromptModule {
  const found = PROMPTS.find((prompt) => prompt.id === id && prompt.version === version);
  if (!found) throw new Error(`prompts/${id}.v${version}.json is missing`);
  return found;
}
