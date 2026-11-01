/**
 * v2's two lists (the spec, "v2 (draft, 2026-11-01)"): what `build-v2-assets.ts` reads from the
 * official files, as functions a test can feed made-up files. Nothing here fetches or runs a
 * download: each takes the file's text.
 *
 * (a) The specialties: the NUCC Health Care Provider Taxonomy, v26.1 (effective 7/1/26), every row
 *     whose Section is "Individual", minus the groupings "Student, Health Care" and "Group", in the
 *     file's order — 695 rows in 16 groupings, both counts asserted.
 * (b) The preferences: per NUCC code, the code families listed first — the "Common Codes" of CMS's
 *     ICD-10 Clinical Concepts guides (2015), mapped to NUCC codes by Classification/Specialization
 *     name (`GUIDE_MAPPING`, each row with its reason); each listed code kept when it is a valid
 *     code (flag 1) of the current table, else its three-character category; and Nephrology's
 *     kidney families from the go's list (`NEPHROLOGY`), not v1's N00–N29. Every other specialty has none: they are
 *     learned later, from what each clinic accepts.
 */

/** One dropdown choice (the platform round's bigger `select`): `value` 1–64, `label` 1–120, `group` 1–80. */
export interface SpecialtyOption {
  value: string;
  label: string;
  group: string;
}

/** The NUCC file's version this build reads, and its row and grouping counts once filtered. */
export const NUCC = {
  version: '26.1',
  effective: '2026-07-01',
  url: 'https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv',
  rows: 695,
  groupings: 16,
  leftOut: ['Student, Health Care', 'Group'],
} as const;

/** RFC 4180: fields split on commas, a quoted field may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^﻿/u, '');
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (quoted) throw new Error('the CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The NUCC file's rows as records by its own header; refused when a column this build reads is missing. */
export function nuccRows(csv: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(csv);
  const needed = [
    'Code',
    'Grouping',
    'Classification',
    'Specialization',
    'Display Name',
    'Section',
  ];
  const missing = needed.filter((name) => !header?.includes(name));
  if (header === undefined || missing.length > 0)
    throw new Error(`the NUCC file has no ${missing.join(', ')} column`);
  return body
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .map((cells) => Object.fromEntries(header.map((name, i) => [name, (cells[i] ?? '').trim()])));
}

/**
 * (a): the Individual rows minus the left-out groupings, in the file's order, as
 * `{value: Code, label: Display Name, group: Grouping}`. Refused unless the counts are the ones
 * expected (695 and 16 for v26.1), a code repeats, or a value, label or group is out of bounds.
 */
export function specialtiesFrom(
  csv: string,
  expected: { rows: number; groupings: number } = NUCC,
): SpecialtyOption[] {
  const left = new Set<string>(NUCC.leftOut);
  const options = nuccRows(csv)
    .filter((row) => row.Section === 'Individual' && !left.has(row.Grouping!))
    .map((row) => ({ value: row.Code!, label: row['Display Name']!, group: row.Grouping! }));
  const groupings = new Set(options.map((option) => option.group)).size;
  if (options.length !== expected.rows || groupings !== expected.groupings)
    throw new Error(
      `expected ${expected.rows} rows in ${expected.groupings} groupings, read ${options.length} in ${groupings}`,
    );
  if (new Set(options.map((option) => option.value)).size !== options.length)
    throw new Error('a NUCC code repeats');
  const out = options.find(
    (o) =>
      !/^[0-9A-Z]{10}$/u.test(o.value) ||
      o.label.length < 1 ||
      o.label.length > 120 ||
      o.group.length < 1 ||
      o.group.length > 80,
  );
  if (out !== undefined) throw new Error(`${out.value} is out of the dropdown's bounds`);
  return options;
}

/** The five CMS guides read, by the name in their address (`ICD10ClinicalConcepts<Name>1.pdf`). */
export const GUIDES = [
  'Cardiology',
  'InternalMedicine',
  'Pediatrics',
  'ObGyn',
  'Orthopedics',
] as const;
export type Guide = (typeof GUIDES)[number];

export const guideUrl = (guide: Guide): string =>
  `https://www.cms.gov/Medicare/Coding/ICD10/Downloads/ICD10ClinicalConcepts${guide}1.pdf`;

/** One NUCC row a guide's codes go to, found by its names and checked against its code. */
export interface MappedSpecialty {
  code: string;
  classification: string;
  specialization: string;
  reason: string;
}

const ORTHO = 'Orthopaedic Surgery';
const orthopaedic = (code: string, specialization: string): MappedSpecialty => ({
  code,
  classification: ORTHO,
  specialization,
  reason: `a specialization of NUCC's ${ORTHO}, the guide's specialty`,
});

/**
 * Which NUCC codes each guide's Common Codes go to, by NUCC Classification/Specialization name,
 * each with its reason. Left out on purpose: the advanced practice providers (nurse practitioners,
 * physician assistants) of the same fields — NUCC names them by their own classification, not the
 * guide's specialty — and the subspecialties whose own focus the guide does not cover (Pediatric
 * Cardiology and Adult Congenital Heart Disease: the Cardiology guide's codes are adult, acquired
 * heart disease; the internal medicine and pediatric subspecialties: each has its own field).
 */
export const GUIDE_MAPPING: Readonly<Record<Guide, readonly MappedSpecialty[]>> = {
  Cardiology: [
    {
      code: '207RC0000X',
      classification: 'Internal Medicine',
      specialization: 'Cardiovascular Disease',
      reason: "NUCC's name for the general cardiologist",
    },
    {
      code: '207RI0011X',
      classification: 'Internal Medicine',
      specialization: 'Interventional Cardiology',
      reason: 'a cardiology subspecialty treating the same adult heart disease',
    },
    {
      code: '207RC0001X',
      classification: 'Internal Medicine',
      specialization: 'Clinical Cardiac Electrophysiology',
      reason: "a cardiology subspecialty; the guide's rhythm codes (I48, I49, R00) are its own",
    },
    {
      code: '207RA0001X',
      classification: 'Internal Medicine',
      specialization: 'Advanced Heart Failure and Transplant Cardiology',
      reason: "a cardiology subspecialty; the guide's heart failure codes (I50) are its own",
    },
  ],
  InternalMedicine: [
    {
      code: '207R00000X',
      classification: 'Internal Medicine',
      specialization: '',
      reason: 'the classification itself, with no specialization: the general internist',
    },
  ],
  Pediatrics: [
    {
      code: '208000000X',
      classification: 'Pediatrics',
      specialization: '',
      reason: 'the classification itself, with no specialization: the general pediatrician',
    },
  ],
  ObGyn: [
    {
      code: '207V00000X',
      classification: 'Obstetrics & Gynecology',
      specialization: '',
      reason: 'the classification itself: the guide covers both obstetrics and gynecology',
    },
    {
      code: '207VX0000X',
      classification: 'Obstetrics & Gynecology',
      specialization: 'Obstetrics',
      reason: "the guide's normal pregnancy codes (Z34) are its own",
    },
    {
      code: '207VG0400X',
      classification: 'Obstetrics & Gynecology',
      specialization: 'Gynecology',
      reason: "the guide's gynecological codes (N76–N95, Z01.41) are its own",
    },
  ],
  Orthopedics: [
    {
      code: '207X00000X',
      classification: ORTHO,
      specialization: '',
      reason: 'the classification itself, with no specialization: the general orthopaedic surgeon',
    },
    orthopaedic('207XS0114X', 'Adult Reconstructive Orthopaedic Surgery'),
    orthopaedic('207XX0004X', 'Foot and Ankle Surgery'),
    orthopaedic('207XS0106X', 'Hand Surgery'),
    orthopaedic('207XS0117X', 'Orthopaedic Surgery of the Spine'),
    orthopaedic('207XX0801X', 'Orthopaedic Trauma'),
    orthopaedic('207XP3100X', 'Pediatric Orthopaedic Surgery'),
    orthopaedic('207XX0005X', 'Sports Medicine'),
  ],
};

/**
 * Nephrology's families for v2: v1's approved list (v1's section 4, `SPECIALTIES` in
 * `automations/icd10-code-check/src/families.ts`), the same for both NUCC nephrology codes.
 */
export const NEPHROLOGY = {
  specialties: [
    {
      code: '207RN0300X',
      classification: 'Internal Medicine',
      specialization: 'Nephrology',
      reason: 'the nephrologist',
    },
    {
      code: '2080P0210X',
      classification: 'Pediatrics',
      specialization: 'Pediatric Nephrology',
      reason: 'the pediatric nephrologist',
    },
  ] as readonly MappedSpecialty[],
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
} as const;

/**
 * A guide's "Common Codes" section, as `pdftotext -layout` prints it: from the page that starts
 * "Common Codes" (the contents page's entry is indented, never at a page's start) to the page that
 * starts the next section — "Clinical Documentation Tips", a "Primer for …" (Internal Medicine and
 * Pediatrics title their tips so) or "… Clinical Scenarios". Refused when either end is missing.
 */
export function commonCodesSection(text: string): string[] {
  const lines = text.split('\n');
  const pageStart = (line: string) => line.startsWith('\f');
  const start = lines.findIndex((line) => pageStart(line) && line.trim() === 'Common Codes');
  if (start < 0) throw new Error('no page starts "Common Codes"');
  const end = lines.findIndex(
    (line, i) =>
      i > start &&
      pageStart(line) &&
      /^(Clinical Documentation Tips|Primer for |.*Clinical Scenarios$)/u.test(line.trim()),
  );
  if (end < 0) throw new Error('no page after "Common Codes" starts the next section');
  return lines.slice(start, end);
}

/**
 * The ICD-10-CM codes a Common Codes section lists, in its order, each once: a code that starts a
 * line, then an optional "*" (the guides' "more specific codes first" mark), then a space or the
 * line's end — so an ICD-9 code (digits, or "V22.0," inside a heading's brackets) is never one. The
 * guides print some zeros as "Ø"; they are read as 0.
 */
export function commonCodesIn(text: string): string[] {
  const codes: string[] = [];
  for (const line of commonCodesSection(text)) {
    const found = /^\s*([A-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?)\*?(?:\s|$)/u.exec(
      line.replace(/^\f/u, '').replace(/Ø/gu, '0'),
    );
    if (found && !codes.includes(found[1]!)) codes.push(found[1]!);
  }
  if (codes.length === 0) throw new Error('the Common Codes section lists no code');
  return codes;
}

/** Each code kept when valid (flag 1) in `table`, else its three-character category; each once, in order. */
export function keptCodes(
  codes: readonly string[],
  table: Readonly<Record<string, string>>,
): { kept: string[]; categories: string[] } {
  const kept: string[] = [];
  const categories: string[] = [];
  for (const code of codes) {
    const one = code in table ? code : code.slice(0, 3);
    if (!(code in table)) categories.push(code);
    if (!kept.includes(one)) kept.push(one);
  }
  return { kept, categories };
}

/** Each mapped row checked against the NUCC file: its code there, with the same two names. */
export function checkMapping(
  rows: readonly Record<string, string>[],
  mapped: readonly MappedSpecialty[],
): void {
  for (const one of mapped) {
    const row = rows.find((r) => r.Code === one.code);
    if (row === undefined) throw new Error(`${one.code} is not in the NUCC file`);
    if (row.Classification !== one.classification || row.Specialization !== one.specialization)
      throw new Error(
        `${one.code} is "${row.Classification}" / "${row.Specialization}" in the NUCC file, not "${one.classification}" / "${one.specialization}"`,
      );
  }
}

/** (b): per NUCC code, its families, in the mapping's order; a code mapped twice is refused. */
export function preferencesFrom(
  rows: readonly Record<string, string>[],
  guides: Readonly<Record<Guide, readonly string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const put = (mapped: readonly MappedSpecialty[], families: readonly string[]) => {
    checkMapping(rows, mapped);
    for (const one of mapped) {
      if (one.code in out) throw new Error(`${one.code} is mapped twice`);
      out[one.code] = [...families];
    }
  };
  for (const guide of GUIDES) put(GUIDE_MAPPING[guide], guides[guide]);
  put(NEPHROLOGY.specialties, NEPHROLOGY.families);
  return out;
}
