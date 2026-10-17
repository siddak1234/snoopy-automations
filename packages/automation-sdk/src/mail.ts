/* --- the sixth callback: mail --------------------------------------------- */

/**
 * One outbound mail the PLATFORM sends from its own identity (its ADR-0021) —
 * the sixth callback, `POST /v1/automations/callbacks/mail`. The automation names
 * a recipient and the words; the platform applies the self-send refusal, the
 * per-run and per-workspace caps and the sending address, and answers
 * `{ mail: { accepted: true } }` with nothing about transport, so an automation
 * cannot start branching on a third party's status codes.
 *
 * Held to the platform's published `automation-mail-request.json`, vendored in
 * `contract/schemas`: `to`, `subject`, `body` and `idempotencyKey` and nothing else — `runId`,
 * optional in the handler's allow-list, is not in the schema and is never sent. The schema's
 * second form, a run's results (its ADR-0039), is not sent from here: the platform mails each
 * run's results itself, to the people it picks (the owner's AM3, 2026-10-15), so no automation
 * names a recipient for them.
 */
export interface MailRequest {
  /** A single ASCII mailbox address, at most 254 characters. The platform validates it. */
  to: string;
  /** One line, at most `MAIL_SUBJECT_MAX_LENGTH`; a line break is refused, not stripped. */
  subject: string;
  /** Plain text, at most `MAIL_BODY_MAX_LENGTH`. */
  body: string;
  /** 16–128 characters, stable for the step: a retried step sends one mail, not two. */
  idempotencyKey: string;
}

/** A mail as a step names it: the runner attaches the step's key. */
export type MailContent = Omit<MailRequest, 'idempotencyKey'>;

/** The platform's own bounds on a mail, copied from its handler by rule. */
export const MAIL_SUBJECT_MAX_LENGTH = 200;
export const MAIL_BODY_MAX_LENGTH = 10_000;
