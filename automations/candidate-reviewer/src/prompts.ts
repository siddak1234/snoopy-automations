import { fileURLToPath } from 'node:url';

import {
  ModelRefusedError,
  loadPrompts,
  readJsonCompletion,
  type JsonObject,
  type ModelRefusalReason,
  type PromptModule,
  type StepPlatform,
} from '@autom8x/automation-sdk';

import type { FileRead } from './file.js';

/**
 * The prompts this flow ships (the spec's §4): `prompts/*.json` beside `src/` and `dist/`, copied
 * into the image by the Dockerfile and registered with the runner, which sends only a registered
 * module. Each names its capability, never a model; both are in the manifest's
 * `requiredCapabilities`.
 */
export const PROMPTS: readonly PromptModule[] = loadPrompts(
  fileURLToPath(new URL('../prompts/', import.meta.url)),
);

/** The job description's reading (document-extraction): the file, or a Word file's text. */
export const EXTRACT_POSTING: PromptModule = promptOf('extract-posting', 1);
/** The resume's reading (document-extraction): the file, or a Word file's text. */
export const EXTRACT_RESUME: PromptModule = promptOf('extract-resume', 1);
/** The candidate's score against the job's reading (screening): text only, no file. */
export const SCORE_CANDIDATE: PromptModule = promptOf('score-candidate', 1);

function promptOf(id: string, version: number): PromptModule {
  const found = PROMPTS.find((prompt) => prompt.id === id && prompt.version === version);
  if (!found) throw new Error(`prompts/${id}.v${version}.json is missing`);
  return found;
}

/**
 * The models every call asks for — Invoice Processing's: the primary, then a fallback by another
 * maker; on 2026-10-10 both had a US zero-retention endpoint taking the call's parameters within
 * the price ceiling, and both read PDFs and images (README, "Pick a model"). The owner's setting
 * on the platform wins over them.
 */
export const MODELS: readonly string[] = [
  'anthropic/claude-haiku-4.5',
  'google/gemini-3.1-flash-lite',
];

/**
 * The refusals that say the FILE cannot be read — a type no model takes, too large, not what it
 * claims to be, password-protected, or unlike the file the store measured: the spec's "could not
 * be read", nothing spent. Any other refusal — the model's, or a plan's calls used up — ends the
 * run in the platform's own words (the spec's §8), so it is thrown on.
 */
const FILE_REFUSALS: ReadonlySet<ModelRefusalReason> = new Set([
  'content_type_not_accepted',
  'file_too_large',
  'file_content_mismatch',
  'file_encrypted',
  'file_integrity',
]);

/**
 * Reads a document — the file, or a Word file's text — with a reading prompt: its answer, or
 * `undefined` when the platform refused the file as unreadable.
 */
export async function readDocument(
  platform: StepPlatform,
  prompt: PromptModule,
  read: FileRead,
): Promise<JsonObject | undefined> {
  try {
    const completion =
      read.kind === 'file'
        ? await platform.callModel(
            prompt,
            { source: 'file' },
            { models: MODELS, artifactId: read.artifactId },
          )
        : await platform.callModel(prompt, { source: 'word', text: read.text }, MODELS);
    return readJsonCompletion(completion);
  } catch (error) {
    if (error instanceof ModelRefusedError && FILE_REFUSALS.has(error.reason)) return undefined;
    throw error;
  }
}
