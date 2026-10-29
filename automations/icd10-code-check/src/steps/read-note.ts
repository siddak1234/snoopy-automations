import { failed, readJsonCompletion, settle, type Step } from '@autom8x/automation-sdk';

import { MODELS } from '../models.js';
import { prompt } from '../prompts.js';
import { readingOf } from '../reading.js';

/**
 * Note read: AI reads the patient, the codes and each diagnosis, word for word (`read-note`, the
 * spec's section 4), from the file the platform sends; the container never reads it. `defineFlow`
 * asks once more on an answer off its schema and words a refusal or a cut-off answer; a second
 * miss ends the run, as section 8 says (no step holds a miss).
 */
export const readNote: Step = async (context) => {
  const { state, platform } = context;
  const specialties = Array.isArray(state.specialties) ? (state.specialties as string[]) : [];
  const asked = await settle(context, () =>
    platform.callModel(
      prompt('read-note'),
      { specialties: specialties.join(', ') },
      { models: MODELS, artifactId: String(state.file) },
    ),
  );
  if (!asked.ok) return failed(asked.sentence, asked.kind);
  const reading = readingOf(readJsonCompletion(asked.value));
  return { outcome: 'ok', summary: 'Note read', state: { ...state, reading: { ...reading } } };
};
