import type { BatchUnit, EmittedBlock, InvokeRequest, JsonObject } from '@autom8x/automation-sdk';

import { auditOf, boundedAudit } from './audit.js';
import { visitAnswers } from './review-steps.js';
import { WORDS_V2 } from './words.js';

/**
 * What a v2 run gives. The batch run: one line, "{files} files · {pages} pages · {visits} visits ·
 * {set aside} set aside", as its summary and its one block, its counts and its AI calls' audit
 * records as its output, and the units the platform queues. A visit's run: v1's result, read with
 * its review's answers by its rows' own ids (`childRequest`), its output with the audit records
 * and the run's measures (`visitResult`).
 */
export function batchResult(state: JsonObject) {
  const files = Array.isArray(state.files) ? (state.files as { pagesFrom?: string }[]) : [];
  const units = Array.isArray(state.units) ? (state.units as BatchUnit[]) : [];
  const pages = typeof state.pages === 'number' ? state.pages : 0;
  const setAside = typeof state.setAside === 'number' ? state.setAside : 0;
  const line = WORDS_V2.batch(files.length, pages, units.length, setAside);
  const blocks: EmittedBlock[] = [{ type: 'text', text: line }];
  return {
    summary: line,
    blocks,
    output: {
      files: files.length,
      pages,
      visits: units.length,
      setAside,
      pagesFrom: files.map((file) => file.pagesFrom ?? 'measured'),
      audit: boundedAudit(auditOf(state)),
    },
    ...(units.length === 0 ? {} : { units }),
  };
}

/** The invoke with its review's answers named by the visit's rows' own ids, as v1's result reads them. */
export function childRequest(request: InvokeRequest): InvokeRequest {
  const continuation = request.continuation;
  if (continuation?.decisions === undefined) return request;
  const decisions = [...visitAnswers(request)].flatMap(([id, decision]) =>
    decision === 'other' ? [] : [{ id, decision }],
  );
  return { ...request, continuation: { ...continuation, decisions } };
}

/**
 * A visit's output with its AI calls' audit records (`boundedAudit`) and its measures: the
 * diagnoses, those settled with no AI, sent and kept by gate B, the clinic's examples used and
 * saved, each verdict's count, and the changes accepted and denied.
 */
export function visitResult<R extends { output: JsonObject }>(done: R, state: JsonObject): R {
  const verdicts = (done.output.verdicts ?? []) as { verdict: string }[];
  const decided = (done.output.decisions ?? []) as { accepted: boolean }[];
  const counts: Record<string, number> = {};
  for (const { verdict } of verdicts) counts[verdict] = (counts[verdict] ?? 0) + 1;
  const accepted = decided.filter((d) => d.accepted).length;
  return {
    ...done,
    output: {
      ...done.output,
      audit: boundedAudit(auditOf(state)),
      measures: {
        ...((state.measures ?? {}) as JsonObject),
        verdicts: counts,
        accepted,
        denied: decided.length - accepted,
      },
    },
  };
}
