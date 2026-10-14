import type { StepResult } from '@autom8x/automation-sdk';

import { RUN_FAILS, type RunFail } from './words.js';

/**
 * How a step ends the run: its timeline line and the run's reason are the same plain sentence,
 * which carries nothing from the file, from QuickBooks' own text or from a model — and NO reason
 * code (the spec's §2.3: "`failedWith` keeps the reason code in the LOG only"). The code is noted
 * against the result, and the run's wrapper logs it with the step that returned it
 * (`noteThrows` in `src/failures.ts`, through `jsonLogger`).
 */

const codes = new WeakMap<object, string>();

/** The reason code a step's result carries for the log; none for a result `failedWith` did not make. */
export function codeOf(result: StepResult): string | undefined {
  return codes.get(result);
}

/** The run ends with `sentence`; `code` goes to the log alone. */
export function failedWith(code: string, sentence: string): StepResult {
  const result: StepResult = { outcome: 'failed', summary: sentence, failureReason: sentence };
  codes.set(result, code);
  return result;
}

/** The run ends with one of the spec's sentences (§3.F); `code` says why, for the log. */
export function runFails(fail: RunFail, code: string = fail): StepResult {
  return failedWith(code, RUN_FAILS[fail]);
}

/** Digits grouped in threes, as `184,203`, without a locale. */
export function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}
