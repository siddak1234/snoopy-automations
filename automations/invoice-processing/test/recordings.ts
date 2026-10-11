import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  isObject,
  renderPrompt,
  type JsonObject,
  type PromptModule,
} from '@autom8x/automation-sdk';

import { EXTRACT_DOCUMENT_V1, VERIFY_DOCUMENT_V1 } from '../src/prompts.js';
import { EXTRACT_INPUT } from '../src/steps/extract.js';
import { VERIFY_INPUT } from '../src/steps/verify-read.js';
import type { Sample } from './sample-maker/catalog.js';
import { SAMPLES, samplePath, sha256 } from './sample-maker/samples.js';

/**
 * The recordings: for each made-up sample, the answer of an agent that acted as the model —
 * given exactly the prompt's instruction, the fixed user text, the schema and the file, and
 * nothing else (`scripts/recording-request.ts` prints what) — saved verbatim, each read in its
 * own directory: read 1 (`extract`) as `test/recordings/extract-document.v1/<sample>.json`, read 2
 * (`verify-read`) as `test/recordings/verify-document.v1/<sample>.json`. Each sample is recorded
 * twice, by separate agents blind to each other, as the two reads are blind to each other.
 *
 * A recording names what it was made for, and the loader refuses one made for anything else:
 * another prompt id or version, other bytes of the prompt file (a word changed without a new
 * version), or other bytes of the sample. Such a recording is made again, never edited.
 */

/** One of the two reads a sample is recorded for: its prompt, its fixed input, its directory. */
export interface Read {
  readonly name: 'read 1' | 'read 2';
  readonly prompt: PromptModule;
  readonly input: JsonObject;
  /** The prompt's file. */
  readonly promptFile: string;
  /** Where its recordings are kept. */
  readonly directory: string;
}

function readOf(name: Read['name'], prompt: PromptModule, input: JsonObject): Read {
  const versioned = `${prompt.id}.v${prompt.version}`;
  return {
    name,
    prompt,
    input,
    promptFile: resolve(import.meta.dirname, '..', 'prompts', `${versioned}.json`),
    directory: resolve(import.meta.dirname, 'recordings', versioned),
  };
}

/** `extract`'s read: extract-document v1. */
export const FIRST_READ: Read = readOf('read 1', EXTRACT_DOCUMENT_V1, EXTRACT_INPUT);
/** `verify-read`'s: verify-document v1, blind to the first. */
export const SECOND_READ: Read = readOf('read 2', VERIFY_DOCUMENT_V1, VERIFY_INPUT);
export const READS: readonly Read[] = [FIRST_READ, SECOND_READ];

export const PROMPT_ID = FIRST_READ.prompt.id;
export const PROMPT_VERSION = FIRST_READ.prompt.version;
export const PROMPT_FILE = FIRST_READ.promptFile;
export const RECORDINGS_DIRECTORY = FIRST_READ.directory;

export interface Recording {
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptSha256: string;
  readonly fileSha256: string;
  /** Who made it, and when: an agent's model and the date. */
  readonly recordedBy: string;
  readonly finishReason: 'stop' | 'length' | 'content_filter' | 'other';
  /** The answer, verbatim. */
  readonly text: string;
}

/** What a recording of `sample` must have been made for, today. */
export interface MadeFor {
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptSha256: string;
  readonly fileSha256: string;
}

export function madeFor(sample: Sample, read: Read = FIRST_READ): MadeFor {
  return {
    promptId: read.prompt.id,
    promptVersion: read.prompt.version,
    promptSha256: sha256(readFileSync(read.promptFile)),
    fileSha256: sha256(readFileSync(samplePath(sample))),
  };
}

const KEYS = [
  'fileSha256',
  'finishReason',
  'promptId',
  'promptSha256',
  'promptVersion',
  'recordedBy',
  'text',
];
const FINISH_REASONS: readonly unknown[] = ['stop', 'length', 'content_filter', 'other'];

/** `value` as a recording made for `expected`, or an error naming what is wrong — never the answer. */
export function readRecording(value: unknown, expected: MadeFor, label: string): Recording {
  if (!isObject(value)) throw new Error(`${label} is not a recording`);
  const keys = Object.keys(value).sort();
  if (keys.join() !== KEYS.join()) {
    throw new Error(`${label} must have exactly ${KEYS.join(', ')}`);
  }
  for (const key of ['promptId', 'promptVersion', 'promptSha256', 'fileSha256'] as const) {
    if (value[key] !== expected[key]) {
      throw new Error(`${label} was made for another ${key}: make it again for this one`);
    }
  }
  if (typeof value.recordedBy !== 'string' || value.recordedBy.trim() === '') {
    throw new Error(`${label} must say who recorded it`);
  }
  if (!FINISH_REASONS.includes(value.finishReason)) {
    throw new Error(`${label} has no finish reason the platform reports`);
  }
  if (typeof value.text !== 'string') throw new Error(`${label} must hold the answer as text`);
  return value as unknown as Recording;
}

/** The recording of `sample` for `read`, refused unless it was made for it; undefined when none was made. */
export function recordingOf(sample: Sample, read: Read = FIRST_READ): Recording | undefined {
  const path = join(read.directory, `${sample.name}.json`);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not JSON`);
  }
  return readRecording(parsed, madeFor(sample, read), path);
}

/** The recording files there are for `read`, read for nothing but their names. */
export function recordingFiles(read: Read = FIRST_READ): string[] {
  return existsSync(read.directory)
    ? readdirSync(read.directory).filter((file) => file.endsWith('.json'))
    : [];
}

/** Every recording there is for `read`, each refused unless made for its sample; a file naming no sample is refused too. */
export function recordings(read: Read = FIRST_READ): { sample: Sample; recording: Recording }[] {
  for (const file of recordingFiles(read)) {
    if (!SAMPLES.some((sample) => `${sample.name}.json` === file)) {
      throw new Error(`${file} records no sample: name it after one in test/samples/`);
    }
  }
  return SAMPLES.flatMap((sample) => {
    const recording = recordingOf(sample, read);
    return recording ? [{ sample, recording }] : [];
  });
}

const REPOSITORY = resolve(import.meta.dirname, '..', '..', '..');

/** What an agent acting as the model is given for one sample, and where its answer goes. */
export interface RecordingRequest {
  readonly sample: string;
  /** From the repository's root. */
  readonly file: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** The prompt's template: the system message the platform sends. */
  readonly systemInstruction: string;
  /** The step's input as JSON text: the user message the file is attached to. */
  readonly userText: string;
  /** The schema the platform holds the answer to. */
  readonly responseSchema: JsonObject;
  readonly answerWith: string;
  /** From the repository's root. */
  readonly saveAs: string;
  /** The recording to save, the answer still to be put in `text`. */
  readonly recording: Recording;
}

/** Exactly what the platform sends the model for `sample` on `read` (`renderPrompt`, the step's input). */
export function recordingRequest(sample: Sample, read: Read = FIRST_READ): RecordingRequest {
  const rendered = renderPrompt(read.prompt, read.input);
  return {
    sample: sample.name,
    file: relative(REPOSITORY, samplePath(sample)),
    contentType: sample.contentType,
    sizeBytes: readFileSync(samplePath(sample)).length,
    systemInstruction: rendered.prompt,
    userText: JSON.stringify(rendered.input),
    responseSchema: rendered.outputSchema,
    answerWith: 'the JSON object alone: no other text and no code fences',
    saveAs: relative(REPOSITORY, join(read.directory, `${sample.name}.json`)),
    recording: {
      ...madeFor(sample, read),
      recordedBy: '<your model id> acting as the model, <date>',
      finishReason: 'stop',
      text: '<your answer, verbatim, as one JSON string>',
    },
  };
}
