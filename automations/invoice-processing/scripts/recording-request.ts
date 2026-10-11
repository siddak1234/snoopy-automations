import { FIRST_READ, SECOND_READ, recordingRequest } from '../test/recordings.js';
import { SAMPLES } from '../test/sample-maker/samples.js';

/**
 * What an agent acting as the model must be given to record one sample — exactly what the
 * platform sends the model: the prompt's instruction as the system message, the step's fixed
 * input as the one user message, the sample attached to it, and the schema the answer is held
 * to — and where its answer is saved, in the shape `test/recordings.ts` loads. Each agent sees
 * its block and nothing else: not `expected.json`, not this repository.
 *
 * Each sample is recorded twice, by two agents blind to each other: read 1 (`extract`, the
 * default) and, with `--read 2`, read 2 (`verify-read`), whose answer goes in its own directory.
 * The read-2 agent is never shown read 1's recording, as `verify-read` is never shown read 1.
 *
 *   npx tsx automations/invoice-processing/scripts/recording-request.ts [--json] [--read 1|2] [sample ...]
 */

const args = process.argv.slice(2);
const at = args.indexOf('--read');
const which = at === -1 ? '1' : args[at + 1];
if (which !== '1' && which !== '2') {
  console.error('--read takes 1 (extract-document) or 2 (verify-document)');
  process.exit(2);
}
const read = which === '2' ? SECOND_READ : FIRST_READ;
const names = args.filter((arg, index) => arg !== '--json' && index !== at && index !== at + 1);
const unknown = names.filter((name) => !SAMPLES.some((sample) => sample.name === name));
if (unknown.length > 0) {
  const known = SAMPLES.map((sample) => sample.name).join(', ');
  console.error(`no such sample: ${unknown.join(', ')}; the samples: ${known}`);
  process.exit(2);
}
const requests = SAMPLES.filter((sample) => names.length === 0 || names.includes(sample.name)).map(
  (sample) => recordingRequest(sample, read),
);

if (args.includes('--json')) {
  console.log(JSON.stringify(requests, null, 2));
} else {
  const blind =
    read === SECOND_READ
      ? `DO NOT READ test/samples/${'<sample>'}/expected.json, any recording under test/recordings/, or anything else in the repository.`
      : '';
  for (const [index, each] of requests.entries()) {
    console.log(
      [
        `=== ${index + 1}/${requests.length} ${each.sample} (prompt ${read.prompt.id} v${read.prompt.version}) ===`,
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
        blind === ''
          ? `DO NOT READ test/samples/${each.sample}/expected.json or anything else in the repository.`
          : blind.replace('<sample>', each.sample),
        '',
      ].join('\n'),
    );
  }
}
