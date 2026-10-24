import type { JsonObject } from '@autom8x/automation-sdk';

import { line, lines, type Posting } from './reading.js';
import { YEARS_NOT_SHOWN, bandOf, directionFlag } from './words.js';

/**
 * The candidate's score, cleaned from `score-candidate`'s answer
 * (`automations/candidate-reviewer/prompts/score-candidate.v1.json`): the score a whole number
 * from 0 to 100, each requirement met or missing with its kind, and the flags — "years not
 * shown" among them whenever the code found no dated role, whether or not the model listed it
 * (the spec's §4), and each text the resume printed to direct its reader. Such text earns no
 * credit: a requirement whose evidence quotes it is missing, not met.
 */

export type RequirementKind = 'must_have' | 'nice_to_have';

export interface Scoring {
  score: number;
  summary: string;
  matches: { requirement: string; kind: RequirementKind; evidence: string }[];
  gaps: { requirement: string; kind: RequirementKind }[];
  experienceFit: string;
  educationFit: string;
  certificationsFit: string;
  flags: string[];
}

const kindOf = (value: unknown): RequirementKind =>
  value === 'nice_to_have' ? 'nice_to_have' : 'must_have';

const list = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).filter(
    (each): each is Record<string, unknown> => typeof each === 'object' && each !== null,
  );

/** The score as a whole number from 0 to 100: the platform holds the model's answer to that range. */
const scoreOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : 0;

/**
 * Whether text quotes one of the resume's directions, whole or a fragment of 20 characters or
 * more, in any case and spacing: such text earns no credit.
 */
export function quotesDirection(text: string, directions: readonly string[]): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/\s+/gu, ' ').trim();
  const said = plain(text);
  return directions
    .map(plain)
    .some(
      (direction) =>
        direction !== '' &&
        (said.includes(direction) || (said.length >= 20 && direction.includes(said))),
    );
}

export function scoringOf(
  answer: JsonObject,
  years: number | null,
  directions: readonly string[],
): Scoring {
  const flags = lines(answer.flags, 200);
  const shown = flags.some((flag) => flag.toLowerCase() === YEARS_NOT_SHOWN);
  const matches = list(answer.matches)
    .map((match) => ({
      requirement: line(match.requirement),
      kind: kindOf(match.kind),
      evidence: line(match.evidence),
    }))
    .filter((match) => match.requirement !== '');
  const credited = matches.filter((match) => !quotesDirection(match.evidence, directions));
  const uncredited = matches.filter((match) => quotesDirection(match.evidence, directions));
  const added = [
    ...(years === null && !shown ? [YEARS_NOT_SHOWN] : []),
    ...directions.map(directionFlag),
  ];
  return {
    score: scoreOf(answer.score),
    summary: line(answer.summary, 200),
    matches: credited,
    gaps: [
      ...list(answer.gaps)
        .map((gap) => ({ requirement: line(gap.requirement), kind: kindOf(gap.kind) }))
        .filter((gap) => gap.requirement !== ''),
      ...uncredited.map(({ requirement, kind }) => ({ requirement, kind })),
    ],
    experienceFit: line(answer.experienceFit, 200),
    educationFit: line(answer.educationFit, 200),
    certificationsFit: line(answer.certificationsFit, 200),
    flags: [...flags, ...added.filter((flag) => !flags.includes(flag))],
  };
}

/**
 * The run's summary line (the spec's §7): the band, then how many of the posting's must-haves
 * the candidate meets — "Strong match · meets 3 of 3 must-haves" — or the band alone for a
 * posting that lists none.
 */
export function summaryLine(scoring: Scoring, posting: Posting): string {
  const band = bandOf(scoring.score);
  const total = posting.mustHaves.length;
  if (total === 0) return band;
  const met = scoring.matches.filter((match) => match.kind === 'must_have').length;
  return `${band} · meets ${Math.min(met, total)} of ${total} must-haves`;
}
