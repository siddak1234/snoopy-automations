import {
  MAIL_SUBJECT_MAX_LENGTH,
  defineAutomation,
  held,
  isObject,
  mailCertainlyNotSent,
  truncateText,
  type Automation,
  type InvokeRequest,
  type JsonObject,
  type Manifest,
  type Step,
  type StepPlatform,
} from '@autom8x/automation-sdk';

export const TEMPLATE_ID = 'invoice-check';

/**
 * Invoice check — the platform's first automation, moved here from the platform
 * repository on 2026-10-08 (its BUILD-PLAN 25.3.8, D8) and ported to the SDK.
 *
 * It checks a submitted invoice against a threshold the workspace configured and
 * holds for a person when the amount is above it. Chosen because it needs no
 * provider and no model — so it can go live the moment it is subscribed — while
 * still exercising the one path that is hard to get right: a run that ends held,
 * and a continuation that picks the work back up days later.
 *
 * One container serves v1 to v4. v1 declares `receive`, `validate`, `post`; v2 and
 * later add `notify`, and the runner runs the pipeline of the version the run
 * pinned, so a v1 run never reaches `notify`. Every version this container accepts
 * emails through the PLATFORM (its ADR-0021): v2's `gmail.send` connection is
 * declared by an immutable registered manifest and is never spent here.
 *
 * The result's summary — `Recorded <reference> <how>` — is bounded by the SDK to
 * the platform's one-line limit before it is sent, so a long reference no longer
 * fails a run the automation has already recorded (platform §12.1 #220).
 */

/** Per trigger-supplied field, so the assembled mail cannot approach the platform's bound. */
const MAXIMUM_FIELD_LENGTH = 1_000;

interface Invoice {
  vendor: string;
  amount: number;
  reference: string;
}

type Decision = 'automatically, within threshold' | 'after approval';

const receive: Step = async ({ request, platform }) => {
  const invoice = readInvoice(request.input);
  if (!invoice) {
    return {
      outcome: 'failed',
      summary: 'The trigger payload was not an invoice',
      failureReason: 'input must carry vendor, amount, and reference',
    };
  }
  // The file this run was given, if it was given one. By reference: the platform
  // answers with a short-lived link and the bytes come straight from the store, so
  // they never travel through the Edge and no store credential exists here.
  const attached = await readAttachment(request.input, platform);
  return {
    outcome: 'ok',
    // One line for the timeline. Never the document, and never the link — the
    // link is a credential for as long as it lives.
    summary: attached
      ? `Invoice ${invoice.reference} from ${invoice.vendor}, with ${attached.filename} (${attached.sizeBytes} bytes)`
      : `Invoice ${invoice.reference} from ${invoice.vendor}`,
    state: { invoice: { ...invoice } },
  };
};

const validate: Step = async ({ request, state }) => {
  const invoice = invoiceIn(state);
  if (!invoice) return noInvoice();
  const threshold = readThreshold(request.config);
  if (invoice.amount > threshold) {
    // The run ENDS here. This process is free to exit; the state below is what
    // comes back if a person approves.
    return held({
      summary: `Amount ${format(invoice.amount)} is above the ${format(threshold)} threshold`,
      heldReason: 'Someone should approve this before it is posted',
      reason: `${invoice.vendor} — ${format(invoice.amount)}, above the ${format(threshold)} threshold`,
      state: { invoice: { ...invoice }, threshold },
    });
  }
  return {
    outcome: 'ok',
    summary: `Amount ${format(invoice.amount)} is within the ${format(threshold)} threshold`,
  };
};

const post: Step = async ({ request, state }) => {
  const invoice = invoiceIn(state);
  if (!invoice) return noInvoice();
  return { outcome: 'ok', summary: `Recorded ${invoice.reference} ${decisionOf(request)}` };
};

/**
 * Emails the outcome through the platform — the only sender there is (ADR-0021) —
 * when an address is configured; with none, nothing is reported (v1 declares no
 * `notifyEmail` field, and the platform refuses an undeclared step).
 *
 * The step is reported once, with the outcome the platform actually gave. A refusal
 * decided before the transport is CERTAIN and `notified` is false; an answer that
 * never came is UNKNOWN — the platform keeps its reservation and this side never
 * retries, so a person must not re-send by hand — and `notified` is omitted rather
 * than set to a value that contradicts the sentence beside it (platform §12.1 #121).
 */
const notify: Step = async ({ request, state, platform }) => {
  const invoice = invoiceIn(state);
  if (!invoice) return noInvoice();
  const to = readNotifyEmail(request.config);
  if (!to) return { outcome: 'skipped' };
  const how = decisionOf(request);
  try {
    await platform.sendMail({
      to,
      subject: subjectLine(
        `Invoice ${truncateText(invoice.reference, MAXIMUM_FIELD_LENGTH)} — ${format(invoice.amount)} ${how}`,
      ),
      body: mailBody(invoice, how),
    });
  } catch (error) {
    const certain = mailCertainlyNotSent(error);
    const why = certain
      ? describe(error)
      : 'the platform did not answer; the mail may have been sent — do not re-send by hand';
    const { notified: _unknown, ...rest } = state;
    return {
      outcome: 'failed',
      summary: `The outcome of ${invoice.reference} could not be emailed: ${why}`,
      state: certain ? { ...rest, notified: false } : rest,
    };
  }
  return {
    outcome: 'ok',
    summary: `Emailed the outcome of ${invoice.reference}`,
    state: { ...state, notified: true },
  };
};

/** The versions this container serves, read from `manifests/`, and the pipeline each declares. */
export function define(manifests: readonly Manifest[]): Automation {
  return defineAutomation({
    templateId: TEMPLATE_ID,
    manifests,
    steps: { receive, validate, post, notify },
    result: (state, request) => {
      const invoice = invoiceIn(state);
      if (!invoice) throw new Error('the run state did not carry an invoice');
      const how = decisionOf(request);
      return {
        output: {
          reference: invoice.reference,
          vendor: invoice.vendor,
          amount: invoice.amount,
          decidedBy: how,
          ...(typeof state.notified === 'boolean' ? { notified: state.notified } : {}),
        },
        // The line a person reads on a list without opening the run: the invoice
        // and what happened to it, nothing else — the amount and the vendor are in
        // `output`, behind the run, where the workspace's own access control applies.
        summary: `Recorded ${invoice.reference} ${how}`,
      };
    },
  });
}

/** A continuation exists only because a person approved (FR-17). */
function decisionOf(request: InvokeRequest): Decision {
  return request.continuation ? 'after approval' : 'automatically, within threshold';
}

function invoiceIn(state: JsonObject): Invoice | null {
  return readInvoice(isObject(state.invoice) ? state.invoice : {});
}

/** The state came back malformed, which means this automation wrote it wrong. Guessing would post something nobody approved. */
function noInvoice() {
  return {
    outcome: 'failed' as const,
    summary: 'The run state did not carry an invoice',
    failureReason: 'the approved state did not carry an invoice',
  };
}

/** One line, bounded — what the platform's mail callback accepts as a subject. */
function subjectLine(text: string): string {
  return truncateText(text.replace(/[\r\n]+/gu, ' '), MAIL_SUBJECT_MAX_LENGTH);
}

/**
 * The mail's text, every line present. The trigger supplies `vendor` and
 * `reference` unbounded, so THEY are truncated rather than the assembled message:
 * cutting the finished text from the end would drop the outcome line — the one
 * fact the mail exists to carry.
 */
function mailBody(invoice: Invoice, how: Decision): string {
  return [
    `Invoice ${truncateText(invoice.reference, MAXIMUM_FIELD_LENGTH)} from ${truncateText(invoice.vendor, MAXIMUM_FIELD_LENGTH)}`,
    `Amount: ${format(invoice.amount)}`,
    `Outcome: recorded ${how}`,
  ].join('\n');
}

/** The configured address, or null when there is none. Its shape is the platform's to judge (platform §12.1 #118). */
function readNotifyEmail(config: JsonObject): string | null {
  const configured = config.notifyEmail;
  if (typeof configured !== 'string') return null;
  const trimmed = configured.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : 'unknown error';
}

/**
 * Reads the file this run was given, when it was given one. The size is measured
 * from the bytes this process actually read, not taken from the metadata.
 */
async function readAttachment(
  input: JsonObject,
  platform: StepPlatform,
): Promise<{ filename: string; sizeBytes: number } | null> {
  const named = input.artifactId;
  if (typeof named !== 'string' || named.trim() === '') return null;
  const artifact = await platform.readArtifact(named.trim());
  const bytes = await platform.readArtifactBytes(artifact);
  return { filename: artifact.filename, sizeBytes: bytes.byteLength };
}

function readInvoice(input: JsonObject): Invoice | null {
  const vendor = input.vendor;
  const amount = input.amount;
  const reference = input.reference;
  if (
    typeof vendor !== 'string' ||
    vendor.trim() === '' ||
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    typeof reference !== 'string' ||
    reference.trim() === ''
  ) {
    return null;
  }
  return { vendor: vendor.trim(), amount, reference: reference.trim() };
}

/** The platform validated `config` against the manifest; this copes only with the field being absent. */
function readThreshold(config: JsonObject): number {
  const configured = config.holdAboveAmount;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? configured
    : 500;
}

function format(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
