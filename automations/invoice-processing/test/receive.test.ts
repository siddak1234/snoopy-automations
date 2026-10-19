import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ArtifactReference } from '@autom8x/automation-sdk';

import { FILE_LIMITS, measurementsOf } from '../src/file.js';
import { RUN_FAILS } from '../src/words.js';
import {
  FILE_ID,
  FILENAME,
  everythingSaid,
  jpeg,
  lines,
  manifestsRoot,
  pdf,
  png,
  setUp,
  type Overrides,
} from './fixtures.js';

/**
 * `receive` holds the platform's measurements of the upload to the owner's limits,
 * before any QuickBooks call or model call — and never downloads the file. Its line (§3.E): `PDF, 2
 * pages` or `Photo`; a file it cannot take ends the run in one of the spec's two sentences (§3.F),
 * the reason in the log alone.
 */

const NO_FILE = RUN_FAILS.no_file;
const FILE = RUN_FAILS.file;

async function received(file: ArtifactReference | null, input?: Record<string, unknown>) {
  const world = setUp({ file, ...(input === undefined ? {} : { input }) });
  const result = await world.run();
  return { ...world, result, first: lines(world.platform)[0] };
}

function refusedWith(sentence: string, reason: string) {
  return async (file: ArtifactReference | null, input?: Record<string, unknown>) => {
    const { result, first, platform, logs } = await received(file, input);
    assert.deepEqual(result, { outcome: 'failed', failureReason: sentence });
    assert.deepEqual(first, ['receive', 'failed', sentence]);
    assert.ok(
      logs.some(([, message, fields]) => message === 'step_failed' && fields?.reason === reason),
      `${reason} in the log`,
    );
    assert.equal(platform.steps.length, 1, 'nothing after receive runs');
    assert.deepEqual(platform.providerCalls, [], 'no QuickBooks call');
    assert.deepEqual(platform.modelCalls, [], 'no model call');
    return platform;
  };
}

test('a 2-page PDF continues: the line names it and its pages; the state keeps the file', async () => {
  const { result, first, platform } = await received(pdf());
  assert.deepEqual(first, ['receive', 'ok', 'PDF, 2 pages']);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.outcome === 'success' ? result.output?.file : undefined, {
    artifactId: FILE_ID,
    kind: 'pdf',
    sizeBytes: 184_203,
    pages: 2,
    sha256: 'ab'.repeat(32),
  });
  assert.deepEqual(platform.artifactReads, [FILE_ID]);
});

test('a JPEG and a PNG continue as a photo, no pages; a missing digest is null', async () => {
  const photo = await received(jpeg({ sha256: null }));
  assert.deepEqual(photo.first, ['receive', 'ok', 'Photo']);
  const file = photo.result.outcome === 'success' ? photo.result.output?.file : undefined;
  assert.deepEqual(file, {
    artifactId: FILE_ID,
    kind: 'jpeg',
    sizeBytes: 812_004,
    pages: null,
    sha256: null,
  });
  const image = await received(png());
  assert.deepEqual(image.first, ['receive', 'ok', 'Photo']);
  const one = await received(pdf({ pageCount: 1, sizeBytes: 999 }));
  assert.deepEqual(one.first, ['receive', 'ok', 'PDF, 1 page']);
});

test('no document file — missing, null, not text, empty or blank — fails with no callback at all', async () => {
  const noFile = refusedWith(NO_FILE, 'no_file');
  for (const input of [
    {},
    { invoiceFile: null },
    { invoiceFile: 42 },
    { invoiceFile: '' },
    { invoiceFile: '   ' },
  ]) {
    const platform = await noFile(pdf(), input);
    assert.deepEqual(platform.artifactReads, [], JSON.stringify(input));
  }
  // An id with spaces around it is read without them.
  const { first, platform } = await received(pdf(), { invoiceFile: `  ${FILE_ID} ` });
  assert.equal(first?.[1], 'ok');
  assert.deepEqual(platform.artifactReads, [FILE_ID]);
});

test('a file the run was not given, or one that is gone (404), fails as no longer available', async () => {
  const gone = refusedWith(FILE, 'file_gone');
  const platform = await gone(null);
  assert.deepEqual(platform.artifactReads, [FILE_ID]);
});

test('a measurement that is missing or malformed fails closed', async () => {
  const unchecked = refusedWith(FILE, 'file_unchecked');
  const cases: Overrides[] = [
    { measuredKind: undefined },
    { measuredKind: null },
    { measuredKind: 7 as unknown as 'pdf' },
    { pageCount: undefined },
    { pageCount: null },
    { pageCount: 0 },
    { pageCount: 2.5 },
    { pageCount: '2' as unknown as number },
    { sizeBytes: -1 },
    { sizeBytes: Number.NaN },
  ];
  for (const overrides of cases) await unchecked(pdf(overrides));
  const images: Overrides[] = [
    { widthPixels: undefined },
    { heightPixels: null },
    { widthPixels: 0 },
    { heightPixels: 1.5 },
  ];
  for (const overrides of images) {
    await unchecked(jpeg(overrides));
    await unchecked(png(overrides));
  }
});

test('a type other than PDF, JPEG or PNG fails, whether the upload declared it or the platform measured it', async () => {
  const unsupported = refusedWith(FILE, 'unsupported_type');
  for (const contentType of ['text/plain', 'image/heic', 'application/octet-stream', '']) {
    await unsupported(pdf({ contentType }));
  }
  await unsupported(jpeg({ measuredKind: 'heic' as 'jpeg' }));
  // The declared type is read without case or spaces around it.
  const { first } = await received(pdf({ contentType: ' Application/PDF ' }));
  assert.equal(first?.[1], 'ok');
});

test('a measured kind that is not the declared type fails as not a real PDF, JPEG or PNG', async () => {
  const mismatch = refusedWith(FILE, 'content_mismatch');
  await mismatch(jpeg({ contentType: 'application/pdf' }));
  await mismatch(png({ contentType: 'image/jpeg' }));
  await mismatch(jpeg({ contentType: 'image/png' }));
  await mismatch(pdf({ contentType: 'image/jpeg' }));
});

test('3,500,000 bytes passes and 3,500,001 fails', async () => {
  assert.equal((await received(pdf({ sizeBytes: 3_500_000 }))).first?.[1], 'ok');
  await refusedWith(FILE, 'file_too_large')(jpeg({ sizeBytes: 3_500_001 }));
});

test('a PDF of any number of pages passes: no limit other than size (AM1, AM7)', async () => {
  for (const pageCount of [10, 11, 250]) {
    assert.deepEqual((await received(pdf({ pageCount }))).first?.[2], `PDF, ${pageCount} pages`);
  }
});

test('an image of 8,000 px on a side passes and 8,001 fails, on width and on height, JPEG and PNG', async () => {
  const tooLarge = refusedWith(FILE, 'image_too_large');
  for (const image of [jpeg, png]) {
    const fits = await received(image({ widthPixels: 8_000, heightPixels: 8_000 }));
    assert.equal(fits.first?.[1], 'ok');
    await tooLarge(image({ widthPixels: 8_001, heightPixels: 10 }));
    await tooLarge(image({ widthPixels: 10, heightPixels: 8_001 }));
  }
});

test('nothing said carries the filename or the download link', async () => {
  for (const file of [pdf(), jpeg(), pdf({ pageCount: 11 }), pdf({ pageCount: undefined })]) {
    const { result, platform } = await received(file);
    const said = everythingSaid(platform, result);
    assert.ok(!said.includes(FILENAME) && !said.includes('IMG_0042'), said);
    assert.ok(!said.includes(file.downloadUrl) && !said.includes('signature='), said);
  }
});

test("the limits are the manifest's artifacts block, the pages and pixels the platform measures among them", () => {
  // Without a page or pixel limit the platform measures nothing (its BUILD-PLAN 25.2.28), and
  // receive, failing closed, would refuse every file.
  const manifest = JSON.parse(
    readFileSync(join(manifestsRoot, 'invoice-processing.v5.json'), 'utf8'),
  ) as { artifacts: unknown };
  assert.deepEqual(manifest.artifacts, {
    acceptedContentTypes: FILE_LIMITS.acceptedContentTypes,
    maximumSizeBytes: FILE_LIMITS.maximumSizeBytes,
    maximumImageSidePixels: FILE_LIMITS.maximumImageSidePixels,
  });
  assert.equal(FILE_LIMITS.maximumImageSidePixels, 8_000);
});

test("measurementsOf reads the platform's measurement fields, and no other", () => {
  assert.deepEqual(measurementsOf(pdf()), {
    kind: 'pdf',
    sizeBytes: 184_203,
    pageCount: 2,
    widthPixels: null,
    heightPixels: null,
  });
  assert.deepEqual(measurementsOf(png()), {
    kind: 'png',
    sizeBytes: 95_310,
    pageCount: null,
    widthPixels: 1_200,
    heightPixels: 900,
  });
  assert.equal(measurementsOf(jpeg())?.kind, 'jpeg');
  // A kind this automation does not read; the declared type is receive's to compare.
  assert.equal(measurementsOf(pdf({ measuredKind: 'gif' as 'pdf' }))?.kind, 'other');
  assert.equal(measurementsOf(pdf({ contentType: 'image/png' }))?.kind, 'pdf');
  // A PDF needs no pixels, an image no pages.
  assert.equal(
    measurementsOf(pdf({ widthPixels: undefined, heightPixels: undefined }))?.kind,
    'pdf',
  );
  assert.equal(measurementsOf(jpeg({ pageCount: undefined }))?.kind, 'jpeg');
  assert.equal(measurementsOf(pdf({ measuredKind: null })), undefined);
  assert.equal(measurementsOf(pdf({ measuredKind: undefined })), undefined);
});
