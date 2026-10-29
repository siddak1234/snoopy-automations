/**
 * A made-up order file's documentation, in the layout table's words as `pdftotext -layout` gives
 * them (the FY2027 `icd10OrderFiles.pdf`, read 2026-10-28), and lines written to it.
 */
export const DOCUMENTATION = `Each line of an order file contains one code. A line is of variable length but never longer than 400
characters maximum. Fields are defined the same for the ICD-10-CM (diagnosis) and ICD-10-
PCS (procedure) files, as follows:
     Position Length Contents
          1           5       Order number, right justified, zero filled.
          6           1       Blank
          7           7       ICD-10-CM or ICD-10-PCS code. Dots are not included.
         14           1       Blank
         15           1       0 if the code is a "header" -not valid for HIPAA-covered
                              transactions.
                              1 if the code is valid for submission for HIPAA-covered transactions.
         16           1       Blank
         17          60       Short description
         77           1       Blank
         78        To end Long description
`;

/** One order-file line: order number, code, flag and the title as both descriptions. */
export const line = (order: number, code: string, flag: string, title: string): string =>
  `${String(order).padStart(5, '0')} ${code.padEnd(7)} ${flag} ${title.slice(0, 60).padEnd(60)} ${title}`;
