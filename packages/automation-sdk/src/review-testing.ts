import type { InvokeRequest } from './contract.js';
import type { DecisionAnswer } from './review.js';
import type { RecordingPlatform } from './testing.js';

/**
 * A person's review of the run a `RecordingPlatform` last held, as the platform answers it (the
 * platform round for ICD-10 Code Check, F2): `answers` must name every change the held result
 * offered once and nothing else — else the platform's refusal, "decisions must answer every change
 * once" — and the continuation it mints resumes the run approved, with each answer, even when every
 * change is denied. Returns the invoke that continues `request`; run it on a fresh platform.
 */
export function answerReview(
  platform: RecordingPlatform,
  request: InvokeRequest,
  answers: Readonly<Record<string, DecisionAnswer>>,
): InvokeRequest {
  const last = platform.results.at(-1)?.result;
  if (last?.outcome !== 'held') throw new Error('the run did not end held');
  const offered = (last.held.decisions ?? []).map((decision) => decision.id);
  const answered = Object.keys(answers);
  if (
    offered.length === 0 ||
    answered.length !== offered.length ||
    !offered.every((id) => answers[id] === 'accepted' || answers[id] === 'denied')
  ) {
    throw new Error('decisions must answer every change once');
  }
  return {
    ...request,
    continuation: {
      ofRunId: request.runId,
      kind: 'approval',
      stepId: last.held.stepId,
      decision: 'approved',
      decidedAt: new Date().toISOString(),
      state: last.held.state,
      decisions: offered.map((id) => ({ id, decision: answers[id] as DecisionAnswer })),
    },
  };
}
