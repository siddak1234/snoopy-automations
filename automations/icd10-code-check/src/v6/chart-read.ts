import {
  failed,
  isObject,
  settle,
  type JsonObject,
  type Step,
  type StepContext,
} from '@autom8x/automation-sdk';

import { bundleOf, resourcesOf } from './fhir.js';
import { NOTES_READ, binaryIdOf, decoded, noteText, pickAttachment } from './note-text.js';
import { EHR, SKIPPED, byPath, ehrChosen, hookVisit } from './paths.js';
import { WORDS_V6 } from './words.js';

/**
 * Notes read from your EHR (README, "v6", row 3): on a hook run, the visit's notes — `notes.search`
 * by its patient and its encounter (Epic's sandbox lists both among DocumentReference's search
 * parameters), each `current` note's text from its attachment, inline or `binary.read` of its
 * `Binary/{id}` — at most `NOTES_READ`. A note in another status, with no text attachment, or
 * whose content the EHR refuses is skipped, its reason kept (`notesRead`), never its words; the
 * search refused, or the EHR not answering, fails the run in `settle`'s words (no card). No visit
 * named or the EHR not picked: no call, no note. An upload skips the step.
 */

/** What a hook run read: the notes found, those read, each skipped one's reason, those cut short. */
export interface NotesRead {
  found: number;
  read: number;
  skipped: string[];
  cut: number;
}

/** The text of one note, or why it is skipped: its inline data, else its Binary read. */
async function textOf(
  context: StepContext,
  note: JsonObject,
  at: number,
): Promise<
  { text: string; cut: boolean } | { skip: string } | { stop: { sentence: string; kind: string } }
> {
  const attachment = pickAttachment(note);
  if ('skip' in attachment) return { skip: attachment.skip as string };
  if (typeof attachment.data === 'string') {
    return noteText(attachment.contentType, decoded(attachment.data, attachment.contentType));
  }
  const binaryId = binaryIdOf(attachment.url);
  if (binaryId === undefined) return { skip: 'no attachment address' };
  const read = await settle(context, () =>
    context.platform.callProvider(
      { providerId: EHR, operation: 'binary.read', input: { binaryId } },
      { part: `b${at}` },
    ),
  );
  // The EHR's own refusal of one note's content skips that note; anything else stops the run.
  if (!read.ok && read.kind === 'vendor_refused') return { skip: 'not read: refused' };
  if (!read.ok) return { stop: { sentence: read.sentence, kind: read.kind } };
  const body = read.value.body;
  if (!isObject(body) || typeof body.data !== 'string') return { skip: 'not read: no content' };
  const type = typeof body.contentType === 'string' ? body.contentType : attachment.contentType;
  return noteText(type, decoded(body.data, type));
}

/** A DocumentReference's other statuses (FHIR R4): a skipped note's reason names one, or "other". */
const STATUSES = ['superseded', 'entered-in-error'];

const none = (state: JsonObject, found = 0, skipped: string[] = []) => ({
  outcome: 'ok' as const,
  summary: WORDS_V6.notesRead(0, skipped.length),
  state: { ...state, notes: [], notesRead: { found, read: 0, skipped, cut: 0 } },
});

export const readChart: Step = byPath(SKIPPED, async (context) => {
  const { request, state, platform } = context;
  const visit = hookVisit(request);
  if (visit === undefined || !ehrChosen(request.config)) return none(state);
  const searched = await settle(context, () =>
    platform.callProvider(
      {
        providerId: EHR,
        operation: 'notes.search',
        input: { patient: visit.patientId, encounter: visit.encounterId },
      },
      { part: 'notes' },
    ),
  );
  if (!searched.ok) return failed(searched.sentence, searched.kind);
  const bundle = bundleOf(searched.value.body);
  if (bundle === undefined) return failed(WORDS_V6.notesNotRead, 'not_a_bundle');
  const notes = resourcesOf(bundle, 'DocumentReference');
  const texts: string[] = [];
  const skipped: string[] = [];
  let cut = 0;
  for (const [at, note] of notes.entries()) {
    if (note.status !== 'current') {
      skipped.push(`status ${STATUSES.includes(note.status as string) ? note.status : 'other'}`);
      continue;
    }
    if (texts.length >= NOTES_READ) {
      skipped.push(`over ${NOTES_READ} notes`);
      continue;
    }
    const got = await textOf(context, note, at);
    if ('stop' in got) return failed(got.stop.sentence, got.stop.kind);
    if ('skip' in got) skipped.push(got.skip);
    else {
      texts.push(got.text);
      if (got.cut) cut += 1;
    }
  }
  if (texts.length === 0) return none(state, notes.length, skipped);
  const notesRead: NotesRead = { found: notes.length, read: texts.length, skipped, cut };
  return {
    outcome: 'ok',
    summary: WORDS_V6.notesRead(texts.length, skipped.length),
    state: { ...state, notes: texts, notesRead: { ...notesRead } },
  };
});
