import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chosenOptions, type JsonObject, type ManifestSetupField } from '@autom8x/automation-sdk';

/**
 * v2's specialties (the spec's v2 section, rows 1 and 4): the setup dropdown's NUCC codes
 * (`automations/icd10-code-check/assets/v2/specialties.json`, 695 in 16 groups), the run's picks,
 * and the v1 specialty each NUCC code runs v1's specialty checks as (`V1_NAMES`).
 */
export interface SpecialtyOption {
  value: string;
  label: string;
  group: string;
}

let loaded: readonly SpecialtyOption[] | undefined;

/** The dropdown's options, read once. */
export function specialtyOptions(): readonly SpecialtyOption[] {
  loaded ??= (
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../assets/v2/specialties.json', import.meta.url)),
        'utf8',
      ),
    ) as { options: SpecialtyOption[] }
  ).options;
  return loaded;
}

/** The v2 manifest's setup field, as `chosenOptions` reads a run's picks from `config`. */
export const specialtiesField = (): ManifestSetupField => ({
  key: 'specialties',
  control: 'select',
  options: specialtyOptions(),
  multiple: true,
});

/** The setup's picks: NUCC codes the dropdown holds, in its order. */
export const pickedSpecialties = (config: JsonObject): string[] =>
  chosenOptions(config, specialtiesField());

/** The setup's NPI, when it is 10 digits; anything else is none. */
export function npiOf(config: JsonObject): string | undefined {
  const value = typeof config.npi === 'string' ? config.npi.replace(/\s/gu, '') : '';
  return /^\d{10}$/u.test(value) ? value : undefined;
}

/**
 * The v1 specialty whose checks (`specialty-checks.ts`) a NUCC code runs: v1's six, each its
 * NUCC physician code (the session's mapping, README v2 section). Any other code runs the general
 * checks alone.
 */
export const V1_NAMES: Readonly<Record<string, string>> = {
  '207RN0300X': 'Nephrology',
  '2080P0210X': 'Nephrology',
  '207R00000X': 'Internal medicine',
  '207RC0000X': 'Cardiology',
  '207RE0101X': 'Endocrinology',
  '207Q00000X': 'Family practice',
  '207RG0300X': 'Geriatric medicine',
  '207QG0300X': 'Geriatric medicine',
};

/** The v1 names the chosen NUCC codes run v1's specialty checks as, each once. */
export const v1NamesOf = (codes: readonly string[]): string[] => [
  ...new Set(codes.flatMap((code) => (V1_NAMES[code] === undefined ? [] : [V1_NAMES[code]]))),
];

/** The labels of the chosen codes, for the reading prompt's "The clinic treats …". */
export const labelsOf = (codes: readonly string[]): string[] =>
  specialtyOptions()
    .filter((option) => codes.includes(option.value))
    .map((option) => option.label);
