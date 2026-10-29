import { failed, readJsonCompletion, settle, type Step } from '@autom8x/automation-sdk';

import { gateB, type MatchInput } from '../candidates.js';
import { MODELS } from '../models.js';
import { prompt } from '../prompts.js';
import { readingOf, withoutPatient } from '../reading.js';
import { loadTable, type TableId } from '../tables.js';

/**
 * Codes matched: AI picks one listed code for each diagnosis, or none (`match-codes`, the spec's
 * section 4). It is sent each diagnosis's statement, certainty and evidence with every patient value
 * and every other identifier replaced by "[patient]" (the privacy rule, `withoutPatient`), and its
 * numbered candidates; never the file, the patient, the specialties or a code of another table.
 * Gate B keeps a pick only when it holds (`gateB`). With no diagnosis to match, nothing is sent.
 */
export const matchCodes: Step = async (context) => {
  const { state, platform } = context;
  const reading = readingOf(state.reading);
  const { codes } = loadTable(state.table as TableId);
  const lists = Array.isArray(state.candidates) ? (state.candidates as string[][]) : [];
  const sent: MatchInput[] = reading.diagnoses
    .map((diagnosis, index) => ({
      diagnosis: index,
      statement: withoutPatient(diagnosis.statement, reading),
      certainty: diagnosis.certainty,
      evidence: diagnosis.evidence === null ? null : withoutPatient(diagnosis.evidence, reading),
      candidates: (lists[index] ?? []).map((code, at) => ({
        number: at + 1,
        code,
        title: codes[code] ?? code,
      })),
    }))
    .filter((input) => input.candidates.length > 0);
  const { candidates: _candidates, ...rest } = state;
  if (sent.length === 0) {
    return { outcome: 'ok', summary: 'Codes matched', state: { ...rest, matches: {} } };
  }
  const asked = await settle(context, () =>
    platform.callModel(prompt('match-codes'), { diagnoses: sent }, { models: MODELS }),
  );
  if (!asked.ok) return failed(asked.sentence, asked.kind);
  const kept = gateB(sent, readJsonCompletion(asked.value), codes);
  return {
    outcome: 'ok',
    summary: 'Codes matched',
    state: {
      ...rest,
      matches: Object.fromEntries([...kept].map(([index, match]) => [String(index), match])),
    },
  };
};
