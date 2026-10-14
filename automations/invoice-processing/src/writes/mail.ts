import { cleanText } from '@autom8x/automation-kit/values';
import {
  MAIL_BODY_MAX_LENGTH,
  MAIL_SUBJECT_MAX_LENGTH,
  truncateText,
  type RunDetail,
} from '@autom8x/automation-sdk';

import { nameWords } from '../words.js';

/**
 * notify's mail (v2's §3.F): plain text — a subject, a first line saying what Invoice Processing
 * did, then the run's details as `Label: value` lines, and nothing else. Built from the run's
 * result alone — never the model's answer, a line item, the file or a link — and no timestamp, so
 * the same run and key always give the same words, which the platform turns into one mail however
 * often the step runs.
 */

export interface Mail {
  readonly subject: string;
  readonly body: string;
}

/** A value on one line: line breaks and control characters made spaces, trimmed. */
const value = (text: string) => cleanText(text) ?? '';

/** What the mail is about, by the result's kind. */
export type MailKind =
  | {
      readonly kind: 'recorded';
      readonly noun: string;
      readonly vendor: string;
      readonly total: string;
    }
  | { readonly kind: 'saved'; readonly seller: string; readonly total: string | null }
  | { readonly kind: 'compared'; readonly vendor: string };

/** The subject (§3.F), one line. */
function subjectOf(about: MailKind): string {
  switch (about.kind) {
    case 'recorded':
      return `Recorded in QuickBooks: ${about.noun} from ${nameWords(value(about.vendor))}, ${about.total}`;
    case 'saved':
      return `Saved: ${nameWords(value(about.seller))}${about.total === null ? '' : `, ${about.total}`}`;
    case 'compared':
      return `Statement from ${nameWords(value(about.vendor))} compared`;
  }
}

/** The body's first line (§3.F). */
const FIRST_LINES: Readonly<Record<MailKind['kind'], string>> = {
  recorded: 'Invoice Processing recorded this in QuickBooks.',
  saved: 'Invoice Processing saved these details.',
  compared: 'Invoice Processing compared this statement with QuickBooks.',
};

/** The mail for a run's result: its subject, its first line, its details. */
export function mailOf(about: MailKind, details: readonly RunDetail[]): Mail {
  const lines = [
    FIRST_LINES[about.kind],
    '',
    ...details.map((line) => `${value(line.label)}: ${value(line.value)}`),
  ];
  return {
    subject: truncateText(subjectOf(about), MAIL_SUBJECT_MAX_LENGTH),
    body: truncateText(lines.join('\n'), MAIL_BODY_MAX_LENGTH),
  };
}
