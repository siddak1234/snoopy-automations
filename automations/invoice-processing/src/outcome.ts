import type { QuickBooksRead } from '@autom8x/automation-kit/quickbooks';
import type { StepResult } from '@autom8x/automation-sdk';

/**
 * How a step ends the run: the timeline keeps what the step was doing and the reason
 * code; the run's reason is the fixed sentence, which carries nothing from the file,
 * from QuickBooks' own text or from a model.
 */
export function failedWith(what: string, reason: string, sentence: string): StepResult {
  return { outcome: 'failed', summary: `${what} (${reason})`, failureReason: sentence };
}

/** A QuickBooks read that failed, with the kit's sentence and its code or word for the timeline. */
export function quickBooksFailed(
  what: string,
  read: Extract<QuickBooksRead, { ok: false }>,
): StepResult {
  const reason = read.detail === undefined ? read.reason : `${read.reason} ${read.detail}`;
  return failedWith(what, reason, read.sentence);
}

/** Digits grouped in threes, as `184,203`, without a locale. */
export function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}
