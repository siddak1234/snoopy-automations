import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { DOCX_LIMITS, docxText } from '../src/docx.js';
import { docx, documentXml, paragraph, zip } from './fixtures.js';

/**
 * A Word file's text, read with Node's `zlib` alone (the spec's §4), from files this suite builds
 * in memory: `word/document.xml` found through the central directory, its paragraphs, tabs and
 * breaks — and every file it must refuse, a ZIP bomb among them, refused before it is inflated.
 */

const text = (bytes: Uint8Array) => {
  const read = docxText(bytes);
  assert.ok(read.ok, `refused: ${read.ok ? '' : read.refusal}`);
  return read.text;
};

const refusal = (bytes: Uint8Array) => {
  const read = docxText(bytes);
  return read.ok ? 'read' : read.refusal;
};

test('paragraphs are lines, a tab a tab and a break a break, entities decoded', () => {
  const body = [
    paragraph('Jane Doe'),
    '<w:p><w:r><w:t>Senior Accountant</w:t></w:r><w:r><w:tab/><w:t>2021 &amp; now</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Led the close</w:t><w:br/><w:t>&lt;4 days&gt; &#8211; &#x2713;</w:t></w:r></w:p>',
    '<w:p/>',
    paragraph('Skills: Excel, &quot;NetSuite&quot;, O&apos;Brien'),
  ].join('');
  assert.equal(
    text(docx(body)),
    'Jane Doe\nSenior Accountant\t2021 & now\nLed the close\n<4 days> – ✓\n\nSkills: Excel, "NetSuite", O\'Brien',
  );
});

test('a tab stop is no tab, a fallback is not read twice, and what is not text is not read', () => {
  const body = [
    paragraph('Jane Doe'),
    '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Role</w:t></w:r></w:p>',
    '<w:p><w:r><mc:AlternateContent><mc:Choice><w:t>In a box</w:t></mc:Choice>',
    '<mc:Fallback><w:t>In a box</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>',
    '<w:p><w:r><w:instrText>PAGE</w:instrText><w:delText>removed</w:delText><w:t>kept</w:t></w:r></w:p>',
  ].join('');
  assert.equal(text(docx(body)), 'Jane Doe\nRole\nIn a box\nkept');
});

test('the document is found through the central directory, wherever it sits', () => {
  const bytes = zip([
    { name: 'word/styles.xml', data: Buffer.from('<w:styles/>') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(paragraph('Found')), 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from('<Properties/>') },
  ]);
  assert.equal(text(bytes), 'Found');
});

test('what is not a Word file is refused: not a ZIP, or no document in it', () => {
  assert.equal(refusal(new TextEncoder().encode('%PDF-1.7 not a zip')), 'not-a-zip');
  assert.equal(refusal(new Uint8Array()), 'not-a-zip');
  assert.equal(
    refusal(zip([{ name: 'word/other.xml', data: Buffer.from('<x/>') }])),
    'no-document',
  );
});

test('an encrypted entry, or one not stored with deflate, is refused', () => {
  assert.equal(refusal(docx(paragraph('Secret'), { flags: 0x0001 })), 'encrypted');
  assert.equal(refusal(docx(paragraph('Stored'), { method: 0 })), 'not-deflate');
});

test('a ZIP bomb is refused before it is inflated: past 5 MB, or more than 100 times its size', () => {
  // Six million bytes of one letter: deflate stores it in a few kilobytes.
  const bomb = Buffer.alloc(6_000_000, 'a');
  assert.equal(refusal(zip([{ name: 'word/document.xml', data: bomb }])), 'too-large');
  // Within 5 MB, and far past the ratio: one million bytes stored in about a thousand.
  const dense = Buffer.alloc(1_000_000, 'a');
  assert.ok(deflateRawSync(dense).byteLength * DOCX_LIMITS.ratio < dense.byteLength);
  assert.equal(refusal(zip([{ name: 'word/document.xml', data: dense }])), 'ratio');
  // A directory that claims less than the entry inflates to: stopped at the claim.
  const body = Buffer.from(documentXml(paragraph('x'.repeat(4000))), 'utf8');
  assert.equal(
    refusal(zip([{ name: 'word/document.xml', data: body, inflatedSize: 400 }])),
    'corrupt',
  );
});

test('a directory pointing past the file, or an entry cut short, is refused', () => {
  const whole = docx(paragraph('Cut'));
  assert.equal(refusal(whole.subarray(0, whole.byteLength - 30)), 'not-a-zip');
  const lying = zip([
    {
      name: 'word/document.xml',
      data: Buffer.from(documentXml(paragraph('Cut')), 'utf8'),
      storedSize: 10_000,
      inflatedSize: 20_000,
    },
  ]);
  assert.equal(refusal(lying), 'corrupt');
});
