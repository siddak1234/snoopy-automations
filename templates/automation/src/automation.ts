import { fileURLToPath } from 'node:url';

import {
  defineAutomation,
  held,
  loadPrompts,
  readJsonCompletion,
  truncateText,
  type Automation,
  type InvokeRequest,
  type JsonObject,
  type Manifest,
  type Step,
} from '@autom8x/automation-sdk';

/**
 * The template automation. Copy `templates/automation` to `automations/<id>`,
 * replace `example` with your templateId everywhere, and change the steps.
 *
 * It has the shape the platform's first real automation needs (its BUILD-PLAN
 * 25.4.1): it reads the file its run was given, extracts with a model call through
 * a versioned prompt, ends held above a configured threshold, acts on the provider
 * through the provider callback, and sends its outcome from the platform.
 */
export const TEMPLATE_ID = 'example';

/** The prompts this automation ships: `prompts/*.json` beside `src/`, in the image too. */
const prompts = loadPrompts(fileURLToPath(new URL('../prompts/', import.meta.url)));
const extractFields = prompts.find(
  (prompt) => prompt.id === 'extract-fields' && prompt.version === 1,
);
if (!extractFields) throw new Error('prompts/extract-fields.v1.json is missing');

/** The most of a document the model is handed, in characters. */
const MAXIMUM_DOCUMENT_LENGTH = 20_000;

const receive: Step = async ({ request, platform }) => {
  const reference =
    typeof request.input.reference === 'string' ? request.input.reference.trim() : '';
  if (reference === '') {
    return {
      outcome: 'failed',
      summary: 'The run named no document',
      failureReason: 'input must carry a reference',
    };
  }
  const artifactId = request.input.artifactId;
  if (typeof artifactId !== 'string' || artifactId.trim() === '') {
    return { outcome: 'ok', summary: `Received ${reference}`, state: { reference, document: '' } };
  }
  // By reference: the platform answers with a short-lived link and the bytes come
  // straight from the store. The link never reaches a summary.
  const artifact = await platform.readArtifact(artifactId.trim());
  const bytes = await platform.readArtifactBytes(artifact);
  const document = truncateText(new TextDecoder().decode(bytes), MAXIMUM_DOCUMENT_LENGTH);
  return {
    outcome: 'ok',
    summary: `Received ${reference}, with ${artifact.filename} (${bytes.byteLength} bytes)`,
    state: { reference, document },
  };
};

const extract: Step = async ({ state, platform }) => {
  // The document travels as the model's INPUT; the prompt is rendered from the
  // reference alone. The completion is parsed without ever quoting it.
  const completion = await platform.callModel(extractFields, {
    reference: String(state.reference ?? ''),
    document: String(state.document ?? ''),
  });
  const fields = readJsonCompletion(completion);
  const vendor = typeof fields.vendor === 'string' ? fields.vendor.trim() : '';
  const amount = fields.amount;
  if (vendor === '' || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return {
      outcome: 'failed',
      summary: 'The model did not return the fields the schema asked for',
      failureReason: 'the extraction did not yield a vendor and an amount',
    };
  }
  return {
    outcome: 'ok',
    summary: `Extracted ${vendor}, ${format(amount)}`,
    state: { reference: state.reference, vendor, amount },
  };
};

const review: Step = async ({ request, state }) => {
  const amount = typeof state.amount === 'number' ? state.amount : NaN;
  if (!Number.isFinite(amount)) return malformedState();
  const threshold = readThreshold(request.config);
  if (amount > threshold) {
    return held({
      summary: `Amount ${format(amount)} is above the ${format(threshold)} threshold`,
      heldReason: 'Someone should approve this before it is recorded',
      reason: `${String(state.vendor)} — ${format(amount)}, above the ${format(threshold)} threshold`,
      state: { ...state, threshold },
    });
  }
  return {
    outcome: 'ok',
    summary: `Amount ${format(amount)} is within the ${format(threshold)} threshold`,
  };
};

const act: Step = async ({ request, state, platform }) => {
  if (typeof state.reference !== 'string' || typeof state.amount !== 'number')
    return malformedState();
  // The platform attaches the workspace's grant and this step's idempotency key:
  // a re-run of this step never records the document twice.
  const answer = await platform.callProvider({
    providerId: 'example-provider',
    operation: 'records.create',
    input: { reference: state.reference, vendor: state.vendor, amount: state.amount },
  });
  if (answer.status < 200 || answer.status >= 300) {
    return {
      outcome: 'failed',
      summary: `The provider refused the record with ${answer.status}`,
      failureReason: `the provider refused the record with ${answer.status}`,
    };
  }
  return {
    outcome: 'ok',
    summary: `Recorded ${state.reference} ${decisionOf(request)}`,
    state: { ...state, recorded: true },
  };
};

const notify: Step = async ({ request, state, platform }) => {
  const to =
    typeof request.config.notifyEmail === 'string' ? request.config.notifyEmail.trim() : '';
  if (to === '') return { outcome: 'skipped' };
  try {
    await platform.sendMail({
      to,
      subject: truncateText(
        `${String(state.reference)} — ${format(Number(state.amount))} ${decisionOf(request)}`,
        200,
      ),
      body: [
        `${String(state.reference)} from ${String(state.vendor)}`,
        `Amount: ${format(Number(state.amount))}`,
        `Outcome: recorded ${decisionOf(request)}`,
      ].join('\n'),
    });
  } catch {
    // Visible, and the run goes on: the record is made whether or not the notice went.
    return {
      outcome: 'failed',
      summary: `The outcome of ${String(state.reference)} could not be emailed`,
    };
  }
  return { outcome: 'ok', summary: `Emailed the outcome of ${String(state.reference)}` };
};

export function define(manifests: readonly Manifest[]): Automation {
  return defineAutomation({
    templateId: TEMPLATE_ID,
    manifests,
    prompts,
    steps: { receive, extract, review, act, notify },
    result: (state, request) => ({
      output: {
        reference: state.reference,
        vendor: state.vendor,
        amount: state.amount,
        decidedBy: decisionOf(request),
        recorded: state.recorded === true,
      },
      summary: `Recorded ${String(state.reference)} ${decisionOf(request)}`,
    }),
  });
}

function decisionOf(request: InvokeRequest): string {
  return request.continuation ? 'after approval' : 'automatically, within threshold';
}

function malformedState(): { outcome: 'failed'; summary: string; failureReason: string } {
  return {
    outcome: 'failed',
    summary: 'The run state did not carry the extracted fields',
    failureReason: 'the run state did not carry the extracted fields',
  };
}

function readThreshold(config: JsonObject): number {
  const configured = config.holdAboveAmount;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? configured
    : 500;
}

function format(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
