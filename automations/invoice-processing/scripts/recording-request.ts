import { EXTRACT_DOCUMENT_V1 } from '../src/prompts.js';
import { recordingRequest } from '../test/recordings.js';
import { SAMPLES } from '../test/sample-maker/samples.js';

/**
 * What an agent acting as the model must be given to record one sample — exactly what the
 * platform sends the model: the prompt's instruction as the system message, the step's fixed
 * input as the one user message, the sample attached to it, and the schema the answer is held
 * to — and where its answer is saved, in the shape `test/recordings.ts` loads. Each agent sees
 * its block and nothing else: not `expected.json`, not this repository.
 *
 *   npx tsx automations/invoice-processing/scripts/recording-request.ts [--json] [sample ...]
 */

const args = process.argv.slice(2);
const names = args.filter((arg) => arg !== '--json');
const unknown = names.filter((name) => !SAMPLES.some((sample) => sample.name === name));
if (unknown.length > 0) {
  const known = SAMPLES.map((sample) => sample.name).join(', ');
  console.error(`no such sample: ${unknown.join(', ')}; the samples: ${known}`);
  process.exit(2);
}
const requests = SAMPLES.filter((sample) => names.length === 0 || names.includes(sample.name)).map(
  recordingRequest,
);

if (args.includes('--json')) {
  console.log(JSON.stringify(requests, null, 2));
} else {
  for (const [index, each] of requests.entries()) {
    console.log(
      [
        `=== ${index + 1}/${requests.length} ${each.sample} (prompt ${EXTRACT_DOCUMENT_V1.id} v${EXTRACT_DOCUMENT_V1.version}) ===`,
        'FILE, attached to the user message — read it as a model reads a PDF or an image:',
        `  ${each.file}  (${each.contentType}, ${each.sizeBytes} bytes, sha256 ${each.recording.fileSha256})`,
        'SYSTEM INSTRUCTION, verbatim between the rules:',
        '-----',
        each.systemInstruction,
        '-----',
        'USER TEXT, verbatim:',
        each.userText,
        'RESPONSE SCHEMA, which the answer must match:',
        JSON.stringify(each.responseSchema, null, 2),
        `ANSWER WITH ${each.answerWith}.`,
        `SAVE AS ${each.saveAs}:`,
        JSON.stringify(each.recording, null, 2),
        `DO NOT READ test/samples/${each.sample}/expected.json or anything else in the repository.`,
        '',
      ].join('\n'),
    );
  }
}
