import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { DOCX_LIMITS, docxText } from '../src/docx.js';
import { docx, documentXml, paragraph, partXml, zip } from './fixtures.js';

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

test("a page header's and footer's text is read too, first, and a repeated one once", () => {
  const xml = (text: string) => Buffer.from(text, 'utf8');
  const bytes = zip([
    { name: 'word/document.xml', data: xml(documentXml(paragraph('Senior Accountant'))) },
    { name: 'word/footer1.xml', data: xml(partXml('ftr', paragraph('jane.doe@example.com'))) },
    { name: 'word/header2.xml', data: xml(partXml('hdr', paragraph('Jane Doe'))) },
    { name: 'word/header1.xml', data: xml(partXml('hdr', paragraph('Jane Doe'))) },
    { name: 'word/headers.xml', data: xml(partXml('hdr', paragraph('not a header part'))) },
  ]);
  assert.equal(text(bytes), 'Jane Doe\njane.doe@example.com\nSenior Accountant');
});

test('a header is held to the same bounds, and every entry read shares one 5 MB budget', () => {
  const body = { name: 'word/document.xml', data: Buffer.from(documentXml(paragraph('x'))) };
  const header = (data: Buffer) => ({ name: 'word/header1.xml', data });
  assert.equal(refusal(zip([body, header(Buffer.alloc(1_000_000, 'a'))])), 'ratio');
  assert.equal(
    refusal(zip([body, { ...header(Buffer.from(partXml('hdr', ''))), flags: 0x0001 }])),
    'encrypted',
  );
  // Two parts of 2.6 MB each that hardly compress: each within the bound, together past it.
  const half = () => randomBytes(2_600_000);
  assert.equal(
    refusal(zip([{ ...body, data: half() }, header(half())])),
    'too-large',
    'refused before either is inflated',
  );
});

test('what is not a Word file is refused: not a ZIP, or no document in it', () => {
  assert.equal(refusal(new TextEncoder().encode('%PDF-1.7 not a zip')), 'not-a-zip');
  assert.equal(refusal(new Uint8Array()), 'not-a-zip');
  assert.equal(
    refusal(zip([{ name: 'word/other.xml', data: Buffer.from('<x/>') }])),
    'no-document',
  );
  const header = Buffer.from(partXml('hdr', paragraph('Jane Doe')));
  assert.equal(refusal(zip([{ name: 'word/header1.xml', data: header }])), 'no-document');
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
