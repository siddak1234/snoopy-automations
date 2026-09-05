import { createHash } from 'node:crypto';

import {
  isObject,
  type AutomationPlatform,
  type InvokeRequest,
  type JsonObject,
  type RunResult,
} from '@autom8x/automation-sdk';

import { buildGmailRaw, isMailboxAddress } from './mail.js';

const STEP_RECEIVE = 'receive';
const STEP_VALIDATE = 'validate';
const STEP_NOTIFY = 'notify';
const AUTHENTICATED_USER = 'me';

interface Invoice {
  vendor: string;
  amount: number;
  reference: string;
}

type Decision = 'automatically, within threshold' | 'after approval';

/**
 * Receives the platform's webhook envelope, then holds or emails the invoice.
 *
 * The public webhook, its secret, and delivery replay all belong to the platform.
 * This service receives only the resulting run and calls back through the SDK.
 */
export async function execute(
  request: InvokeRequest,
  platform: AutomationPlatform,
): Promise<RunResult> {
  if (request.continuation?.kind === 'approval') {
    return finishApproved(request, platform, request.continuation.state);
  }

  const invoice = readWebhookInvoice(request.input);
  if (!invoice) {
    await platform.reportStep({
      runId: request.runId,
      stepId: STEP_RECEIVE,
      outcome: 'failed',
      summary: 'The webhook payload was not an invoice',
    });
    return {
      outcome: 'failed',
      failureReason: 'webhook payload must carry vendor, amount, and reference',
    };
  }

  await platform.reportStep({
    runId: request.runId,
    stepId: STEP_RECEIVE,
    outcome: 'ok',
    summary: `Received invoice ${invoice.reference} from ${invoice.vendor}`,
  });

  const threshold = readThreshold(request.config);
  if (invoice.amount > threshold) {
    await platform.reportStep({
      runId: request.runId,
      stepId: STEP_VALIDATE,
      outcome: 'held',
      summary: `Amount ${formatAmount(invoice.amount)} is above the ${formatAmount(threshold)} threshold`,
      heldReason: 'Someone should approve this invoice before its intake notice is sent',
    });
    return {
      outcome: 'held',
      held: {
        stepId: STEP_VALIDATE,
        reason: `${invoice.vendor} — ${formatAmount(invoice.amount)}, above the ${formatAmount(threshold)} threshold`,
        state: { invoice: { ...invoice } },
      },
    };
  }

  await platform.reportStep({
    runId: request.runId,
    stepId: STEP_VALIDATE,
    outcome: 'ok',
    summary: `Amount ${formatAmount(invoice.amount)} is within the ${formatAmount(threshold)} threshold`,
  });
  return notify(request, platform, invoice, 'automatically, within threshold');
}

async function finishApproved(
  request: InvokeRequest,
  platform: AutomationPlatform,
  state: JsonObject,
): Promise<RunResult> {
  if (request.continuation?.decision !== 'approved') {
    return { outcome: 'failed', failureReason: 'the approval continuation was not approved' };
  }
  const invoice = readInvoice(isObject(state.invoice) ? state.invoice : {});
  if (!invoice) {
    return { outcome: 'failed', failureReason: 'the approved state did not carry an invoice' };
  }
  return notify(request, platform, invoice, 'after approval');
}

/** Email is a notification after intake; its failure is visible but does not undo intake. */
async function notify(
  request: InvokeRequest,
  platform: AutomationPlatform,
  invoice: Invoice,
  decision: Decision,
): Promise<RunResult> {
  const to = readNotifyEmail(request.config);
  if (!to) {
    await reportNotifyFailure(request, platform, 'The notification address is not configured');
    return successfulIntake(invoice, decision, false);
  }

  const subject = `Invoice ${invoice.reference} — ${formatAmount(invoice.amount)} ${decision}`;
  const raw = buildGmailRaw({
    to,
    subject,
    body: [
      `Invoice ${invoice.reference} from ${invoice.vendor}`,
      `Amount: ${formatAmount(invoice.amount)}`,
      `Outcome: accepted ${decision}`,
    ].join('\r\n'),
  });

  try {
    const answer = await platform.callProvider({
      providerId: 'google',
      operation: 'messages.send',
      input: { userId: AUTHENTICATED_USER, raw },
      idempotencyKey: notificationKey(request.runId),
    });
    if (answer.status < 200 || answer.status >= 300) {
      await reportNotifyFailure(
        request,
        platform,
        `Google refused the intake notice with ${answer.status}`,
      );
      return successfulIntake(invoice, decision, false);
    }
  } catch {
    await reportNotifyFailure(request, platform, 'The intake notice could not be emailed');
    return successfulIntake(invoice, decision, false);
  }

  await platform.reportStep({
    runId: request.runId,
    stepId: STEP_NOTIFY,
    outcome: 'ok',
    summary: `Emailed the intake outcome of ${invoice.reference}`,
  });
  return successfulIntake(invoice, decision, true);
}

/** Stable and always inside the provider callback's published 16–128 bound. */
function notificationKey(runId: string): string {
  const runDigest = createHash('sha256').update(runId, 'utf8').digest('hex');
  return `invoice-intake-${runDigest}`;
}

function reportNotifyFailure(
  request: InvokeRequest,
  platform: AutomationPlatform,
  summary: string,
): Promise<void> {
  return platform.reportStep({
    runId: request.runId,
    stepId: STEP_NOTIFY,
    outcome: 'failed',
    summary,
  });
}

function successfulIntake(invoice: Invoice, decision: Decision, notified: boolean): RunResult {
  return {
    outcome: 'success',
    output: {
      reference: invoice.reference,
      vendor: invoice.vendor,
      amount: invoice.amount,
      decidedBy: decision,
      notified,
    },
    summary: `Accepted invoice ${invoice.reference} ${decision}`,
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

function readNotifyEmail(config: JsonObject): string | null {
  const configured = config.notifyEmail;
  if (typeof configured !== 'string') return null;
  const address = configured.trim();
  return isMailboxAddress(address) ? address : null;
}

function readThreshold(config: JsonObject): number {
  const configured = config.holdAboveAmount;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? configured
    : 500;
}

function formatAmount(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
