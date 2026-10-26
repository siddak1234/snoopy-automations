import { Buffer } from 'node:buffer';

import { boundedBlocks } from './blocks.js';
import { oneLine, type RunResult } from './contract.js';
import { boundedDetails } from './details.js';
import { boundedDocuments } from './documents.js';
import { boundedScore, boundedSections, boundedTitle, boundedVerdict } from './sections.js';

/**
 * The most bytes the result callback's body may take: the platform reads at most 256 KiB of it
 * (`snoopy-backend/apps/runs/src/routes-callbacks.ts:47`, `REQUEST_BODY_LIMIT_BYTES`). The one
 * size guard a result has — never a count of documents (the owner's AM1 and AM7, 2026-10-15: "no
 * limits other than size").
 */
export const RESULT_BODY_LIMIT_BYTES = 256 * 1024;

/** The body the result callback sends, in bytes, as the platform counts its JSON. */
const bodyBytes = (result: RunResult): number =>
  Buffer.byteLength(JSON.stringify({ runId: '00000000-0000-4000-8000-000000000000', ...result }));

/**
 * The platform refuses a result whose `blocks` come with `sections` or `details` (its ADR-0048
 * decision 3: a run's page is drawn from one or the other): refused here, before it is sent, in
 * its words. Given at all is refused, though either might bound to none: it is the code's mistake.
 */
function refuseBeside(result: { sections?: unknown; details?: unknown }): void {
  for (const other of ['sections', 'details'] as const) {
    if (result[other] !== undefined) {
      throw new Error(`blocks is not allowed with ${other}: send one or the other`);
    }
  }
}

/**
 * The result with every one-line field, each line of its `details` and each of its `documents`,
 * normalised to what the wire accepts — and a success's `title`, `score`, `verdict` and `sections` too
 * (`sections.ts`: cut, or left out, never refused), and a success's or a held result's `blocks`
 * (`boundedBlocks`); `blocks` beside `sections` or `details` is refused. A success whose body would pass
 * `RESULT_BODY_LIMIT_BYTES` leaves out its `output` — the structured result the platform keeps and
 * never publishes — so the documents, sections and blocks a person reads still arrive; nothing a
 * person reads in a success is ever left out for size. A held result past it never leaves out its
 * `held.state`, which comes back with the
 * approval and carries every read the continuation's result sends: it first sends each document
 * without its lines (`lineItems` empty, `lineItemsComplete` false), so the run page and the
 * waiting email still show each one's seller, number, totals and status, and only when even that
 * does not fit leaves out its `documents` (its blocks, within 96 KiB, stay). A state that alone
 * passes the limit cannot be sent.
 */
export function boundedResult(result: RunResult): RunResult {
  switch (result.outcome) {
    case 'success': {
      const { details, documents, title, score, verdict, sections, blocks, ...rest } = result;
      if (blocks !== undefined) refuseBeside({ sections, details });
      const lines = boundedDetails(details);
      const kept = boundedDocuments(documents);
      const named = boundedTitle(title);
      const ranked = boundedScore(score);
      const counted = boundedVerdict(verdict);
      const shown = boundedSections(sections);
      const drawn = boundedBlocks(blocks);
      const bounded: Extract<RunResult, { outcome: 'success' }> = {
        ...rest,
        ...(result.summary === undefined ? {} : { summary: oneLine(result.summary, 'summary') }),
        ...(lines === undefined ? {} : { details: lines }),
        ...(kept === undefined ? {} : { documents: kept }),
        ...(named === undefined ? {} : { title: named }),
        ...(ranked === undefined ? {} : { score: ranked }),
        ...(counted === undefined ? {} : { verdict: counted }),
        ...(shown === undefined ? {} : { sections: shown }),
        ...(drawn === undefined ? {} : { blocks: drawn }),
      };
      if (bounded.output === undefined || bodyBytes(bounded) <= RESULT_BODY_LIMIT_BYTES) {
        return bounded;
      }
      const { output: _output, ...withoutOutput } = bounded;
      return withoutOutput;
    }
    case 'held': {
      const { documents, blocks, ...rest } = result;
      const kept = boundedDocuments(documents);
      const drawn = boundedBlocks(blocks);
      const bounded: Extract<RunResult, { outcome: 'held' }> = {
        ...rest,
        held: { ...result.held, reason: oneLine(result.held.reason, 'held.reason') },
        ...(kept === undefined ? {} : { documents: kept }),
        ...(drawn === undefined ? {} : { blocks: drawn }),
      };
      if (bounded.documents === undefined || bodyBytes(bounded) <= RESULT_BODY_LIMIT_BYTES) {
        return bounded;
      }
      const withoutLines: Extract<RunResult, { outcome: 'held' }> = {
        ...bounded,
        documents: bounded.documents.map((document) => ({
          ...document,
          lineItems: [],
          lineItemsComplete: false,
        })),
      };
      if (bodyBytes(withoutLines) <= RESULT_BODY_LIMIT_BYTES) return withoutLines;
      const { documents: _documents, ...withoutDocuments } = bounded;
      return withoutDocuments;
    }
    case 'failed':
      return { ...result, failureReason: oneLine(result.failureReason, 'failureReason') };
  }
}
