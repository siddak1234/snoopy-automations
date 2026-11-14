import {
  defineAutomation,
  reaskingOnce,
  type Automation,
  type EmittedBlock,
  type InvokeRequest,
  type JsonObject,
  type Manifest,
} from '@autom8x/automation-sdk';

import { postingBlocks } from './blocks.js';
import { PROMPTS, endsUnusable } from './prompts.js';
import type { Posting } from './reading.js';
import { candidateSteps, type Candidate } from './steps/candidate.js';
import { JOB_STEPS, counted } from './steps/job.js';

/**
 * Resume Screening, v2 to v5 of `candidate-reviewer` (the spec:
 * `automations/candidate-reviewer/README.md`, its words the build's source of truth). A flow with
 * items (the platform's ADR-0046): a job is made once, from its job description — the item run,
 * which reads it into the job's reading — and each candidate's run reads a resume and scores it
 * against that reading. The runner runs the manifest's `items.pipeline` on the item run and its
 * `pipeline` on every other; each step's code is in `src/steps/`. v2 (Round 19, build 28) is v1, Candidate Reviewer, renamed, with
 * departments A–Z and AI among them, and a verdict on each candidate's run, which its job counts;
 * the job's reading is v1's, so a job made on v1 serves v2's runs. v1's container keeps its pinned
 * image until it is retired.
 */
export const TEMPLATE_ID = 'candidate-reviewer';

/**
 * The one version this image serves; its Dockerfile copies only its manifest. v3 (Round 21, Stage 2;
 * the owner's Q1 and Q2 of 2026-11-03) is v2's manifest but for its version and its own container:
 * the resume's read gives the exact words of the name, email and phone (`quotes.ts`), and an answer
 * off its schema is asked once more, a second miss ending the run (`endsUnusable`). v4 (the owner's
 * items 11–13 on build 37, 2026-11-05) is v3's manifest but for its version and its own container:
 * each run's result is sent as blocks (`blocks.ts`) in place of sections — Contact a row per value
 * under its label, the links as logo buttons named by the username. v5 (the owner's items 1 and 4
 * on build 43, 2026-11-14) is v4's manifest but for its version, its own container and its resume
 * field required, so the platform refuses a run without a file before it starts; a run that still
 * names none stops `FAILURES.noResume`. v4's container keeps its pinned image until it is retired.
 */
export const SERVED_VERSIONS: readonly number[] = [5];

/**
 * The manifests this image serves, of those given: `SERVED_VERSIONS` alone, as Invoice
 * Processing's — so v2's code never answers a run pinned to v1, which declares no verdict words —
 * and refused when none is left.
 */
export function servedManifests(manifests: readonly Manifest[]): Manifest[] {
  const served = manifests.filter((manifest) => SERVED_VERSIONS.includes(manifest.version));
  if (served.length === 0) {
    throw new Error(
      `${TEMPLATE_ID} serves v${SERVED_VERSIONS.join(', v')}, and no such manifest was given`,
    );
  }
  return served;
}

/**
 * The automation, on a clock — a current role's years run to `now`; `main.ts` and the
 * conformance test pass none, and the suite a fixed day.
 */
export function define(
  manifests: readonly Manifest[],
  now: () => Date = () => new Date(),
): Automation {
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: servedManifests(manifests),
    prompts: PROMPTS,
    steps: endsUnusable({ ...JOB_STEPS, ...candidateSteps(now) }),
    // No step declares a retry. Each model step's call is a vendor call and a ledger row when
    // repeated (the spec's §6: no); `save` makes no callback for a retry to repeat — the
    // platform keeps the candidate from the result, which the SDK sends.
    result: (state, request) =>
      request.readsItem === true ? job(state) : candidate(state, request),
  });
  // v3 (Q2): an answer off its schema asked once more, with the fault line; one to three more paid calls.
  return {
    ...automation,
    execute: (request, platform) => automation.execute(request, reaskingOnce(platform)),
  };
}

/**
 * An item run's result: the job's reading, and the blocks "What AI read" shows (v4) — never beside
 * sections or details, which the SDK and the platform refuse.
 */
function job(state: JsonObject) {
  const posting = state.posting as unknown as Posting;
  return {
    output: posting as unknown as JsonObject,
    summary: `Job saved: ${counted(posting)}`,
    blocks: postingBlocks(posting),
  };
}

/**
 * A candidate's result: what was read and scored, whole, and the candidate as people see them —
 * with the verdict its job counts. A job's result gives none: the platform refuses one there.
 */
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
    verdict: saved.verdict,
    blocks: saved.blocks as unknown as EmittedBlock[],
  };
}
