/**
 * v2's own words (`words.md`, section 4, "v2 (draft, 2026-11-01)"): the screens' lines, the
 * review's "why" as the owner's screens showed it, and the stop for a file one run cannot review.
 * Everything v1 says that v2 still says stays in `words.ts`, unchanged.
 */
export const WORDS_V2 = {
  /** The run input, the card's one line, the NPI setup field and the specialties (setup; wired with the contract). */
  addVisitNotes: 'Add visit notes',
  forWhom: 'For doctors and coders.',
  npi: 'NPI',
  npiHelp: 'Fills your specialties when none are picked. Optional.',
  specialties: 'Specialties',
  /** A file whose visits pass one run's limits (the spec's v2 section, row 6). */
  tooManyVisits:
    'This file has more visits than one run can review. Upload the visits as separate files.',
  /** A decision's detail, its parts joined by " · " (the owner's screens). */
  why: {
    difference: (first: string, second: string) => `Difference: "${first}" vs "${second}"`,
    fromNote: (quote: string) => `From the note: "${quote}"`,
    rule: (rule: string) => `Rule: ${rule}`,
    join: ' · ',
  },
} as const;
