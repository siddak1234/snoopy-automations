import { fileURLToPath } from 'node:url';

import {
  boundedBlocks,
  FLOW_WORDS,
  defineFlow,
  failed,
  held,
  loadPrompts,
  quotesIn,
  readJsonCompletion,
  settle,
  truncateText,
  type Automation,
  type EmittedBlock,
  type InvokeRequest,
  type JsonObject,
  type Manifest,
  type Step,
} from '@autom8x/automation-sdk';

/**
 * The template automation, on `defineFlow` (Round 21): the SDK's standards are on — a throw ends
 * the run in plain words, an answer off its schema is asked once more and then ends in plain
 * words, the step retry's waits are spread — and each risky call goes through `settle`. A new flow is not
 * copied from here by hand: `npm run scaffold -- <id>` writes its frame from its manifest (README,
 * "Build a flow"); this file is the worked example of the steps a developer then writes.
 *
 * It has the shape the platform's first real automation needs (its BUILD-PLAN
 * 25.4.1): it reads the file its run was given, extracts with a model call through
 * a versioned prompt, ends held above a configured threshold, acts on the provider
 * through the provider callback, and sends its outcome from the platform. The
 * models the extraction asks for are `MODELS`, beside the step (README, "Pick a
 * model"). What a person reads of a run is its summary and its `blocks`
 * (`readout`, below), which the platform draws on the run's page.
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

/** The template's own sentences — a flow's are its spec's §8, in its `words.md` too. */
export const WORDS = {
  noReference: 'The run named no document.',
  noFields: "The vendor and the amount can't be read. Try a clearer file.",
  checkVendor: "The vendor's name isn't on the document. Someone should check it.",
  bigAmount: 'Someone should approve this before it is recorded.',
} as const;

const receive: Step = async ({ request, platform }) => {
  const reference =
    typeof request.input.reference === 'string' ? request.input.reference.trim() : '';
  if (reference === '') return failed(WORDS.noReference, 'no_reference');
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

// Primary first, then up to two fallbacks by another maker, each with a US zero-retention
// endpoint (README, "Pick a model"), such as ['anthropic/claude-haiku-4.5',
// 'google/gemini-3.1-flash-lite'], both qualifying on 2026-10-10.
export const MODELS: readonly string[] | undefined = undefined; // the platform's default

const extract: Step = async (context) => {
  const { state, platform } = context;
  // The document travels as the model's INPUT; the prompt is rendered from the reference alone.
  // `defineFlow` asks once more when the answer misses its schema (Q2) — one to three more paid AI
  // calls — and a second miss ends "The AI's answer couldn't be used.": `review` cannot go on
  // without the vendor and the amount, and an approval carries none, so the template names no
  // step in `holdUnmatched`. `settle` words the rest.
  const asked = await settle(context, () =>
    platform.callModel(
      extractFields,
      { reference: String(state.reference ?? ''), document: String(state.document ?? '') },
      MODELS,
    ),
  );
  if (!asked.ok) return failed(asked.sentence, asked.kind);
  const fields = readJsonCompletion(asked.value);
  const vendor = typeof fields.vendor === 'string' ? fields.vendor.trim() : '';
  const amount = fields.amount;
  if (vendor === '' || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return failed(WORDS.noFields, 'no_fields');
  }
  return {
    outcome: 'ok',
    summary: `Extracted ${vendor}, ${format(amount)}`,
    state: { reference: state.reference, document: state.document, vendor, amount },
  };
};

const review: Step = async ({ request, state }) => {
  const amount = typeof state.amount === 'number' ? state.amount : NaN;
  if (!Number.isFinite(amount)) return malformedState();
  const { document, ...kept } = state;
  // Q1: a vendor the document does not print, word for word, is one a person checks.
  const text = typeof document === 'string' ? document : '';
  if (text !== '' && quotesIn(text, { vendor: state.vendor }).length > 0) {
    return held({
      summary: WORDS.checkVendor,
      heldReason: WORDS.checkVendor,
      state: kept,
    });
  }
  const threshold = readThreshold(request.config);
  if (amount > threshold) {
    return held({
      summary: `Amount ${format(amount)} is above the ${format(threshold)} threshold`,
      heldReason: WORDS.bigAmount,
      reason: `${String(state.vendor)} — ${format(amount)}, above the ${format(threshold)} threshold`,
      state: { ...kept, threshold },
    });
  }
  return {
    outcome: 'ok',
    summary: `Amount ${format(amount)} is within the ${format(threshold)} threshold`,
    state: kept,
  };
};

const act: Step = async (context) => {
  const { request, state, platform } = context;
  if (typeof state.reference !== 'string' || typeof state.amount !== 'number')
    return malformedState();
  // The platform attaches the workspace's grant and this step's idempotency key.
  // A re-run after the provider's final answer is answered from the platform's
  // record of it; a re-run after NO answer calls the provider again, which records
  // the document twice unless the vendor deduplicates on `Idempotency-Key` — so
  // this step declares no retry (README, "Retrying a step").
  // `settle` answers a refusal, a vendor's own non-2xx and a missing connection in the SDK's words.
  const sent = await settle(context, () =>
    platform.callProvider({
      providerId: 'example-provider',
      operation: 'records.create',
      input: { reference: state.reference, vendor: state.vendor, amount: state.amount },
    }),
  );
  if (!sent.ok) return failed(sent.sentence, sent.kind);
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
  return defineFlow({
    templateId: TEMPLATE_ID,
    manifests,
    prompts,
    steps: { receive, extract, review, act, notify },
    // No step declares a retry. `act` is a provider WRITE: a repeat after a call
    // that got no final answer is sent to the provider again, and none of the
    // platform's registered providers (Google, QuickBooks, Slack) is recorded as
    // deduplicating on `Idempotency-Key`.
    // `extract`: a repeated model call is a second vendor call and a second ledger
    // row. `notify` catches its own failure, so a policy there would never fire.
    // `receive` only reads, and is where a policy is safe:
    //   retry: { receive: { attempts: 2, backoffMs: 10_000 } },
    result: (state, request) => {
      const blocks = boundedBlocks(readout(state, request));
      return {
        output: {
          reference: state.reference,
          vendor: state.vendor,
          amount: state.amount,
          decidedBy: decisionOf(request),
          recorded: state.recorded === true,
        },
        summary: `Recorded ${String(state.reference)} ${decisionOf(request)}`,
        ...(blocks === undefined ? {} : { blocks }),
      };
    },
  });
}

/**
 * What a person reads of the run (platform ADR-0048): a figure and the fields it was recorded
 * with, in the order the page draws them. The vendor is a model's words, so `boundedBlocks` cuts
 * or leaves out what the platform would refuse — a long name cut whole, a tag-shaped one left
 * empty — rather than the whole result being refused.
 */
function readout(state: JsonObject, request: InvokeRequest): EmittedBlock[] {
  return [
    {
      type: 'metric',
      items: [
        { label: 'Amount', value: format(Number(state.amount)) },
        state.recorded === true
          ? { label: 'Recorded', value: 'Yes', tone: 'success' }
          : { label: 'Recorded', value: 'No', tone: 'warning' },
      ],
    },
    {
      type: 'table',
      columns: [{ title: 'Field' }, { title: 'Value' }],
      rows: [
        { cells: ['Reference', String(state.reference)] },
        { cells: ['Vendor', String(state.vendor)] },
        { cells: ['Decided', request.continuation ? 'After approval' : 'Automatically'] },
      ],
    },
  ];
}

function decisionOf(request: InvokeRequest): string {
  return request.continuation ? 'after approval' : 'automatically, within threshold';
}

function malformedState() {
  return failed(FLOW_WORDS.other, 'malformed_state');
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
