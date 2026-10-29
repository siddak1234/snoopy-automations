import { chosenOptions, failed, settle, type Step } from '@autom8x/automation-sdk';

import { SPECIALTIES_FIELD } from '../families.js';
import { FAILURES } from '../words.js';

/**
 * Visit received: a visit note arrives. The file is the run input `visitNote` (the platform refuses
 * a required file field, so a run without one stops here, in section 8's words); the specialties
 * are the setup's picks. The file's name is never read into a line: it may carry a patient's name.
 */
export const receive: Step = async (context) => {
  const { request, platform } = context;
  const file = typeof request.input.visitNote === 'string' ? request.input.visitNote.trim() : '';
  if (file === '') return failed(FAILURES.noFile, 'no_file');
  const found = await settle(context, () => platform.readArtifact(file));
  if (!found.ok) return failed(found.sentence, found.kind);
  const specialties = chosenOptions(request.config, SPECIALTIES_FIELD);
  return { outcome: 'ok', summary: 'Visit received', state: { file, specialties } };
};
