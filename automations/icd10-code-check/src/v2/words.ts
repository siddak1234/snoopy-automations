/**
 * v2's own words (`words.md`, "v2 (draft, 2026-11-01)"): the screens' lines, and the review's
 * side-by-side "why". Everything v1 says that v2 still says stays in `words.ts`, unchanged.
 */
export const WORDS_V2 = {
  /** The run input, the card's one line, the NPI setup field and the specialties (setup; wired with the contract). */
  addVisitNotes: 'Add visit notes',
  forWhom: 'For doctors and coders.',
  npi: 'NPI',
  npiHelp: 'Fills your specialties when none are picked. Optional.',
  specialties: 'Specialties',
  /** The review's "why" for one change: both codes side by side, the words that differ, the note's, the rule. */
  why: {
    columns: ['', 'On the note', 'Suggested'],
    code: 'Code',
    title: 'Title',
    differ: 'Words that differ',
    onlyNote: (words: string) => `Only on the note: ${words}`,
    onlySuggested: (words: string) => `Only suggested: ${words}`,
    same: 'The same words',
    fromNote: 'From the note',
    rule: 'Rule',
    ruleLine: (check: string, reason: string) => `${check}: ${reason}`,
  },
} as const;
