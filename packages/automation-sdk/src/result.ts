import { Buffer } from 'node:buffer';

import { oneLine, type RunResult } from './contract.js';
import { boundedDetails } from './details.js';
import { boundedDocuments } from './documents.js';

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
 * The result with every one-line field, each line of its `details` and each of its `documents`,
 * normalised to what the wire accepts. A success whose body would pass `RESULT_BODY_LIMIT_BYTES`
 * leaves out its `output` — the structured result the platform keeps and never publishes — so the
 * documents a person reads still arrive; nothing a person reads in a success is ever left out for
 * size. A held result past it leaves out its `documents`, never its `held.state`: the state comes
 * back with the approval and carries what the continuation needs to send every document then, and
 * a held run the platform could not read would never be offered for approval at all.
 */
export function boundedResult(result: RunResult): RunResult {
  switch (result.outcome) {
    case 'success': {
      const { details, documents, ...rest } = result;
      const lines = boundedDetails(details);
      const kept = boundedDocuments(documents);
      const bounded: Extract<RunResult, { outcome: 'success' }> = {
        ...rest,
        ...(result.summary === undefined ? {} : { summary: oneLine(result.summary, 'summary') }),
        ...(lines === undefined ? {} : { details: lines }),
        ...(kept === undefined ? {} : { documents: kept }),
      };
      if (bounded.output === undefined || bodyBytes(bounded) <= RESULT_BODY_LIMIT_BYTES) {
        return bounded;
      }
      const { output: _output, ...withoutOutput } = bounded;
      return withoutOutput;
    }
    case 'held': {
      const { documents, ...rest } = result;
      const kept = boundedDocuments(documents);
      const bounded: Extract<RunResult, { outcome: 'held' }> = {
        ...rest,
        held: { ...result.held, reason: oneLine(result.held.reason, 'held.reason') },
        ...(kept === undefined ? {} : { documents: kept }),
      };
      if (bounded.documents === undefined || bodyBytes(bounded) <= RESULT_BODY_LIMIT_BYTES) {
        return bounded;
      }
      const { documents: _documents, ...withoutDocuments } = bounded;
      return withoutDocuments;
    }
    case 'failed':
      return { ...result, failureReason: oneLine(result.failureReason, 'failureReason') };
  }
}
