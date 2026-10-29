/**
 * Every sentence the flow writes into a run: the spec's section 8 (the failures) and `words.md`,
 * section 2 (the checks', the blocks', the review's), word for word. `{…}` are filled by the code.
 */
export const FAILURES = {
  noFile: 'Add the visit note as a PDF or photo.',
  notVisitNote: "This file doesn't look like a visit note.",
  unreadable: 'The note could not be read. Try a clearer PDF or photo.',
  patients: "This file has more than one patient's notes. Add one visit at a time.",
  tooMany: 'This note has more than 40 diagnoses. Add one visit at a time.',
  tooManyChanges: 'This note has more than 40 changes to review. Add one visit at a time.',
  tooEarly: 'This visit is before Oct 1, 2025. This flow checks 2026 and 2027 codes only.',
  tooLate: 'This flow has no code table for this visit date yet.',
} as const;

/** The verdicts, as the table's second column reads them. */
export const VERDICTS = {
  keep: 'Keep',
  change: 'Change',
  add: 'Add',
  remove: 'Remove',
  moveUp: 'Move up',
  ask: 'Ask the doctor',
  accepted: 'Accepted',
  denied: 'Denied',
} as const;

export type Verdict = keyof Pick<
  typeof VERDICTS,
  'keep' | 'change' | 'add' | 'remove' | 'moveUp' | 'ask'
>;

/** Each check's reason. */
export const REASONS = {
  G1: (code: string, table: string) => `${code} is not a complete ${table} code.`,
  G3: 'The note supports a more exact code.',
  G4change: 'The note says this is uncertain, so the sign or symptom is coded instead.',
  G4ask: 'The note says this is uncertain, and no sign or symptom is written.',
  G5staff: 'Only staff who are not the provider mention it.',
  G5visit: "The note doesn't show it was assessed or treated at this visit.",
  G6: 'No line in the note supports this code.',
  G7: "The note supports this, and it isn't on the chart.",
  K1: 'Kidney failure (N18.6) is coded, so no stage code goes beside it.',
  K2change: 'The patient is on dialysis, so dialysis status (Z99.2) is added.',
  K2ask: 'Kidney failure is coded. If the patient is on dialysis, add Z99.2.',
  K3: "The kidney disease stage isn't in this note. An earlier visit may have it.",
  L1: 'High blood pressure with kidney disease is coded together (I12), with the stage code after it.',
  L2: 'High blood pressure with heart and kidney disease is coded together (I13).',
  L3: (code: string) => `${code} goes before the kidney disease stage code.`,
  T1: (note: string) => `The code table says: ${note}`,
} as const;

export const WORDS = {
  fromNote: 'From the note',
  metrics: { kept: 'Kept', changes: 'Changes', asks: 'Ask the doctor' },
  asks: 'Ask the doctor',
  patient: 'Patient',
  patientColumns: ['Detail', 'Value'],
  patientRows: {
    name: 'Name',
    birthDate: 'Date of birth',
    sex: 'Sex',
    recordNumber: 'Record number',
    visitDate: 'Visit date',
    provider: 'Provider',
  },
  codeColumns: ['Code', 'Verdict', 'Suggested'],
  toEnter: 'Codes to enter',
  toEnterColumns: ['Code', 'Description'],
  allSupported: 'All codes supported',
  answered: (a: number, d: number) => `${a} accepted · ${d} denied`,
  directions: (quote: string) => `Text in the note tries to direct the reader: “${quote}”`,
  noVisitDate: "Visit date not on the note: checked with today's code table.",
  footer: (table: string) =>
    `Checked against the ${table} code set. Suggestions only: you accept or deny every change.`,
  held: (c: number) => `${c} changes need your review.`,
  aprilHold: 'This visit is between Apr 1 and Sep 30, 2026. Check which 2026 code table applies.',
  summaryKept: (n: number) => `${n} codes · all supported`,
  summaryHeld: (n: number, c: number) => `${n} codes · ${c} to review`,
  summaryDone: (n: number, a: number, d: number) => `${n} codes · ${a} accepted · ${d} denied`,
  titleNamed: (name: string, date: string) => `${name} · ${date}`,
  titleDated: (date: string) => `Visit · ${date}`,
  titlePlain: 'Visit note',
  label: {
    change: (code: string, suggested: string) => `${code} → ${suggested}`,
    add: (code: string) => `Add ${code}`,
  },
} as const;
