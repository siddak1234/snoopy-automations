import { capitalised, cleanText, parseDate } from '@autom8x/automation-kit/values';
import { isObject, truncateText, type JsonObject } from '@autom8x/automation-sdk';

import type { SecondRead } from '../checks/answers.js';
import { checkFirstRead } from '../checks/check.js';
import { namedFields } from '../checks/fields.js';
import { RECORDING_RULES } from '../checks/rules.js';
import { NOT_RECORDED } from '../quickbooks-path.js';
import { compareReads, recheckedWith } from '../reads/compare.js';
import type { NotMadeReason, VerificationState } from '../state.js';
import { LINE_MAXIMUM } from '../words.js';
import { documentOf } from './check.js';
import type { Entry } from './state.js';
import { DOUBTS, countLine } from './words.js';

/**
 * One document's second read, against its first (the session's spec, B4; v2's `verify-read` for
 * one document, kept): the reads compared field by field (`src/reads/compare.ts`) — the second
 * total recorded when only it agrees with the document's own arithmetic, and the checks run again
 * on it — or, for a first read the checks could not use, the gaps the second read fills.
 */

/** What a comparison weighs besides the reads. */
export interface SecondReadChecks {
  /** QuickBooks chosen: a recording rule the second total meets keeps the document out of it. */
  readonly quickBooks: boolean;
  /** The run's UTC date, for the checks run again. */
  readonly today: string;
  /** The model that served the second read. */
  readonly model: string;
}

/** A second read not made: kept on the document, which holds on the QuickBooks path (v2's D6). */
export function notMade(entry: Entry, reason: NotMadeReason): Entry {
  if (entry.unsettled !== undefined) return entry;
  const verification: VerificationState = { status: 'not_made', reason };
  return {
    ...entry,
    engine: { ...entry.engine, verification: verification as unknown as JsonObject },
  };
}

/** v2's comparison of one document's two reads. */
export function compared(entry: Entry, second: SecondRead, checks: SecondReadChecks): Entry {
  const document = documentOf(entry.engine);
  if (!document) return entry;
  const comparison = compareReads(document, second);
  let kept = document;
  let notRecorded: string | undefined;
  if (comparison.totalPicked === 'second' && comparison.secondTotalCents !== null) {
    const rechecked = recheckedWith(document, comparison.secondTotalCents);
    kept = rechecked.document;
    // A recording rule the new total meets keeps it out of QuickBooks; with "None", none applies.
    const stopped = !checks.quickBooks || entry.engine.quickBooks !== undefined;
    if (!stopped && rechecked.rule !== undefined) {
      notRecorded = NOT_RECORDED[RECORDING_RULES[rechecked.rule]];
    }
  }
  const verification: VerificationState = {
    status: 'made',
    modelServed: checks.model,
    compared: comparison.compared,
    differences: comparison.differences,
    totalPicked: comparison.totalPicked,
    spendTypeDisputed: comparison.spendTypeDisputed,
  };
  return {
    ...entry,
    engine: {
      ...entry.engine,
      document: kept as unknown as JsonObject,
      verification: verification as unknown as JsonObject,
      ...(notRecorded === undefined ? {} : { quickBooks: { notRecorded } }),
    },
  };
}

/**
 * The first read with what the second read gives where the first gave nothing usable: the seller's
 * name, the total, the date — the gaps that kept the checks from using it (C8, C11, C21, C22, C26).
 * Nothing the first read did give is replaced, and a field the second read fills is no longer
 * unclear unless the second read says it is.
 */
export function filledAnswer(answer: JsonObject, second: SecondRead): JsonObject {
  const filled: JsonObject = { ...answer };
  const fields = new Set<string>();
  if (cleanText(answer.vendorName) === null && cleanText(second.vendorName) !== null) {
    filled.vendorName = second.vendorName;
    fields.add('vendorName');
  }
  if (answer.total === null && second.total !== null) {
    filled.total = second.total;
    fields.add('total');
  }
  if (
    parseDate(answer.documentDate).kind !== 'date' &&
    parseDate(second.documentDate).kind === 'date'
  ) {
    filled.documentDate = second.documentDate;
    fields.add('documentDate');
  }
  const unclear = Array.isArray(answer.uncertainFields) ? answer.uncertainFields : [];
  filled.uncertainFields = unclear.filter(
    (field) => !fields.has(String(field)) || second.uncertainFields.includes(String(field)),
  );
  return filled;
}

/**
 * An unsettled document read again: settled — the checks run on the first read with the second's
 * gaps filled, then the two compared as any other — or still unsettled, under the rule it now fails
 * first, when the second read could not fill what was missing.
 */
export function settled(entry: Entry, second: SecondRead, checks: SecondReadChecks): Entry {
  if (entry.answer === undefined) return entry;
  const answer = filledAnswer(entry.answer, second);
  const outcome = checkFirstRead({
    answer,
    quickBooks: checks.quickBooks,
    companyName: null,
    legalName: null,
    today: checks.today,
  });
  if (outcome.outcome === 'failed') return { ...entry, answer, unsettled: outcome.rule };
  const { unsettled: _unsettled, ...rest } = entry;
  const rule = outcome.recordingRule;
  const checked: Entry = {
    ...rest,
    answer,
    engine: {
      document: outcome.document as unknown as JsonObject,
      ...(rule === undefined
        ? {}
        : { quickBooks: { notRecorded: NOT_RECORDED[RECORDING_RULES[rule]] } }),
    },
  };
  return compared(checked, second, checks);
}

/** The verification an entry's second read left, when it left one. */
function verificationOf(entry: Entry): VerificationState | undefined {
  const value = entry.engine.verification;
  return isObject(value) ? (value as unknown as VerificationState) : undefined;
}

/** Whether a document read again is still unclear: unsettled, read differently, or not read again. */
export function stillUnclear(entry: Entry): boolean {
  const verification = verificationOf(entry);
  return (
    entry.unsettled !== undefined ||
    entry.doubts.includes(DOUBTS.count_differs) ||
    verification?.status === 'not_made' ||
    (verification?.status === 'made' && verification.differences.length > 0)
  );
}

/** The step's line: one document as v2 said it; several counted. `before`: the same, unread. */
export function verifyLine(entries: readonly Entry[], before: readonly Entry[] = []): string {
  if (entries.length === 1) {
    const [entry] = entries as [Entry];
    if (entry.unsettled !== undefined) return capitalised(DOUBTS[entry.unsettled]);
    // The second total meets a rule QuickBooks cannot record it under (v2's line).
    const stop = entry.engine.quickBooks;
    if (isObject(stop) && typeof stop.notRecorded === 'string' && !before[0]?.engine.quickBooks) {
      return truncateText(`Not recorded in QuickBooks: ${stop.notRecorded}`, LINE_MAXIMUM);
    }
    if (entry.doubts.includes(DOUBTS.count_differs)) return capitalised(DOUBTS.count_differs);
    const verification = verificationOf(entry);
    if (verification?.status !== 'made') return 'Second read not made';
    const { differences } = verification;
    if (differences.length === 0) return 'Second read matches';
    return truncateText(
      `Second read differs: ${namedFields(differences.map((each) => each.field))}`,
      LINE_MAXIMUM,
    );
  }
  return countLine([
    [entries.length, 'read again'],
    [entries.filter(stillUnclear).length, 'still unclear'],
  ]);
}
