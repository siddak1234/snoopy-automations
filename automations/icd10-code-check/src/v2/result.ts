import type { BatchUnit, EmittedBlock, InvokeRequest, JsonObject } from '@autom8x/automation-sdk';

import { visitAnswers } from './review-steps.js';
import { WORDS_V2 } from './words.js';

/**
 * What a v2 run gives. The batch run: one line, "{files} files · {pages} pages · {visits} visits ·
 * {set aside} set aside", as its summary and its one block, its counts as its output, and the
 * units the platform queues. A visit's run: v1's result, read with its review's answers by its
 * rows' own ids (`childRequest`).
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
    },
    ...(units.length === 0 ? {} : { units }),
  };
}

/** The invoke with its review's answers named by the visit's rows' own ids, as v1's result reads them. */
export function childRequest(request: InvokeRequest): InvokeRequest {
  const continuation = request.continuation;
  if (continuation?.decisions === undefined) return request;
  const decisions = [...visitAnswers(request)].map(([id, decision]) => ({ id, decision }));
  return { ...request, continuation: { ...continuation, decisions } };
}
