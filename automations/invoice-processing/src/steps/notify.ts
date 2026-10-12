import {
  CallbackRefusedError,
  mailCertainlyNotSent,
  type InvokeRequest,
  type JsonObject,
  type Step,
} from '@autom8x/automation-sdk';

import { recordMail, statementMail, type Mail } from '../writes/mail.js';
import { createdOf, newVendorOf, readSaved, statementOf } from '../writes/saved-state.js';

/**
 * `notify` (step 24) — the optional email (the plan's §5, "notify, per type"): only when the flow's
 * "Also email" setting holds an address, and skipped, unreported, when it is empty. One plain-text
 * mail through the platform's mail callback, from its own address, to that one address — which
 * the platform refuses inside the workspace: owners and admins already get its own "An automation
 * run completed" notice. A record's mail is built from QuickBooks' answer, with the next step; a
 * statement's has the counts and what QuickBooks shows open for the vendor (`src/writes/mail.ts`).
 *
 * A mail that fails never fails the run — the record stands — so the step ends failed WITHOUT a
 * failure reason: certainly not sent (a refusal decided before the transport), or perhaps sent
 * (no answer), in which case nobody should send it again by hand. Its line never carries the
 * address or the mail's words. No retry: the step catches its own failure.
 */

/** The "Also email" address, trimmed, or nothing. */
function addressOf(config: JsonObject): string | undefined {
  const value = config.notifyEmail;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The mail for what the run did, or undefined when it holds neither a record nor a statement. */
function mailOf(state: JsonObject, request: InvokeRequest): Mail | undefined {
  const statement = statementOf(state);
  if (statement) return statementMail(statement);
  const saved = readSaved(state);
  const created = createdOf(state);
  const newVendor = newVendorOf(state);
  if (!saved || !created || newVendor === undefined) return undefined;
  return recordMail(
    saved,
    created,
    newVendor,
    request.continuation ? 'after approval' : 'automatically',
  );
}

/** The platform's word for a refusal, or its status: never its sentence. */
function refusalOf(error: unknown): string {
  if (!(error instanceof CallbackRefusedError)) return 'no answer';
  const reason = error.reason;
  return reason !== undefined && /^[a-z][a-z0-9_]{0,63}$/u.test(reason)
    ? reason
    : `HTTP ${error.status}`;
}

export function notify(): Step {
  return async ({ request, state, platform }) => {
    const to = addressOf(request.config);
    if (to === undefined) return { outcome: 'skipped' };
    const mail = mailOf(state, request);
    if (!mail) {
      return { outcome: 'failed', summary: 'The summary was not emailed: nothing to summarise' };
    }
    try {
      await platform.sendMail({ to, subject: mail.subject, body: mail.body });
    } catch (error) {
      return {
        outcome: 'failed',
        summary: mailCertainlyNotSent(error)
          ? `The summary was not emailed: the platform refused it (${refusalOf(error)})`
          : 'The summary may have been emailed: the platform did not answer. Do not re-send it by hand.',
      };
    }
    return { outcome: 'ok', summary: 'Emailed the summary to the "Also email" address' };
  };
}
