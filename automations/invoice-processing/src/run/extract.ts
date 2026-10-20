import {
  CallbackRefusedError,
  DEFAULT_MODEL_TIMEOUT_MS,
  ModelRefusedError,
  isUnsent,
  modelAuthor,
  readJsonCompletion,
  type InvokeRequest,
  type JsonObject,
  type ModelCompletion,
  type PromptModule,
  type Step,
} from '@autom8x/automation-sdk';

import { partAnswerOf, v2AnswerOf, type DocumentAnswer, type PartAnswer } from './answer.js';
import { documentReadOf, joinedAnswer } from './document-read.js';
import { MODELS, extractFailed, extractRefused } from './model-refusals.js';
import { KIND_OF, artifactIdOf, type Entry } from './state.js';
import { DOUBTS, readLine } from './words.js';

/**
 * `extract` (v3) — the platform's model reads EVERY document in the file, each its own entry with
 * its own seller and its own details (the owner, ~04:05Z: "it was 3 receipts in one picture. that
 * should work … we should get a json out that clearly seperates accordingly"), with no limit on
 * how many (AM1). One model call reads a part: at most `PART_SIZES[0]` documents and lines, so an
 * answer never passes the platform's answer cap (8,000 tokens, snoopy-backend
 * `snoopy-backend/packages/config/src/index.ts:243`) and cuts a document off; the answer says where the next part
 * starts, and the next call starts there — a long receipt goes on from its next line. A clean file
 * of a few receipts is ONE call. A part the platform says was cut at its answer cap is asked again,
 * smaller (`PART_SIZES`), never skipped.
 *
 * The parts read so far are kept for the run, so the runner's repeat of a call that never reached
 * the platform starts at the part it was reading, not the first. A part that does not move the
 * reading on ends the reading with what was read, the last document's lines marked incomplete
 * when it stopped inside it. Nothing is left out silently (the owner's AM6): a part that says the
 * file is done while it counts more documents than were read is followed by one from the next
 * document; when the reading still ends short of that count, the last document read waits for a
 * person, "the file may hold more documents" (the session's choice S44).
 * Refusals end the run as v2's first read did (`model-refusals.ts`); a file with nothing in it,
 * with "No bill or receipt found. Try a clearer photo." (B1).
 */

/** The fixed task: nothing a person typed and nothing read from the document is in it. */
export const EXTRACT_TASK = 'Extract the documents in the attached file.';

/**
 * How much one part asks for, largest first: 5 documents and 80 lines fit the answer cap at about
 * 400 tokens a document and 30 a line (≈ 4,400 tokens, the session's choice); each smaller size is
 * asked only after the platform says a part at the larger was cut at the cap.
 */
export const PART_SIZES = [
  { documents: 5, lines: 80 },
  { documents: 2, lines: 30 },
  { documents: 1, lines: 10 },
] as const;

/** Where a part starts: a document by its place in reading order, and its first line not yet read. */
export interface Cursor {
  readonly document: number;
  readonly line: number;
}

/**
 * The reading so far: the documents read, where it goes on (null once done), the part size, the
 * models, and the most documents any part counted in the whole file.
 */
interface Reading {
  documents: DocumentAnswer[];
  cursor: Cursor | null;
  size: number;
  models: string[];
  counted: number;
}

/** Each run's reading, kept across the runner's repeats of the step (keyed by its request). */
const readings = new WeakMap<InvokeRequest, Reading>();

/** One part's input: the task, where the part starts and how much it may list. */
export function partInput(cursor: Cursor, size: number): JsonObject {
  const { documents, lines } = PART_SIZES[size] ?? PART_SIZES[0];
  return {
    task: EXTRACT_TASK,
    fromDocument: cursor.document,
    fromLine: cursor.line,
    maximumDocuments: documents,
    maximumLines: lines,
  };
}

/**
 * The documents with one part's added — a document the part continues gets its next lines — and
 * where the reading goes on: null when it is done, or when the part does not move it on, which ends
 * it — with the last document's lines, and a statement's rows, incomplete when it stopped inside
 * that document. A part that says the file is done while counting more documents than are read
 * goes on with the next document, once: a part after it that adds none does not move the reading.
 */
export function withPart(
  read: readonly DocumentAnswer[],
  part: PartAnswer,
  from: Cursor,
): { readonly documents: DocumentAnswer[]; readonly next: Cursor | null } {
  const documents = [...read];
  const entries = [...part.documents];
  const continued = from.line > 1 && documents.length === from.document;
  if (continued && entries.length > 0) {
    documents[documents.length - 1] = joinedAnswer(documents.at(-1)!, entries.shift()!);
  }
  documents.push(...entries);
  const last = documents.at(-1);
  const counted = part.documentCount > documents.length;
  // The next part goes on with the last document listed, from its next line, or starts the next —
  // also when the part says it is done while the file it counts holds more.
  const next: Cursor | null =
    part.nextDocument === null
      ? counted
        ? { document: documents.length + 1, line: 1 }
        : null
      : part.nextDocument === documents.length && last !== undefined
        ? { document: documents.length, line: last.lineItems.length + 1 }
        : part.nextDocument === documents.length + 1
          ? { document: documents.length + 1, line: 1 }
          : null;
  if (part.nextDocument === null && !counted) return { documents, next: null };
  const moved =
    next !== null &&
    (next.document > from.document || (next.document === from.document && next.line > from.line));
  if (moved) return { documents, next };
  // Stopped inside the last document, or pointed nowhere: its lines may be cut.
  const inside = next === null || next.document === documents.length;
  if (inside && last !== undefined) {
    documents[documents.length - 1] = {
      ...last,
      lineItemsComplete: false,
      listedItemsComplete: false,
    };
  }
  return { documents, next: null };
}

/**
 * One entry per document read, in reading order, each read cleaned once for the result. When the
 * file was counted to hold more documents than were read, the last one read that is not a
 * statement — a statement compared with QuickBooks never waits (v2) — waits: "the file may hold
 * more documents".
 */
function entriesOf(documents: readonly DocumentAnswer[], counted = 0): Entry[] {
  const entries: Entry[] = documents.map((answer, at) => {
    const kind = KIND_OF[answer.documentType];
    return {
      index: at + 1,
      kind,
      read: documentReadOf(answer),
      ...(kind === 'record' || kind === 'statement' ? { answer: v2AnswerOf(answer) } : {}),
      doubts: [],
      engine: {},
      stage: 'read',
    };
  });
  if (counted <= entries.length || entries.length === 0) return entries;
  let at = entries.length - 1;
  while (at > 0 && entries[at]!.kind === 'statement') at -= 1;
  if (entries[at]!.kind === 'statement') at = entries.length - 1;
  entries[at] = { ...entries[at]!, doubts: [DOUBTS.more_in_file] };
  return entries;
}

export function extract(prompt: PromptModule): Step {
  return async ({ request, state, platform }) => {
    const artifactId = artifactIdOf(state);
    if (artifactId === undefined) return extractFailed('platform_fault');
    const reading = readings.get(request) ?? {
      documents: [],
      cursor: { document: 1, line: 1 },
      size: 0,
      models: [],
      counted: 0,
    };
    readings.set(request, reading);
    while (reading.cursor !== null) {
      // Not a call whose answer could not be reported before the deadline: past it the platform
      // refuses every callback. A deadline that does not parse goes on, for the platform to hold.
      if (Date.parse(request.deadline) - Date.now() < DEFAULT_MODEL_TIMEOUT_MS) {
        return extractFailed('out_of_time');
      }
      let completion: ModelCompletion;
      try {
        completion = await platform.callModel(prompt, partInput(reading.cursor, reading.size), {
          models: MODELS,
          artifactId,
        });
      } catch (error) {
        if (!(error instanceof CallbackRefusedError) || isUnsent(error)) throw error;
        // Cut at the answer cap: the same part again, asking for less.
        if (
          error instanceof ModelRefusedError &&
          error.reason === 'truncated' &&
          reading.size < PART_SIZES.length - 1
        ) {
          reading.size += 1;
          continue;
        }
        return extractRefused(error);
      }
      let part: PartAnswer | undefined;
      try {
        part = partAnswerOf(readJsonCompletion(completion));
      } catch {
        part = undefined;
      }
      if (!part) return extractFailed('answer_unusable');
      reading.models.push(completion.model);
      reading.counted = Math.max(reading.counted, part.documentCount);
      const { documents, next } = withPart(reading.documents, part, reading.cursor);
      reading.documents = documents;
      reading.cursor = next;
    }
    if (reading.documents.length === 0) return extractFailed('none_found');
    return {
      outcome: 'ok',
      summary: readLine(reading.documents),
      state: done(state, reading),
    };
  };
}

/** The state the reading leaves: the documents, and the models that read them. */
function done(state: JsonObject, reading: Reading): JsonObject {
  const makers = [
    ...new Set(reading.models.map((model) => modelAuthor(model)).filter((maker) => !!maker)),
  ];
  return {
    ...state,
    // The model that read the first part, as v2's saved data names the first read's.
    modelServed: reading.models[0] ?? '',
    // Every maker that read a part: the second read is by another (`verify.ts`).
    readMakers: makers as string[],
    documents: entriesOf(reading.documents, reading.counted) as unknown as JsonObject[],
  };
}
