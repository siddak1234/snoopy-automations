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

/**
 * `extract`'s instruction and answer schema (v3): every document in the file, one part at a time —
 * v2's 17 rules and 27 fields for each document, and what v3 adds: the seller's place, the time,
 * the number's label and every other reference printed, and each line's words, quantity and unit
 * price (the session's spec, B2, as the owner's AM1, AM7 and AM8 change it).
 */
export const EXTRACT_DOCUMENTS_V1: PromptModule = promptOf('extract-documents', 1);

/**
 * `verify-read`'s (v3): v2's second read of 13 fields and `uncertainFields`, for the documents the
 * instruction names by their place in the file, and the file's count of documents.
 */
export const VERIFY_DOCUMENTS_V1: PromptModule = promptOf('verify-documents', 1);

function promptOf(id: string, version: number): PromptModule {
  const found = PROMPTS.find((prompt) => prompt.id === id && prompt.version === version);
  if (!found) throw new Error(`prompts/${id}.v${version}.json is missing`);
  return found;
}
