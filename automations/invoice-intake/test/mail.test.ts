import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { buildGmailRaw } from '../src/mail.js';

function decodeMessage(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

function header(message: string, name: string): string {
  const headers = message.split('\r\n\r\n', 1)[0]!.replace(/\r\n[ \t]+/gu, ' ');
  const line = headers
    .split('\r\n')
    .find((candidate) => candidate.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  assert.ok(line, `${name} header is present`);
  return line.slice(line.indexOf(':') + 1).trim();
}

function decodeSubject(value: string): string {
  const expression = /=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/giu;
  const words = [...value.matchAll(expression)];
  assert.ok(words.length > 0, 'the subject uses RFC 2047 encoded words');
  assert.equal(value.replace(expression, '').trim(), '', 'nothing sits outside encoded words');
  return words.map((match) => Buffer.from(match[1]!, 'base64').toString('utf8')).join('');
}

test('a non-ASCII subject survives the Gmail and RFC 2047 round trip', () => {
  const subject = 'Invoice INV-東京-004 — Café de l’Été was approved for intake';
  const body = 'Crème & Co.\nAmount: $125.50';
  const message = decodeMessage(buildGmailRaw({ to: 'ap@example.com', subject, body }));

  assert.equal(decodeSubject(header(message, 'Subject')), subject);
  assert.match(message, /\r\nMIME-Version: 1\.0\r\n/u);
  assert.match(message, /\r\nContent-Type: text\/plain; charset=UTF-8\r\n/u);
  assert.match(message, /\r\nContent-Transfer-Encoding: base64\r\n/u);

  const encodedBody = message.split('\r\n\r\n')[1]!;
  assert.equal(
    Buffer.from(encodedBody.replace(/\r\n/gu, ''), 'base64').toString('utf8'),
    'Crème & Co.\r\nAmount: $125.50',
  );
  for (const word of header(message, 'Subject').split(' ')) {
    assert.ok(word.length <= 75, `RFC 2047 encoded word is too long: ${word.length}`);
  }
});

test('mailbox header injection is refused and a subject is kept to one line', () => {
  assert.throws(
    () =>
      buildGmailRaw({
        to: 'ap@example.com\r\nBcc: outside@example.com',
        subject: 'Invoice',
        body: 'Body',
      }),
    /single ASCII mailbox address/u,
  );

  const message = decodeMessage(
    buildGmailRaw({
      to: 'ap@example.com',
      subject: 'Invoice received\r\nInjected header',
      body: 'Body',
    }),
  );
  assert.equal(decodeSubject(header(message, 'Subject')), 'Invoice received Injected header');
  assert.ok(!message.includes('\r\nInjected header:'), 'subject text cannot become a header');
});
