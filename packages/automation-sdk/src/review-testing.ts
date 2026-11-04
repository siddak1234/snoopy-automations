import type { InvokeRequest } from './contract.js';
import type { ContinuationDecision } from './review.js';
import type { RecordingPlatform } from './testing.js';

/** A person's answer in a suite: a decision, or (amendment 5) one of the change's offered values. */
export type ReviewAnswer = 'accepted' | 'denied' | { other: string };

/**
 * A person's review of the run a `RecordingPlatform` last held, as the platform answers it (the
 * platform round for ICD-10 Code Check, F2): `answers` must name every change the held result
 * offered once and nothing else — else the platform's refusal, "decisions must answer every change
 * once" — and an `other` must be one of its change's offered values — else "decisions[i].other must
 * be one of its change's options" (amendment 5) — and the continuation it mints resumes the run
 * approved, with each answer, even when every change is denied. Returns the invoke that continues
 * `request`; run it on a fresh platform.
 */
export function answerReview(
  platform: RecordingPlatform,
  request: InvokeRequest,
  answers: Readonly<Record<string, ReviewAnswer>>,
): InvokeRequest {
  const last = platform.results.at(-1)?.result;
  if (last?.outcome !== 'held') throw new Error('the run did not end held');
  const changes = last.held.decisions ?? [];
  const offered = changes.map((decision) => decision.id);
  const answered = Object.keys(answers);
  if (
    offered.length === 0 ||
    answered.length !== offered.length ||
    !offered.every(
      (id) =>
        answers[id] === 'accepted' ||
        answers[id] === 'denied' ||
        typeof (answers[id] as { other?: unknown } | undefined)?.other === 'string',
    )
  ) {
    throw new Error('decisions must answer every change once');
  }
  const decisions = offered.map((id, at): ContinuationDecision => {
    const answer = answers[id]!;
    if (typeof answer === 'string') return { id, decision: answer };
    const options = changes[at]!.options ?? [];
    if (!options.some((option) => option.value === answer.other)) {
      throw new Error(`decisions[${at}].other must be one of its change's options`);
    }
    return { id, other: answer.other };
  });
  return {
    ...request,
    continuation: {
      ofRunId: request.runId,
      kind: 'approval',
      stepId: last.held.stepId,
      decision: 'approved',
      decidedAt: new Date().toISOString(),
      state: last.held.state,
      decisions,
    },
  };
}
