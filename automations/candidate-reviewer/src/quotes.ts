import { quotesIn, type JsonObject } from '@autom8x/automation-sdk';

import type { FileRead } from './file.js';
import { line } from './reading.js';

/**
 * The exact words (v3, the owner's Q1, 2026-11-03): the words the model read the candidate's name,
 * email and phone from, as printed (`automations/candidate-reviewer/prompts/extract-resume.v2.json`, rule 9).
 * Only a Word resume, whose text this flow holds, is checked: a quote its text does not hold
 * (`quotesIn`, white space read as one space) is not trusted. A PDF's or a photo's words are kept
 * as the model read them. v4 (the owner's items 11 and 13, 2026-11-05) still reads and checks them
 * into the run's step state (`read-resume`), and shows them nowhere: v3 kept them only in the
 * sections it drew, so no run keeps them now (the README's v4 gap).
 */
export const QUOTED = ['name', 'email', 'phone'] as const;
export type Quoted = (typeof QUOTED)[number];
export type Quotes = Partial<Record<Quoted, string>>;

/** The most of the words a quote keeps: v3's bound, the section text's 600 less its quote line's words. */
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
