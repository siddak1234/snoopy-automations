/**
 * The setup dropdown's specialties and each one's code families, listed first when a code is
 * picked (the spec, section 4, "The specialties"; the owner, ~21:24Z, "Families first, then
 * clinic"). Nephrology's diabetic CKD codes are the five the tabular list names
 * (`p3-rules-12`: "E08.22, E09.22, E10.22, E11.22, E13.22"). `automations/icd10-code-check/scripts/build-assets.ts` writes
 * them to `automations/icd10-code-check/assets/specialties.json`, and the code-table notes it keeps are these families'.
 */
export interface Specialty {
  readonly name: string;
  /** A category range ("N00-N29"), or a code or category whose codes all belong ("Z99.2", "Z49"). */
  readonly families: readonly string[];
}

const PRIMARY_CARE = ['I10-I16', 'E08-E13'] as const;

export const SPECIALTIES: readonly Specialty[] = [
  {
    name: 'Nephrology',
    families: [
      'N00-N29',
      'I12-I13',
      'E08.22',
      'E09.22',
      'E10.22',
      'E11.22',
      'E13.22',
      'D63.1',
      'Z49',
      'Z94.0',
      'Z99.2',
    ],
  },
  { name: 'Internal medicine', families: PRIMARY_CARE },
  { name: 'Cardiology', families: ['I00-I99'] },
  { name: 'Endocrinology', families: ['E00-E89'] },
  { name: 'Family practice', families: PRIMARY_CARE },
  { name: 'Geriatric medicine', families: PRIMARY_CARE },
];

/** Whether `code` (with its dot) is in one of `families`. */
export function inFamily(code: string, families: readonly string[]): boolean {
  const category = code.slice(0, 3);
  return families.some((family) => {
    const range = /^([A-Z]\d{2})-([A-Z]\d{2})$/u.exec(family);
    if (range) return category >= range[1]! && category <= range[2]!;
    return code === family || code.startsWith(family);
  });
}

/** The families of the chosen specialties, by name; a name the list does not hold has none. */
export const familiesOf = (chosen: readonly string[]): string[] =>
  SPECIALTIES.filter((specialty) => chosen.includes(specialty.name)).flatMap((s) => s.families);

/** The manifest's setup field (section 5), as `chosenOptions` reads a run's picks from `config`. */
export const SPECIALTIES_FIELD = {
  key: 'specialties',
  control: 'select',
  options: SPECIALTIES.map((specialty) => specialty.name),
  multiple: true,
  defaultValue: ['Nephrology'],
} as const;
