/**
 * v2's own words (`words.md`, section 4, "v2"): the screens' lines, the review's "why" as the
 * owner's screens showed it, the batch run's line, and the stops. Everything v1 says that v2 still
 * says stays in `words.ts`, unchanged.
 */
const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const WORDS_V2 = {
  /** The run input, the card's one line, the NPI setup field and the specialties (setup). */
  addVisitNotes: 'Add visit notes',
  forWhom: 'For doctors and coders.',
  npi: 'NPI',
  npiHelp: 'Fills your specialties when none are picked. Optional.',
  specialties: 'Specialties',
  /** The clinic's learning (setup, the owner's L5): on by default; off clears the examples. */
  learn: "Learn from this clinic's reviews",
  learnHelp:
    'On by default. Each accepted or denied change, without names, numbers or dates, guides later picks. Turn it off to stop and clear what was learned.',
  /** A visit whose codes table or blocks pass one run's limits (the spec's v2 section, row 6). */
  tooManyCodes: 'This visit has more codes than one run can review.',
  /** The batch run's one line, its summary and its block (the task's words, 1 in the singular). */
  batch: (files: number, pages: number, visits: number, setAside: number) =>
    `${count(files, 'file')} · ${count(pages, 'page')} · ${count(visits, 'visit')} · ${setAside} set aside`,
  /** An upload whose visits pass one batch's limits (the platform's 500 units, 50 files a unit). */
  tooBig: 'This upload has more visits than one batch can hold. Upload fewer files at a time.',
  /** An upload whose pages cannot all be sorted before the run's deadline (row 6). */
  tooLong:
    'This upload has more pages than one run can sort in time. Upload fewer files at a time.',
  /** The timeline's lines for a step that went on without what it asked for. */
  npiNotRead: 'Specialties not read from your NPI',
  notRemembered: "Codes saved. Your clinic's choices were not remembered for next time.",
  /** A decision's detail, its parts joined by " · " (the owner's screens). */
  why: {
    difference: (first: string, second: string) => `Difference: "${first}" vs "${second}"`,
    fromNote: (quote: string) => `From the note: "${quote}"`,
    rule: (rule: string) => `Rule: ${rule}`,
    join: ' · ',
  },
} as const;

/**
 * v3's own words (`words.md`, section 5, awaiting the owner): the setup's sections (F3), the NPI
 * box's example (F2) and a change answered with another code (item 4). Every word of v2 stays
 * (`WORDS_V2`, `words.ts`).
 */
export const WORDS_V3 = {
  /** The setup's sections, in order (F3); the EHR connection joins "Integrations" in Stage 2. */
  sections: { npi: 'NPI', specialty: 'Specialty', integrations: 'Integrations' },
  /** The NPI box's placeholder in place of "Optional" (F2): a valid NPI (`v3-manifest.test.ts`). */
  npiExample: '10 digits, e.g. 1234567893',
  /** A Change answered with another code, in the codes table's verdict column (item 4, S1-B3). */
  changedTo: (code: string) => `Changed to ${code}`,
} as const;
