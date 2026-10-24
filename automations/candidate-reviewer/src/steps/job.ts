import type { JsonObject, Step } from '@autom8x/automation-sdk';

import { fileFromState, fileIdOf, fileLine, fileState, readFile } from '../file.js';
import { EXTRACT_POSTING, readDocument } from '../prompts.js';
import { postingOf, type Posting } from '../reading.js';
import { FAILURES, plural, stops } from '../words.js';

/**
 * The item run — a job made from its job description (the spec's §2 and §6, `items.pipeline`):
 * the file received, read once by the model, and saved as the job's reading, which every
 * candidate's run is then sent. A job description that cannot be read makes no job.
 */

/** The key the item run's input carries the job description under: the manifest's `items.file.key`. */
export const JOB_FILE_KEY = 'jobFile';

const jobReceived: Step = async ({ request, platform }) => {
  const id = fileIdOf(request.input, JOB_FILE_KEY);
  const read = id === undefined ? undefined : await readFile(platform, id);
  if (read === undefined) return stops(FAILURES.jobUnreadable);
  return {
    outcome: 'ok',
    summary: `Job description received: ${fileLine(read)}`,
    state: { file: fileState(read) },
  };
};

const readJob: Step = async ({ state, platform }) => {
  const file = fileFromState(state.file);
  if (file === undefined) return stops(FAILURES.jobUnreadable);
  const answer = await readDocument(platform, EXTRACT_POSTING, file);
  if (answer === undefined) return stops(FAILURES.jobUnreadable);
  const { readable, posting } = postingOf(answer);
  if (!readable) return stops(FAILURES.jobUnreadable);
  return {
    outcome: 'ok',
    summary: `Job read: ${counted(posting)}`,
    // The file is not kept past its read: the reading is what the job keeps.
    state: { posting: posting as unknown as JsonObject },
  };
};

const saveJob: Step = ({ state }) => {
  const posting = state.posting as Posting | undefined;
  if (posting === undefined) return Promise.resolve(stops(FAILURES.jobUnreadable));
  return Promise.resolve({ outcome: 'ok', summary: `Job saved: ${counted(posting)}` });
};

/** What a job's lines say of its reading: counts, never its words. */
export function counted(posting: Posting): string {
  const musts = plural(posting.mustHaves.length, 'must-have', 'must-haves');
  return `${musts}, ${plural(posting.niceToHaves.length, 'nice-to-have', 'nice-to-haves')}`;
}

export const JOB_STEPS: Readonly<Record<string, Step>> = {
  'job-received': jobReceived,
  'read-job': readJob,
  'save-job': saveJob,
};
