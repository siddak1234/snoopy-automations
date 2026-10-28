import { line } from './blocks-limits.js';
import type { Continuation, InvokeRequest } from './contract.js';

/**
 * A review of each change (the platform round for ICD-10 Code Check, F2, 2026-10-28): a held run
 * may offer a person a list of changes, each accepted or denied on its own, instead of one
 * Approve / Deny. The flow sends `held.decisions` (`held({ decisions })`); the person answers every
 * one; saving the review always continues the run (`decision: "approved"`, even when every change
 * is denied) with `continuation.decisions`, every offered id once. Who may answer, expiry and the
 * one pending approval per run are the platform's, unchanged.
 */

/** One change a held run offers: its id (a step id's shape), a label and an optional detail. */
export interface HeldDecision {
  id: string;
  /** What the change is, one line ("N18.4 → Remove"). */
  label: string;
  /** Why, one line (the reason with its quote). */
  detail?: string;
}

/** A held result's `held`: the step that held, its reason, its state and the changes it offers. */
export interface HeldPart {
  stepId: string;
  reason: string;
  state: Record<string, unknown>;
  decisions?: readonly HeldDecision[];
}

/** A person's answer to one offered change. */
export type DecisionAnswer = 'accepted' | 'denied';

/** One answer, as the continuation carries it back. */
export interface ContinuationDecision {
  id: string;
  decision: DecisionAnswer;
}

/** The platform's bounds: 1 to 40 changes, a label of 120 characters, a detail of 200. */
export const DECISION_LIMITS = { decisions: 40, label: 120, detail: 200 } as const;

const DECISION_ID = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/u;

/**
 * The offered changes as the platform takes them: none sent when there are none; each label and
 * detail one plain line, cut whole at its bound, a detail the platform would refuse (a tag, a
 * control character) left out. What cannot be fixed without changing the review — more than 40,
 * an id out of shape or offered twice, a label left empty — is refused before anything is sent,
 * since dropping a change would ask a person to answer a different review.
 */
export function boundedDecisions(
  decisions: readonly HeldDecision[] | undefined,
): HeldDecision[] | undefined {
  if (decisions === undefined || decisions.length === 0) return undefined;
  if (decisions.length > DECISION_LIMITS.decisions) {
    throw new Error(
      `held.decisions offers ${decisions.length} changes; the platform takes 1 to ${DECISION_LIMITS.decisions}`,
    );
  }
  const seen = new Set<string>();
  return decisions.map((decision) => {
    if (!DECISION_ID.test(decision.id) || seen.has(decision.id)) {
      throw new Error(`held.decisions: id ${JSON.stringify(decision.id)} is out of shape or twice`);
    }
    seen.add(decision.id);
    const label = line(decision.label, DECISION_LIMITS.label);
    if (label === undefined) {
      throw new Error(`held.decisions: ${decision.id}'s label is not one plain line`);
    }
    const detail = line(decision.detail, DECISION_LIMITS.detail);
    return { id: decision.id, label, ...(detail === undefined ? {} : { detail }) };
  });
}

/** Whether a continuation's `decisions` are answers the platform could have sent. */
export function isContinuationDecisions(value: unknown): value is ContinuationDecision[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ContinuationDecision).id === 'string' &&
        ((entry as ContinuationDecision).decision === 'accepted' ||
          (entry as ContinuationDecision).decision === 'denied'),
    )
  );
}

/**
 * The person's answers on a continued run, by change id: empty on a first run and on an approval
 * that offered no changes. A step reads `answersOf(request).get(id) === 'accepted'`.
 */
export function answersOf(request: InvokeRequest): ReadonlyMap<string, DecisionAnswer> {
  const decisions: Continuation['decisions'] = request.continuation?.decisions;
  return new Map((decisions ?? []).map((answer) => [answer.id, answer.decision]));
}
