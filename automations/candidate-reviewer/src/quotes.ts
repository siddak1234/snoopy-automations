import { quotesIn, type JsonObject } from '@autom8x/automation-sdk';

import type { FileRead } from './file.js';
import { line } from './reading.js';

/**
 * v3's exact words (the owner's Q1, 2026-11-03): the words the model read the candidate's name,
 * email and phone from, as printed (`automations/candidate-reviewer/prompts/extract-resume.v2.json`, rule 9), each shown under its
 * value in Contact (`candidateSections`). Only a Word resume, whose text this flow holds, is
 * checked: a quote its text does not hold (`quotesIn`, white space read as one space) is not
 * trusted, and its value is shown with no quote line. A PDF's or a photo's words are shown as the
 * model read them, for a person to check against the file.
 */
export const QUOTED = ['name', 'email', 'phone'] as const;
export type Quoted = (typeof QUOTED)[number];
export type Quotes = Partial<Record<Quoted, string>>;

/** The most of the words a quote line keeps: the section text's 600, less `quoteLine`'s own words. */
const QUOTE_LENGTH = 580;

/** The exact words an answer gave, each one line within the bound; an empty one left out. */
export function quotesOf(answer: JsonObject): Quotes {
  const given = answer.quotes;
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return {};
  const words = given as Record<string, unknown>;
  return Object.fromEntries(
    QUOTED.map((name) => [name, line(words[name], QUOTE_LENGTH)] as const).filter(
      ([, quote]) => quote !== '',
    ),
  );
}

/** The quotes to show: on a Word resume only those its text holds; on a PDF or photo, all. */
export function trusted(quotes: Quotes, file: FileRead): Quotes {
  if (file.kind !== 'text') return quotes;
  const missing = new Set(quotesIn(file.text, quotes));
  return Object.fromEntries(Object.entries(quotes).filter(([name]) => !missing.has(name)));
}

/** The quotes a state kept, read back: only text, only the three. */
export function quotesFrom(value: unknown): Quotes {
  return typeof value === 'object' && value !== null
    ? quotesOf({ quotes: value as JsonObject })
    : {};
}

/** A value's exact words, under it in Contact. */
export const quoteLine = (words: string): string => `Exact words: "${words}"`;
