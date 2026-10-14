import { truncateText } from './contract.js';

/**
 * A successful run's `details` (platform ADR-0037; its BUILD-PLAN 25.4.22): a few label and
 * value lines an automation writes FOR PEOPLE — "Seller: Harrowgate Office Supply" — which the
 * platform keeps with the run and shows on the one-run read, and never parses. The structured
 * result stays in `output`, which the platform keeps and does not publish.
 */
export interface RunDetail {
  readonly label: string;
  readonly value: string;
}

/** The platform's bounds on `details` (`automation-run-result.json`): its schema and its column name them. */
export const RUN_DETAIL_LIMITS = { label: 40, value: 200, lines: 20 } as const;

/** One line of text: every run of white space, line breaks included, one space; trimmed. */
const oneLineText = (value: string) => value.replace(/\s+/gu, ' ').trim();

/**
 * The lines as the wire accepts them: each label and value made one line and cut at its bound,
 * whole characters only; a line whose label or value is then empty left out; at most
 * `RUN_DETAIL_LIMITS.lines`, the first kept. `undefined` when none is left, so a result never
 * carries an empty list — a run whose work is done must not become unreportable because a
 * value ran long, as `oneLine` holds a summary.
 */
export function boundedDetails(details: readonly RunDetail[] | undefined): RunDetail[] | undefined {
  const kept: RunDetail[] = [];
  for (const line of details ?? []) {
    const label = truncateText(oneLineText(line.label), RUN_DETAIL_LIMITS.label).trimEnd();
    const value = truncateText(oneLineText(line.value), RUN_DETAIL_LIMITS.value).trimEnd();
    if (label !== '' && value !== '') kept.push({ label, value });
    if (kept.length === RUN_DETAIL_LIMITS.lines) break;
  }
  return kept.length === 0 ? undefined : kept;
}
