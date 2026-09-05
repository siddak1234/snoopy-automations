import { Buffer } from 'node:buffer';

/**
 * A deliberately small RFC mail builder for Gmail's `messages.send` operation.
 *
 * The complete message is base64url encoded for Gmail. That outer encoding does
 * not declare how a mail reader should interpret a header, so the Subject is also
 * encoded as RFC 2047 UTF-8 encoded words and the body declares its charset.
 */

export interface PlainTextMail {
  to: string;
  subject: string;
  body: string;
}

/** 42 UTF-8 bytes become 56 base64 characters: a folded encoded word stays short. */
const SUBJECT_CHUNK_BYTES = 42;
const BODY_LINE_LENGTH = 76;
const MAILBOX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u;

/** Builds the `raw` value accepted by Gmail's send API. */
export function buildGmailRaw(mail: PlainTextMail): string {
  const to = safeAddress(mail.to);
  const subject = oneLineSubject(mail.subject);
  const encodedBody = fold(
    Buffer.from(canonicalLines(mail.body), 'utf8').toString('base64'),
    BODY_LINE_LENGTH,
  );
  const message = [
    `To: ${to}`,
    subjectHeader(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedBody,
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

function safeAddress(value: string): string {
  const address = value.trim();
  if (!isMailboxAddress(address)) {
    throw new Error('to must be a single ASCII mailbox address');
  }
  return address;
}

/** A single, header-safe mailbox. Gmail performs the final address validation. */
export function isMailboxAddress(value: string): boolean {
  const address = value.trim();
  return address.length <= 320 && MAILBOX.test(address);
}

function oneLineSubject(value: string): string {
  const subject = value.replace(/[\r\n]+/gu, ' ').trim();
  if (subject === '') throw new Error('subject must be a non-empty line');
  return subject;
}

/** Encodes and folds without ever cutting through a UTF-8 code point. */
function subjectHeader(subject: string): string {
  const chunks: string[] = [];
  let chunk = '';
  for (const point of subject) {
    if (chunk !== '' && Buffer.byteLength(chunk + point, 'utf8') > SUBJECT_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = point;
    } else {
      chunk += point;
    }
  }
  if (chunk !== '') chunks.push(chunk);

  const words = chunks.map((part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
  return [`Subject: ${words[0]!}`, ...words.slice(1).map((word) => ` ${word}`)].join('\r\n');
}

function canonicalLines(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, '\n').replace(/\n/gu, '\r\n');
}

function fold(value: string, width: number): string {
  const lines: string[] = [];
  for (let start = 0; start < value.length; start += width) {
    lines.push(value.slice(start, start + width));
  }
  return lines.join('\r\n');
}
