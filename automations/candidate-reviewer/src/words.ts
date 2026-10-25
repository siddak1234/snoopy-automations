import { truncateText, type RunVerdict, type StepResult } from '@autom8x/automation-sdk';

/**
 * The words a person reads when a run stops — the spec's §8, exactly
 * (`automations/candidate-reviewer/README.md`). A refusal by the model, or a plan whose monthly
 * calls are used up, is not here: the run ends in the platform's own words for it, as the SDK
 * writes them (README, "Model calls").
 */
export const FAILURES = {
  /** A file that is not a resume: a receipt, a letter. */
  notAResume: 'This file does not look like a resume.',
  /** A resume that cannot be read: blurred, empty, a blank scan, a Word file that will not open. */
  resumeUnreadable: 'The file could not be read. Try a clearer PDF or photo.',
  /** A job description that cannot be read: the job is not made. */
  jobUnreadable: 'The job description could not be read. Try a clearer PDF or photo.',
  /**
   * A run whose job carries no reading (the spec's §8, fourth row). The platform starts a
   * candidate's run only on a job that is ready (its ADR-0046), so this answers a platform fault.
   */
  jobNotRead: "This candidate's job has not been read yet.",
} as const;

/** A step that stops the run with one of the sentences above, as its line and its reason. */
export function stops(sentence: string): StepResult {
  return { outcome: 'failed', summary: sentence, failureReason: sentence };
}

/**
 * The score's band, as the run's summary says it (the spec's §7 and §11): 80 and above a
 * strong match, 60 to 79 a good one, 40 to 59 a partial one, under 40 a weak one.
 */
export function bandOf(score: number): string {
  if (score >= 80) return 'Strong match';
  if (score >= 60) return 'Good match';
  if (score >= 40) return 'Partial match';
  return 'Weak match';
}

/**
 * The score from which a candidate's verdict is `positive`, "Advance" in the manifest's
 * `items.verdictWords`; below it, `negative`, "Decline" (the spec's §7, v2).
 */
export const ADVANCE_FROM_SCORE = 60;

/** A candidate's verdict, from the score alone: positive at `ADVANCE_FROM_SCORE` or above. */
export function verdictOf(score: number): RunVerdict {
  return score >= ADVANCE_FROM_SCORE ? 'positive' : 'negative';
}

/** The flag a resume with no dates carries (the spec's §4): it scores on what it shows. */
export const YEARS_NOT_SHOWN = 'years not shown';

/** The flag for text a resume printed to direct its reader, quoted in at most 120 characters. */
export function directionFlag(direction: string): string {
  const quoted = direction.length > 120 ? `${truncateText(direction, 119).trimEnd()}…` : direction;
  return `Text that tries to direct the reader: "${quoted}"`;
}

/** A count and its noun: "1 role", "3 roles". */
export const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** The sites a link only the file gave is named by (the spec's §7), by host. */
const SITES: Readonly<Record<string, string>> = {
  'linkedin.com': 'LinkedIn',
  'github.com': 'GitHub',
  'huggingface.co': 'Hugging Face',
};

/**
 * What names a link the file alone gave, the model having read no label for it: its site, or its
 * host without `www.` — "example.com" for `https://www.example.com/jane`.
 */
export function linkLabel(url: string): string {
  const host = URL.canParse(url) ? new URL(url).hostname.replace(/^www\./u, '') : '';
  return SITES[host] ?? host;
}
