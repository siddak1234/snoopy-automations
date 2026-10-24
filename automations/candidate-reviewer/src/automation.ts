import {
  defineAutomation,
  type Automation,
  type InvokeRequest,
  type JsonObject,
  type Manifest,
  type RunSection,
} from '@autom8x/automation-sdk';

import { PROMPTS } from './prompts.js';
import type { Posting } from './reading.js';
import { postingSections } from './sections.js';
import { candidateSteps, type Candidate } from './steps/candidate.js';
import { JOB_STEPS, counted } from './steps/job.js';

/**
 * Candidate Reviewer (the spec: `automations/candidate-reviewer/README.md`, its words the
 * build's source of truth). A flow with items (the platform's ADR-0046): a job is made once,
 * from its job description — the item run, which reads it into the job's reading — and each
 * candidate's run reads a resume and scores it against that reading. The runner runs the
 * manifest's `items.pipeline` on the item run and its `pipeline` on every other; each step's
 * code is in `src/steps/`.
 */
export const TEMPLATE_ID = 'candidate-reviewer';

/** The one version this image serves; its Dockerfile copies only its manifest. */
export const SERVED_VERSIONS: readonly number[] = [1];

/**
 * The automation, on a clock — a current role's years run to `now`; `main.ts` and the
 * conformance test pass none, and the suite a fixed day.
 */
export function define(
  manifests: readonly Manifest[],
  now: () => Date = () => new Date(),
): Automation {
  return defineAutomation({
    templateId: TEMPLATE_ID,
    manifests,
    prompts: PROMPTS,
    steps: { ...JOB_STEPS, ...candidateSteps(now) },
    // No step declares a retry. Each model step's call is a vendor call and a ledger row when
    // repeated (the spec's §6: no); `save` makes no callback for a retry to repeat — the
    // platform keeps the candidate from the result, which the SDK sends.
    result: (state, request) =>
      request.readsItem === true ? job(state) : candidate(state, request),
  });
}

/** An item run's result: the job's reading, and the sections "What AI read" shows. */
function job(state: JsonObject) {
  const posting = state.posting as unknown as Posting;
  return {
    output: posting as unknown as JsonObject,
    summary: `Posting saved: ${counted(posting)}`,
    sections: postingSections(posting),
  };
}

/** A candidate's result: what was read and scored, whole, and the candidate as people see them. */
function candidate(state: JsonObject, request: InvokeRequest) {
  const saved = state.candidate as unknown as Candidate;
  return {
    output: {
      posting: request.item?.reading ?? null,
      resume: state.resume,
      yearsOfExperience: state.yearsOfExperience,
      scoring: state.scoring,
    },
    summary: saved.summary,
    title: saved.title,
    score: saved.score,
    sections: saved.sections as unknown as RunSection[],
  };
}
