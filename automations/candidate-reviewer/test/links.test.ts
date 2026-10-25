import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

import type { JsonObject, RunResult } from '@autom8x/automation-sdk';

import { docxLinks } from '../src/docx.js';
import { PDF_LIMITS, pdfLinks } from '../src/pdf.js';
import { fileLinks, withFileLinks } from '../src/reading.js';
import { linkLabel } from '../src/words.js';
import {
  WORD,
  candidateRun,
  documentXml,
  paragraph,
  resumeAnswer,
  scoreAnswer,
  world,
  zip,
} from './fixtures.js';
import { reportedResult, validOutput } from './results.js';

/**
 * The links a resume's file holds behind its words (the spec's §4; the owner's build 28 feedback,
 * F8: "If there is a url that should be in the section"): a PDF's URI actions, as written or in a
 * compressed object stream, and a Word file's hyperlinks — http and https only, added to what the
 * model read, never sent to the score. Every file is built here, made up, on reserved hosts; the
 * three named sites carry `/in/example`-style paths.
 */

type Success = Extract<RunResult, { outcome: 'success' }>;

/** A PDF built here: `%PDF-`, its objects numbered from 1, then the trailer. */
function pdf(objects: readonly string[], trailer = '<< /Root 1 0 R >>'): Uint8Array {
  const body = objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`).join('');
  return Buffer.from(`%PDF-1.7\n${body}trailer\n${trailer}\n%%EOF\n`, 'latin1');
}

/** A link annotation whose URI action's address is `address`, written as the PDF holds it. */
const annotation = (address: string) =>
  `<< /Type /Annot /Subtype /Link /Rect [72 700 160 712] /A << /S /URI /URI ${address} >> >>`;

/** A compressed stream, a `/Type /ObjStm` as a PDF 1.5 writer packs annotations into one. */
function objectStream(content: string): string {
  const data = deflateSync(Buffer.from(content, 'latin1'));
  return `<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${data.byteLength} >>\nstream\n${data.toString('latin1')}\nendstream`;
}

const PAGE = '<< /Type /Page /Annots [3 0 R] >>';

async function run(bytes: Uint8Array, contentType = 'application/pdf', resume = resumeAnswer()) {
  const { automation, platform } = world(
    { resume, score: scoreAnswer(88) },
    { contentType, bytes },
  );
  const request = candidateRun();
  const result = await automation.execute(request, platform);
  await platform.reportResult(request.runId, result);
  const sent = reportedResult(platform);
  assert.equal(sent.outcome, 'success');
  validOutput((sent as Success).output);
  return { platform, sent: sent as Success };
}

const contactLinks = (result: Success) =>
  (result.sections?.find((each) => each.title === 'Contact')?.entries ?? [])
    .filter((entry) => entry.subtitle === 'Link')
    .map((entry) => [entry.title, entry.url]);

/** The three links `resumeAnswer` gives, as the Contact section shows them. */
const MODEL_LINKS = [
  ['LinkedIn', 'https://linkedin.example.com/in/jane-doe'],
  ['Portfolio', 'https://janedoe.example.com'],
  ['https://code.example.org/jane-doe', 'https://code.example.org/jane-doe'],
];

test('F8: a PDF link behind a word is added to Contact, named by its site, after the model’s', async () => {
  const bytes = pdf([PAGE, PAGE, annotation('(https://www.example.org/talks)')]);
  const { platform, sent } = await run(bytes);
  assert.deepEqual(contactLinks(sent), [
    ...MODEL_LINKS,
    ['example.org', 'https://www.example.org/talks'],
  ]);
  // §4: links are contact details — the scoring call is sent none, the file's among them.
  const scored = JSON.stringify(platform.modelCalls[1]?.input);
  assert.ok(!scored.includes('example.org/talks'), 'a file link reached the score');
  assert.ok(!platform.steps.some((step) => step.summary.includes('example.org')));
});

test('F8: an annotation inside a compressed object stream is read', async () => {
  const bytes = pdf([PAGE, objectStream(`3 0 ${annotation('(https://example.com/packed)')}`)]);
  assert.deepEqual(pdfLinks(bytes), ['https://example.com/packed']);
  const { sent } = await run(bytes);
  assert.deepEqual(contactLinks(sent).at(-1), ['example.com', 'https://example.com/packed']);
});

test('a hex string and an escaped literal are decoded', () => {
  const address = 'https://example.org/hex';
  const spaced = Buffer.from(address).toString('hex').replace(/(..)/gu, '$1 ');
  assert.deepEqual(pdfLinks(pdf([annotation(`<${spaced}>`)])), [address]);
  // An odd last digit is followed by 0: "2f" + "6" reads as "/` then 0x60.
  assert.deepEqual(pdfLinks(pdf([annotation('<68747470733a2f2f6578616d706c652e636f6d2f6>')])), [
    'https://example.com/`',
  ]);
  // Escaped parentheses, an octal escape (\053 is "+"), a line continuation, balanced parentheses.
  const escaped = '(https://example.com/a\\(1\\)\\053b\\\nc/(d))';
  assert.deepEqual(pdfLinks(pdf([annotation(escaped)])), ['https://example.com/a(1)+bc/(d)']);
  // The catalog's `/URI << /Base … >>` is a dictionary, never an address.
  assert.deepEqual(
    pdfLinks(pdf(['<< /Type /Catalog /URI << /Base (https://example.com/) >> >>'])),
    [],
  );
});

test('only http and https are kept: a mailto: and a javascript: are dropped', async () => {
  const bytes = pdf([
    annotation('(mailto:jane.doe@example.com)'),
    annotation('(javascript:app.alert\\(1\\))'),
    annotation('(file:///C:/resume.pdf)'),
    annotation('(https://example.com/kept)'),
  ]);
  assert.equal(pdfLinks(bytes).length, 4, 'every address is read; fileLinks keeps the http(s)');
  assert.deepEqual(fileLinks(pdfLinks(bytes)), ['https://example.com/kept']);
  const { sent } = await run(bytes);
  assert.deepEqual(contactLinks(sent), [
    ...MODEL_LINKS,
    ['example.com', 'https://example.com/kept'],
  ]);
});

test("a link the model read is not added twice — a trailing slash or the host's case aside — and keeps its label", async () => {
  const bytes = pdf([
    annotation('(https://LINKEDIN.example.com/in/jane-doe/)'),
    annotation('(https://janedoe.example.com/)'),
    annotation('(https://example.org/new)'),
    annotation('(https://example.org/new/)'),
  ]);
  const { sent } = await run(bytes);
  assert.deepEqual(contactLinks(sent), [
    ...MODEL_LINKS,
    ['example.org', 'https://example.org/new'],
  ]);
  assert.deepEqual(
    withFileLinks(
      [{ url: 'https://example.com/a', label: 'Portfolio' }],
      ['https://EXAMPLE.com/a/'],
    ),
    [{ url: 'https://example.com/a', label: 'Portfolio' }],
  );
});

test('F8: a Word file’s external hyperlinks are read from its relationships', async () => {
  const relationship = (id: string, type: string, target: string, external: boolean) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;
  const rels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    relationship('rId1', 'styles', 'styles.xml', false),
    relationship('rId2', 'hyperlink', 'https://example.com/work?tab=1&amp;page=2', true),
    relationship('rId3', 'hyperlink', '#_Toc1', false),
    relationship('rId4', 'hyperlink', 'mailto:jane.doe@example.com', true),
    relationship('rId5', 'image', 'https://example.org/photo.png', true),
    '</Relationships>',
  ].join('');
  const bytes = zip([
    { name: 'word/document.xml', data: Buffer.from(documentXml(paragraph('Jane Doe')), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(rels, 'utf8') },
  ]);
  assert.deepEqual(docxLinks(bytes), [
    'https://example.com/work?tab=1&page=2',
    'mailto:jane.doe@example.com',
  ]);
  const { sent } = await run(bytes, WORD.contentType);
  assert.deepEqual(contactLinks(sent).at(-1), [
    'example.com',
    'https://example.com/work?tab=1&page=2',
  ]);
  // A Word file without relationships, or one that is not a ZIP, links to nothing.
  assert.deepEqual(docxLinks(zip([{ name: 'word/document.xml', data: Buffer.from('<x/>') }])), []);
  assert.deepEqual(docxLinks(new Uint8Array([1, 2, 3])), []);
});

test('a stream that would inflate past its cap is not read, and the run goes on', async () => {
  // Past one stream's 5 MB in spaces, then the annotation: deflate stores it in a few kilobytes.
  const padding = ' '.repeat(PDF_LIMITS.streamBytes + 1);
  const bytes = pdf([
    PAGE,
    objectStream(`3 0 ${padding}${annotation('(https://example.com/deep)')}`),
  ]);
  assert.deepEqual(pdfLinks(bytes), []);
  const { sent } = await run(bytes);
  assert.deepEqual(contactLinks(sent), MODEL_LINKS);
});

test('every stream together is held to 20 MB, and the streams read to their count', () => {
  // Four streams of 4.5 MB come to 18 MB: the fifth has 2 MB left, short of its own 4.5 MB.
  const big = (address: string) => objectStream(`${' '.repeat(4_500_000)}${annotation(address)}`);
  const budgeted = pdf([
    ...[1, 2, 3, 4].map((n) => big(`(https://example.com/${n})`)),
    big('(https://example.com/5)'),
  ]);
  assert.deepEqual(
    pdfLinks(budgeted),
    [1, 2, 3, 4].map((n) => `https://example.com/${n}`),
  );
  const many = Array.from({ length: PDF_LIMITS.streams }, () => objectStream('3 0 << >>'));
  assert.deepEqual(
    pdfLinks(pdf([...many, objectStream(annotation('(https://example.com/x)'))])),
    [],
  );
  assert.deepEqual(
    pdfLinks(pdf([...many.slice(1), objectStream(annotation('(https://example.com/x)'))])),
    ['https://example.com/x'],
  );
});

test('an encrypted PDF, or bytes that are not one, give no links and no failure', async () => {
  const encrypted = pdf(
    [annotation('(https://example.com/a)')],
    '<< /Root 1 0 R /Encrypt 9 0 R >>',
  );
  assert.deepEqual(pdfLinks(encrypted), []);
  assert.deepEqual(
    pdfLinks(new TextEncoder().encode(`not a PDF ${annotation('(https://example.com/a)')}`)),
    [],
  );
  assert.deepEqual(pdfLinks(new Uint8Array()), []);
  assert.deepEqual(contactLinks((await run(encrypted)).sent), MODEL_LINKS);
});

test('a PDF whose bytes cannot be fetched costs the links alone: the model still reads it', async () => {
  const { automation, platform } = world({ resume: resumeAnswer(), score: scoreAnswer(88) });
  platform.bytes = () => {
    throw new Error('the link expired');
  };
  const result = (await automation.execute(candidateRun(), platform)) as Success;
  assert.equal(result.outcome, 'success');
  const resume = result.output?.resume as JsonObject & { links: unknown[] };
  assert.equal(resume.links.length, 3);
});

test('§9: a PDF whose LinkedIn, GitHub and Hugging Face are words — Contact names the three', async () => {
  const bytes = pdf([
    annotation('(https://www.linkedin.com/in/example)'),
    annotation('(https://github.com/example)'),
    annotation('(https://huggingface.co/example)'),
  ]);
  const { sent } = await run(bytes, 'application/pdf', resumeAnswer({ links: [] }));
  assert.deepEqual(contactLinks(sent), [
    ['LinkedIn', 'https://www.linkedin.com/in/example'],
    ['GitHub', 'https://github.com/example'],
    ['Hugging Face', 'https://huggingface.co/example'],
  ]);
});

test('a link only the file gave is named by its site, or its host without www.', () => {
  assert.equal(linkLabel('https://www.linkedin.com/in/example'), 'LinkedIn');
  assert.equal(linkLabel('https://github.com/example'), 'GitHub');
  assert.equal(linkLabel('https://huggingface.co/example'), 'Hugging Face');
  assert.equal(linkLabel('https://www.example.com/jane'), 'example.com');
  assert.equal(linkLabel('https://WWW.Example.ORG/'), 'example.org');
  assert.deepEqual(
    withFileLinks([], ['https://www.linkedin.com/in/example', 'github.com/example']),
    [
      { url: 'https://www.linkedin.com/in/example', label: 'LinkedIn' },
      { url: 'https://github.com/example', label: 'GitHub' },
    ],
  );
});
