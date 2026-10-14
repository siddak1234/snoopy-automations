import {
  mailCertainlyNotSent,
  type InvokeRequest,
  type JsonObject,
  type Step,
} from '@autom8x/automation-sdk';

import { runResult, type RunOutcome } from '../output.js';
import { mailOf, type Mail } from '../writes/mail.js';

/**
 * `notify` — the optional email (v2's §3.F): only when the flow's "Also email" setting holds an
 * address, and skipped, unreported, when it is empty. One plain-text mail through the platform's
 * mail callback, from its own address, to that one address — which the platform refuses inside the
 * workspace: owners and admins already get its own notice. It says what Invoice Processing did —
 * recorded, saved, or compared — and the run's details (`src/writes/mail.ts`).
 *
 * A mail that fails never fails the run — the work stands — so the step ends failed WITHOUT a
 * failure reason. No retry: the step catches its own failure. Line (§3.E): `Summary emailed`.
 */

/** The "Also email" address, trimmed, or nothing. */
function addressOf(config: JsonObject): string | undefined {
  const value = config.notifyEmail;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The mail for what the run did — its result — or undefined when it holds none to tell of. */
function mailFor(state: JsonObject, request: InvokeRequest): Mail | undefined {
  let result: RunOutcome;
  try {
    result = runResult(state, request);
  } catch {
    return undefined;
  }
  return mailOf(result.mail, result.details);
}

export function notify(): Step {
  return async ({ request, state, platform }) => {
    const to = addressOf(request.config);
    if (to === undefined) return { outcome: 'skipped' };
    const mail = mailFor(state, request);
    if (!mail) return { outcome: 'failed', summary: 'Summary not emailed' };
    try {
      await platform.sendMail({ to, subject: mail.subject, body: mail.body });
    } catch (error) {
      return {
        outcome: 'failed',
        summary: mailCertainlyNotSent(error)
          ? 'Summary not emailed'
          : 'Summary may have been emailed',
      };
    }
    return { outcome: 'ok', summary: 'Summary emailed' };
  };
}
