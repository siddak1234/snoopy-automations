import { Buffer } from 'node:buffer';

import { isObject, type JsonObject } from '@autom8x/automation-sdk';

/**
 * A visit note's text, as a hook run reads it from the EHR (README, "v6", row 3): `text/plain` as
 * it is, `text/html` with its tags stripped, any other type skipped with its reason. The bounds
 * are the session's.
 */

/** The most notes one visit's hook run reads; the rest are skipped, each with its reason. */
export const NOTES_READ = 8;

/** The most characters of one note's text a read is sent: about 7,500 tokens. */
export const NOTE_CHARS = 30_000;

/** The types a note is read from, in the order one is picked among a note's attachments. */
export const NOTE_TYPES = ['text/plain', 'text/html'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** `Text/HTML; charset=UTF-8` → `text/html`; anything not shaped as a media type, `other`. */
export function mediaType(contentType: unknown): string {
  if (typeof contentType !== 'string') return '';
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,40}$/u.test(type) ? type : 'other';
}

/** The text an attachment's base64 `data` holds, in its charset: Latin-1 when it says so, else UTF-8. */
export function decoded(data: string, contentType: unknown): string {
  const latin = /charset\s*=\s*"?(?:iso-8859-1|latin1|windows-1252)/iu.test(String(contentType));
  return Buffer.from(data, 'base64').toString(latin ? 'latin1' : 'utf8');
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTML's character references: the five XML ones, `&nbsp;`, and every numeric one; others kept. */
function entities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith('#')) {
      const point =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * An HTML note's words: comments, `<head>`, `<script>` and `<style>` with their contents gone, a
 * line break for each break, paragraph, row, list item and heading, every other tag a space, the
 * character references read, and the blanks folded — a line at a time, never a word joined to the
 * next.
 */
export function htmlText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(head|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/table|\/ul|\/ol)\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ');
  return entities(stripped)
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n[\n ]*/gu, '\n')
    .trim();
}

/** A note's text from its type and its decoded content, or why it is skipped. */
export function noteText(
  contentType: unknown,
  raw: string,
): { text: string; cut: boolean } | { skip: string } {
  const type = mediaType(contentType);
  if (!(NOTE_TYPES as readonly string[]).includes(type)) return { skip: `type ${type || 'none'}` };
  const text = (type === 'text/html' ? htmlText(raw) : raw.replace(/\r\n?/gu, '\n')).trim();
  if (text === '') return { skip: 'empty' };
  return text.length > NOTE_CHARS
    ? { text: text.slice(0, NOTE_CHARS), cut: true }
    : { text, cut: false };
}

/**
 * The attachment a note is read from: its first `text/plain`, else its first `text/html` (Epic
 * may give one note in several types); none of either, the types it has, for the reason.
 */
export function pickAttachment(note: JsonObject): JsonObject | { skip: string } {
  const attachments = (Array.isArray(note.content) ? note.content : [])
    .map((content) =>
      isObject(content) && isObject(content.attachment) ? content.attachment : undefined,
    )
    .filter((one): one is JsonObject => one !== undefined);
  for (const type of NOTE_TYPES) {
    const found = attachments.find((one) => mediaType(one.contentType) === type);
    if (found !== undefined) return found;
  }
  if (attachments.length === 0) return { skip: 'no attachment' };
  const types = [...new Set(attachments.map((one) => mediaType(one.contentType) || 'none'))];
  return { skip: `type ${types.join(', ')}` };
}

/** The Binary id an attachment's `url` names (`Binary/{id}`, relative or absolute), if any. */
export function binaryIdOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  return /(?:^|\/)Binary\/([A-Za-z0-9\-.]{1,64})(?:[?#].*)?$/u.exec(url)?.[1];
}
