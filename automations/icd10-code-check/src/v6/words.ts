/**
 * v6's own words (`words.md`, section 6, the session's, awaiting the owner): the setup's sections,
 * what a hook run says on its run page and timeline, the line on why a chart note's or a card's
 * code carries when no check gave one, and each visit's chart note outcome. Every word of v1 to v3
 * stays (`automations/icd10-code-check/src/words.ts`, `automations/icd10-code-check/src/v2/words.ts`).
 */
export const WORDS_V6 = {
  /** The setup's sections, in order (BUILD-PLAN 30.10.4; build 39's item 9 as a list, R22-D3). */
  setupSections: {
    npi: 'NPI',
    specialty: 'Specialty',
    connections: 'Connections',
    improvement: 'Continuous improvement',
  },
  /** A hook run's summary: the codes its card offers (the card's own words are the platform's). */
  hookSummary: (n: number) =>
    n === 0 ? 'No codes to suggest' : `${n} ${n === 1 ? 'code' : 'codes'} suggested in your EHR`,
  /** A hook run that read no note: its summary and its one block. */
  noNoteSummary: 'No visit note read',
  noNotes: 'No note for this visit could be read from your EHR, so no codes were suggested.',
  /** The timeline's line for the notes read. */
  notesRead: (read: number, skipped: number) =>
    `${read} ${read === 1 ? 'note' : 'notes'} read · ${skipped} skipped`,
  /** The EHR answered the notes' search with something other than a FHIR Bundle. */
  notesNotRead: "The visit's notes could not be read from your EHR.",
  /** A code the checks kept with no line of their own (a Keep with no quote). */
  supported: 'The note supports this code.',
  /** A code on the note kept because its change was denied in the review. */
  keptInReview: 'On the note, kept in your review.',
  /** A code picked in a change's place in the review (v3's "Other code"). */
  pickedInReview: 'Picked in your review.',
  /** The chart note's first line, then one line a code. */
  noteHeading: 'ICD-10 Code Check: the codes approved in your review',
  noteLine: (code: string, name: string, why: string) => `- ${code} ${name}: ${why}`,
  /** Each visit's chart note outcome, on its timeline and in its result. */
  written: 'Note added to your EHR',
  notWritten: (reason: string) => `Not added to your EHR: ${reason}`,
} as const;

/**
 * Why a visit's chart note was not written, a run's `output.chartNote.reason`: no patient detail,
 * ever. The session's words.
 */
export const NOT_WRITTEN = {
  /** Held for the review, and the run not continued by its approval. */
  notApproved: 'not approved',
  /** No change to review (`review-visit` held nothing), so no approval was asked. */
  nothingToReview: 'nothing to review',
  noCodes: 'no codes approved',
  noRecordNumber: 'no record number',
  recordNumberUnusable: 'record number not usable',
  noBirthDate: 'no birth date on the note',
  /** A birth date printed that is no real date in a form `birthDateOf` reads. */
  birthDateUnusable: 'birth date not usable',
  noVisitDate: 'no visit date',
  patientNotMatched: 'patient not matched',
  /** The one patient matched by the record number, born on another day than the note says. */
  birthDateNotMatched: 'birth date did not match',
  visitNotMatched: 'visit not matched',
  notConnected: 'your EHR is not connected',
  refused: 'your EHR refused it',
  unconfirmed: 'not confirmed: check the visit in your EHR',
  noAnswer: 'your EHR did not answer',
} as const;
