import {
  CallbackRefusedError,
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
} from '@autom8x/automation-sdk';

export const TEMPLATE_ID = 'invoice-intake';

/**
 * Invoice intake on the step runner.
 *
 * A verified webhook delivery carrying `vendor`, `amount` and `reference` starts a
 * run; the public webhook, its secret and delivery replay all belong to the
 * platform. The pipeline the manifest declares — `receive`, `validate`, `notify` —
 * is what runs, in that order, for every version this container serves. An
 * invoice above the workspace's threshold ends its first run held at `validate`;
 * the approval's continuation resumes at `notify` from the returned state.
 *
 * The vendor is told THROUGH THE PLATFORM, from automations@autom8x.ai (platform
 * ADR-0021, its BUILD-PLAN 13.4.4, §12.1 #231): the `notify` step sends through
 * the mail callback and names no mailbox and no account. The RFC 822 construction
 * and the `gmail.send` provider call this automation once carried are gone.
 */

interface Invoice {
  vendor: string;
  amount: number;
  reference: string;
}

type Decision = 'automatically, within threshold' | 'after approval';

const receive: Step = async ({ request }) => {
  const invoice = readWebhookInvoice(request.input);
  if (!invoice) {
    return {
      outcome: 'failed',
      summary: 'The webhook payload was not an invoice',
      failureReason: 'webhook payload must carry vendor, amount, and reference',
    };
  }
  return {
    outcome: 'ok',
    summary: `Received invoice ${invoice.reference} from ${invoice.vendor}`,
    state: { invoice: { ...invoice } },
  };
};

const validate: Step = async ({ request, state }) => {
  const invoice = invoiceIn(state);
  if (!invoice) return noInvoice('received');
  const threshold = readThreshold(request.config);
  if (invoice.amount > threshold) {
    return held({
      summary: `Amount ${formatAmount(invoice.amount)} is above the ${formatAmount(threshold)} threshold`,
      heldReason: 'Someone should approve this invoice before its intake notice is sent',
      reason: `${invoice.vendor} — ${formatAmount(invoice.amount)}, above the ${formatAmount(threshold)} threshold`,
      state: { invoice: { ...invoice } },
    });
  }
  return {
    outcome: 'ok',
    summary: `Amount ${formatAmount(invoice.amount)} is within the ${formatAmount(threshold)} threshold`,
  };
};

/**
 * The notice is sent after intake, and its failure is visible without undoing the
 * intake: a failed `notify` step, `notified: false`, and a successful run.
 */
const notify: Step = async ({ request, state, platform }) => {
  const invoice = invoiceIn(state);
  if (!invoice) return noInvoice('approved');
  const decision = decisionOf(request);
  const to = readNotifyEmail(request.config);
  if (!to) {
    return {
      outcome: 'failed',
      summary: 'The notification address is not configured',
      state: { ...state, notified: false },
    };
  }
  try {
    await platform.sendMail({
      to,
      subject: oneLineSubject(
        `Invoice ${invoice.reference} — ${formatAmount(invoice.amount)} ${decision}`,
      ),
      body: [
        `Invoice ${invoice.reference} from ${invoice.vendor}`,
        `Amount: ${formatAmount(invoice.amount)}`,
        `Outcome: accepted ${decision}`,
      ].join('\n'),
    });
  } catch (error) {
    return {
      outcome: 'failed',
      summary: notifyFailure(error),
      state: { ...state, notified: false },
    };
  }
  return {
    outcome: 'ok',
    summary: `Emailed the intake outcome of ${invoice.reference}`,
    state: { ...state, notified: true },
  };
};

/**
 * One line for the timeline. A refusal the platform decided before the transport
 * is certain and names its reason; an answer that never came is not — the platform
 * keeps its reservation and this side never retries, so nobody should re-send.
 */
function notifyFailure(error: unknown): string {
  if (mailCertainlyNotSent(error)) {
    const reason = error instanceof CallbackRefusedError && error.reason ? `: ${error.reason}` : '';
    return `The platform refused the intake notice${reason}`;
  }
  return 'The intake notice could not be emailed; it may have been sent — do not re-send by hand';
}

/** The versions this container serves, read from `manifests/`, and the pipeline they declare. */
export function define(manifests: readonly Manifest[]): Automation {
  return defineAutomation({
    templateId: TEMPLATE_ID,
    manifests,
    steps: { receive, validate, notify },
    result: (state, request) => {
      const invoice = invoiceIn(state);
      if (!invoice) throw new Error('the run state did not carry an invoice');
      const decision = decisionOf(request);
      return {
        output: {
          reference: invoice.reference,
          vendor: invoice.vendor,
          amount: invoice.amount,
          decidedBy: decision,
          // True only when the platform ACCEPTED the notice; false covers a refusal
          // and an answer that never came — the step's summary says which.
          notified: state.notified === true,
        },
        summary: `Accepted invoice ${invoice.reference} ${decision}`,
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

function noInvoice(which: 'received' | 'approved') {
  return {
    outcome: 'failed' as const,
    summary: `The ${which} state did not carry an invoice`,
    failureReason: `the ${which} state did not carry an invoice`,
  };
}

function readWebhookInvoice(input: JsonObject): Invoice | null {
  const trigger = input.trigger;
  if (!isObject(trigger) || trigger.kind !== 'webhook' || !isObject(input.payload)) return null;
  return readInvoice(input.payload);
}

function readInvoice(input: JsonObject): Invoice | null {
  const vendor = boundedText(input.vendor, 120);
  const reference = boundedText(input.reference, 80);
  const amount = input.amount;
  if (
    !vendor ||
    !reference ||
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount < 0
  ) {
    return null;
  }
  return { vendor, amount, reference };
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text !== '' && text.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(text)
    ? text
    : null;
}

/** A single header-safe mailbox; the platform performs the final validation. */
const MAILBOX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u;

function readNotifyEmail(config: JsonObject): string | null {
  const configured = config.notifyEmail;
  if (typeof configured !== 'string') return null;
  const address = configured.trim();
  return address.length <= 254 && MAILBOX.test(address) ? address : null;
}

function readThreshold(config: JsonObject): number {
  const configured = config.holdAboveAmount;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? configured
    : 500;
}

/** One line, bounded — what the platform's mail callback accepts as a subject. */
function oneLineSubject(text: string): string {
  return truncateText(text.replace(/[\r\n]+/gu, ' ').trim(), MAIL_SUBJECT_MAX_LENGTH);
}

function formatAmount(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
