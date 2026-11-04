import { line } from './blocks-limits.js';
import type { Continuation, InvokeRequest } from './contract.js';

/**
 * A review of each change (the platform round for ICD-10 Code Check, F2, 2026-10-28): a held run
 * may offer a person a list of changes, each accepted or denied on its own, instead of one
 * Approve / Deny. The flow sends `held.decisions` (`held({ decisions })`); the person answers every
 * one; saving the review always continues the run (`decision: "approved"`, even when every change
 * is denied) with `continuation.decisions`, every offered id once. Who may answer, expiry and the
 * one pending approval per run are the platform's, unchanged. Since the platform's ADR-0048
 * amendment 5 a change may offer up to 3 `options`, values a person may pick in its place ("Other
 * code"), and its answer is then `{id, other}`, one of their values (`othersOf`).
 */

/** A value a person may pick in a change's place (amendment 5): what is saved, and what is shown. */
export interface DecisionOption {
  value: string;
  label: string;
}

/** One change a held run offers: its id (a step id's shape), a label and an optional detail. */
export interface HeldDecision {
  id: string;
  /** What the change is, one line ("N18.4 → Remove"). */
  label: string;
  /** Why, one line (the reason with its quote). */
  detail?: string;
  /**
   * The heading the clients draw the change under, one line ("Jane Doe · Oct 12, 2026"), in the
   * order sent (platform ADR-0048 amendment 3, point 3): on every change of a review or on none.
   */
  group?: string;
  /** 1 to 3 values a person may pick in its place (amendment 5), each value once. */
  options?: readonly DecisionOption[];
}

/** A held result's `held`: the step that held, its reason, its state and the changes it offers. */
export interface HeldPart {
  stepId: string;
  reason: string;
  state: Record<string, unknown>;
  decisions?: readonly HeldDecision[];
}

/**
 * A person's answer to one offered change, as `answersOf` reads it: accepted, denied, or `other` —
 * one of its options picked in its place (amendment 5), whose value `othersOf` reads.
 */
export type DecisionAnswer = 'accepted' | 'denied' | 'other';

/** One answer, as the continuation carries it back: a decision, or (amendment 5) an offered value. */
export type ContinuationDecision =
  { id: string; decision: 'accepted' | 'denied' } | { id: string; other: string };

/**
 * The platform's bounds: 1 to 400 changes, a label and a group of 120 characters, a detail of 200;
 * a change's options 1 to 3, each value and label 1 to 120 (amendment 5).
 */
export const DECISION_LIMITS = {
  decisions: 400,
  label: 120,
  detail: 200,
  group: 120,
  options: 3,
  option: 120,
} as const;

const DECISION_ID = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/u;

/**
 * The offered changes as the platform takes them: none sent when there are none; each label and
 * detail one plain line, cut whole at its bound, a detail the platform would refuse (a tag, a
 * control character) left out; a group one plain line, cut whole at its bound; an option's label
 * one plain line, cut whole at its bound, and no options sent when none are offered. What cannot be
 * fixed without changing the review — more than 400, an id out of shape or offered twice, a label
 * or a group left empty, a group on some changes and not others, more than 3 options, an option's
 * value that is not one plain line within its bound (it is what the answer names, so never cut) or
 * offered twice, an option's label left empty — is refused before anything is sent, since dropping
 * a change would ask a person to answer a different review.
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
  const grouped = decisions.filter((decision) => decision.group !== undefined).length;
  if (grouped !== 0 && grouped !== decisions.length) {
    throw new Error('held.decisions: a group goes on every change or on none');
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
    const group = line(decision.group, DECISION_LIMITS.group);
    if (decision.group !== undefined && group === undefined) {
      throw new Error(`held.decisions: ${decision.id}'s group is not one plain line`);
    }
    const options = boundedOptions(decision);
    return {
      id: decision.id,
      label,
      ...(detail === undefined ? {} : { detail }),
      ...(group === undefined ? {} : { group }),
      ...(options === undefined ? {} : { options }),
    };
  });
}

/** A change's options as the platform takes them (amendment 5), or refused: see `boundedDecisions`. */
function boundedOptions(decision: HeldDecision): DecisionOption[] | undefined {
  const options = decision.options ?? [];
  if (options.length === 0) return undefined;
  if (options.length > DECISION_LIMITS.options) {
    throw new Error(
      `held.decisions: ${decision.id} offers ${options.length} options; the platform takes 1 to ${DECISION_LIMITS.options}`,
    );
  }
  const values = new Set<string>();
  return options.map((option) => {
    if (line(option.value, DECISION_LIMITS.option) !== option.value || values.has(option.value)) {
      throw new Error(
        `held.decisions: ${decision.id}'s option ${JSON.stringify(option.value)} is not one plain line of 1 to ${DECISION_LIMITS.option}, or twice`,
      );
    }
    values.add(option.value);
    const label = line(option.label, DECISION_LIMITS.option);
    if (label === undefined) {
      throw new Error(`held.decisions: ${decision.id}'s option ${option.value} has no plain label`);
    }
    return { value: option.value, label };
  });
}

/**
 * Whether a continuation's `decisions` are answers the platform could have sent: each a string id
 * and exactly one of `decision` (accepted or denied) and `other` (1 to 120 characters).
 */
export function isContinuationDecisions(value: unknown): value is ContinuationDecision[] {
  const answer = (entry: Record<string, unknown>): boolean =>
    'other' in entry
      ? !('decision' in entry) &&
        typeof entry.other === 'string' &&
        entry.other.length >= 1 &&
        entry.other.length <= DECISION_LIMITS.option
      : entry.decision === 'accepted' || entry.decision === 'denied';
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        answer(entry as Record<string, unknown>),
    )
  );
}

/**
 * The person's answers on a continued run, by change id: empty on a first run and on an approval
 * that offered no changes. A step reads `answersOf(request).get(id) === 'accepted'`; an option
 * picked in a change's place reads `'other'`, its value `othersOf(request).get(id)`.
 */
export function answersOf(request: InvokeRequest): ReadonlyMap<string, DecisionAnswer> {
  const decisions: Continuation['decisions'] = request.continuation?.decisions;
  return new Map(
    (decisions ?? []).map((answer) => [answer.id, 'other' in answer ? 'other' : answer.decision]),
  );
}

/** The value picked in each change's place (amendment 5), by change id: none when none was. */
export function othersOf(request: InvokeRequest): ReadonlyMap<string, string> {
  const decisions: Continuation['decisions'] = request.continuation?.decisions;
  return new Map(
    (decisions ?? []).flatMap((answer) => ('other' in answer ? [[answer.id, answer.other]] : [])),
  );
}
