import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  DEFAULT_CALLBACK_TIMEOUT_MS,
  DEFAULT_MODEL_TIMEOUT_MS,
  type RunResult,
} from '@autom8x/automation-sdk';

import { define } from '../src/automation.js';
import { WINDOWS_AT_ONCE, WINDOW_ROOM_MS, pagesOfAnswer } from '../src/v2/batch-steps.js';
import { WORDS_V2 } from '../src/v2/words.js';
import { FAILURES } from '../src/words.js';
import { manifests } from './fixtures.js';
import { PDF_ID, PHOTO_ID, batchPlatform, batchRequest, page } from './v2-fixtures.js';

/**
 * The batch run (the spec's v2 section, "The batch"; the platform's batch intake): chunk,
 * categorize, organize, queue — every file's pages counted, sorted in windows of at most 20 pages,
 * grouped into visits, and one unit per visit queued; its one line, "{files} files · {pages} pages
 * · {visits} visits · {set aside} set aside".
 */

const flow = () => define(manifests, { today: () => '2026-10-28' });

const jane = Array.from({ length: 25 }, (_, i) =>
  i === 0
    ? page(1, 'cover')
    : i < 22
      ? page(i + 1, 'note', i === 1 ? 'Jane Doe' : null, i === 1 ? '2026-10-12' : null)
      : page(i + 1, 'note', 'Sam Roe', '2026-10-13'),
);

async function batch(platform = defaultPlatform(), ids = [PDF_ID, PHOTO_ID]) {
  const result = await flow().execute(batchRequest(ids), platform);
  await platform.reportResult('r', result);
  return { result: platform.results.at(-1)!.result, platform };
}

function defaultPlatform() {
  return batchPlatform(
    [
      { id: PDF_ID, contentType: 'application/pdf', pageCount: 25 },
      { id: PHOTO_ID, contentType: 'image/jpeg', pageCount: null },
    ],
    { [PDF_ID]: jane, [PHOTO_ID]: [page(1, 'lab')] },
  );
}

const success = (result: RunResult) => {
  assert.equal(result.outcome, 'success', JSON.stringify(result));
  return result as Extract<RunResult, { outcome: 'success' }>;
};

test('the batch run reports its four steps, reads each PDF in windows of 20 and a photo whole', async () => {
  const { platform } = await batch();
  assert.deepEqual(
    platform.steps.map((s) => [s.stepId, s.outcome]),
    [
      ['chunk', 'ok'],
      ['categorize', 'ok'],
      ['organize', 'ok'],
      ['queue', 'ok'],
    ],
  );
  assert.deepEqual(
    platform.modelCalls.map((c) => [c.artifactId, c.pages ?? null, c.capability]),
    [
      [PDF_ID, { from: 1, to: 20 }, 'document-extraction'],
      [PDF_ID, { from: 21, to: 25 }, 'document-extraction'],
      [PHOTO_ID, null, 'document-extraction'],
    ],
  );
  assert.deepEqual(platform.modelCalls[1]!.input, { from: 21, to: 25 });
  assert.equal(platform.modelCalls[1]!.prompt, platform.modelCalls[0]!.prompt, 'byte-stable');
});

test('one unit per visit, its label, its page ranges and its patient data; its line and counts', async () => {
  const done = success((await batch()).result);
  assert.deepEqual(done.units, [
    {
      label: 'Jane Doe · Oct 12, 2026',
      artifacts: [
        { artifactId: PDF_ID, pages: { from: 2, to: 21 } },
        { artifactId: PDF_ID, pages: { from: 22, to: 22 } },
      ],
      data: { patient: 'Jane Doe', visitDate: '2026-10-12', pages: 21 },
    },
    {
      label: 'Sam Roe · Oct 13, 2026',
      artifacts: [{ artifactId: PDF_ID, pages: { from: 23, to: 25 } }],
      data: { patient: 'Sam Roe', visitDate: '2026-10-13', pages: 3 },
    },
  ]);
  const line = '2 files · 26 pages · 2 visits · 2 set aside';
  assert.equal(done.summary, line);
  assert.deepEqual(done.blocks, [{ type: 'text', text: line }]);
  const { audit, ...counts } = done.output as { audit: Record<string, unknown>[] };
  assert.deepEqual(counts, {
    files: 2,
    pages: 26,
    visits: 2,
    setAside: 2,
    pagesFrom: ['measured', 'measured'],
  });
  assert.deepEqual(
    audit.map((r) => [r.step, r.prompt, r.file, r.pages, r.tokens, r.finishReason, r.gate]),
    [
      [
        'categorize',
        'categorize-pages v2',
        PDF_ID,
        { from: 1, to: 20 },
        { input: 1, output: 1 },
        'stop',
        'pages sorted: 20 of 20',
      ],
      [
        'categorize',
        'categorize-pages v2',
        PDF_ID,
        { from: 21, to: 25 },
        { input: 1, output: 1 },
        'stop',
        'pages sorted: 5 of 5',
      ],
      [
        'categorize',
        'categorize-pages v2',
        PHOTO_ID,
        null,
        { input: 1, output: 1 },
        'stop',
        'pages sorted: 1 of 1',
      ],
    ],
  );
  assert.deepEqual((audit[2]!.answer as { pages: unknown[] }).pages, [page(1, 'lab')]);
});

test('a PDF the platform did not measure is counted from its bytes, and says so', async () => {
  const bytes = new TextEncoder().encode('<< /Type /Page >> '.repeat(6));
  const platform = batchPlatform(
    [{ id: PDF_ID, contentType: 'application/pdf', pageCount: null }],
    {
      [PDF_ID]: [
        page(1, 'note', 'Jane Doe', '2026-10-12'),
        ...[2, 3, 4, 5, 6].map((n) => page(n, 'note')),
      ],
    },
    bytes,
  );
  const done = success((await batch(platform, [PDF_ID])).result);
  assert.deepEqual((done.output as { pagesFrom: string[] }).pagesFrom, ['counted']);
  assert.deepEqual(platform.modelCalls[0]!.pages, { from: 1, to: 6 });
  assert.equal(done.units?.length, 1);
});

test('no file, or no page a visit note: no unit queued; the upload stops or says so', async () => {
  const none = await flow().execute(batchRequest([]), defaultPlatform());
  assert.equal(none.outcome === 'failed' && none.failureReason, FAILURES.noFile);
  const others = Array.from({ length: 6 }, (_, i) => page(i + 1, 'other'));
  const platform = batchPlatform([{ id: PDF_ID, contentType: 'application/pdf', pageCount: 6 }], {
    [PDF_ID]: others,
  });
  const done = success((await batch(platform, [PDF_ID])).result);
  assert.equal(done.units, undefined);
  assert.equal(done.summary, '1 file · 6 pages · 0 visits · 6 set aside');
});

test('I3: one PDF of at most 5 pages, or photos chosen together, is one visit with no AI', async () => {
  const short = batchPlatform([{ id: PDF_ID, contentType: 'application/pdf', pageCount: 5 }], {});
  const one = success((await batch(short, [PDF_ID])).result);
  assert.equal(short.modelCalls.length, 0);
  assert.deepEqual(
    one.units?.map((u) => [u.label, u.artifacts]),
    [['Visit note', [{ artifactId: PDF_ID, pages: { from: 1, to: 5 } }]]],
  );
  const second = '44444444-4444-4444-8444-444444444443';
  const photos = batchPlatform(
    [
      { id: PHOTO_ID, contentType: 'image/jpeg', pageCount: null },
      { id: second, contentType: 'image/png', pageCount: null },
    ],
    {},
  );
  const both = success((await batch(photos, [PHOTO_ID, second])).result);
  assert.equal(photos.modelCalls.length, 0);
  assert.deepEqual(
    both.units?.map((u) => u.artifacts),
    [[{ artifactId: PHOTO_ID }, { artifactId: second }]],
  );
  assert.equal(both.summary, '2 files · 2 pages · 1 visit · 0 set aside');
});

test('a page answered off its kinds, or with no segment, is set aside, never guessed a note', () => {
  const read = pagesOfAnswer(
    {
      pages: [
        { page: 2, segments: [{ kind: 'invoice', patient: 'X' }] },
        { page: 3, segments: [{ kind: 'note', position: 0 }] },
        { page: 1, segments: [] },
      ],
    },
    { from: 1, to: 3 },
  );
  assert.deepEqual(
    read.map((p) => [p.page, p.segments.map((x) => [x.kind, x.position])]),
    [
      [1, [['other', null]]],
      [2, [['other', null]]],
      [3, [['note', null]]],
    ],
  );
});

test("a later window answered as its own PDF's pages 1 to 20 is read as the window's pages", () => {
  const answer = {
    pages: [page(1, 'note', 'Jane Doe', '2026-10-12', 1), page(2, 'note', null, null, 2)],
  };
  assert.deepEqual(
    pagesOfAnswer(answer, { from: 21, to: 40 })
      .slice(0, 3)
      .map((p) => [p.page, p.segments[0]!.kind, p.segments[0]!.patient]),
    [
      [21, 'note', 'Jane Doe'],
      [22, 'note', null],
      [23, 'other', null],
    ],
  );
  // An answer that numbers the window's own pages is read as it is.
  assert.equal(
    pagesOfAnswer({ pages: [page(21, 'note')] }, { from: 21, to: 40 })[0]!.segments[0]!.kind,
    'note',
  );
});

test('many windows: three asked at once, none started without room for its call and the reports; the run ends before its deadline, in words', async () => {
  const pages = Array.from({ length: 500 }, (_, i) =>
    page(i + 1, 'note', 'Jane Doe', '2026-10-12'),
  );
  const platform = batchPlatform([{ id: PDF_ID, contentType: 'application/pdf', pageCount: 500 }], {
    [PDF_ID]: pages,
  });
  let clock = Date.now();
  const now = mock.method(Date, 'now', () => clock);
  const answer = platform.model;
  const deadline = clock + 1_600_000; // the sixth round of calls starts with 300 s left
  let inFlight = 0;
  let most = 0;
  let late = 0;
  platform.model = async (call, model) => {
    if (deadline - clock < WINDOW_ROOM_MS) late += 1;
    const started = clock;
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    // Each call takes the longest a model call may wait; calls asked together overlap.
    clock = Math.max(clock, started + DEFAULT_MODEL_TIMEOUT_MS);
    inFlight -= 1;
    return answer(call, model);
  };
  try {
    const ended = await flow().execute(
      { ...batchRequest([PDF_ID]), deadline: new Date(deadline).toISOString() },
      platform,
    );
    assert.equal(ended.outcome === 'failed' && ended.failureReason, WORDS_V2.tooLong);
  } finally {
    now.mock.restore();
  }
  assert.equal(most, WINDOWS_AT_ONCE);
  assert.equal(WINDOWS_AT_ONCE, 3);
  assert.equal(late, 0, 'no window started without its room');
  assert.ok(
    clock + 4 * DEFAULT_CALLBACK_TIMEOUT_MS <= deadline,
    `ended ${(deadline - clock) / 1000} s before it`,
  );
  assert.ok(platform.modelCalls.length < 25, `${platform.modelCalls.length} of 25 windows asked`);
});

test('a separator page splits visits; a page with two patients goes to both, each read only for its patient', async () => {
  const platform = batchPlatform([{ id: PDF_ID, contentType: 'application/pdf', pageCount: 6 }], {
    [PDF_ID]: [
      page(1, 'note', 'Jane Doe', '2026-10-12'),
      page(2, 'separator'),
      page(3, 'note', null, null),
      page(4, 'note', 'Pat Example', '2026-10-14', 1, [
        { kind: 'note', patient: 'Lee Sample', visitDate: '2026-10-14', position: null },
      ]),
      page(5, 'note', null, null),
      page(6, 'lab'),
    ],
  });
  const done = success((await batch(platform, [PDF_ID])).result);
  assert.deepEqual(
    done.units?.map((u) => [u.artifacts, u.data]),
    [
      [
        [{ artifactId: PDF_ID, pages: { from: 1, to: 1 } }],
        { patient: 'Jane Doe', visitDate: '2026-10-12', pages: 1 },
      ],
      [
        [{ artifactId: PDF_ID, pages: { from: 3, to: 3 } }],
        { patient: null, visitDate: null, pages: 1 },
      ],
      [
        [{ artifactId: PDF_ID, pages: { from: 4, to: 4 } }],
        { patient: 'Pat Example', visitDate: '2026-10-14', pages: 1, readOnly: 'Pat Example' },
      ],
      [
        [{ artifactId: PDF_ID, pages: { from: 4, to: 5 } }],
        { patient: 'Lee Sample', visitDate: '2026-10-14', pages: 2, readOnly: 'Lee Sample' },
      ],
    ],
  );
  assert.equal(done.summary, '1 file · 6 pages · 4 visits · 2 set aside');
});

test('an upload past one batch (more than 500 visits) stops in its words, queuing none', async () => {
  const many = Array.from({ length: 501 }, (_, i) =>
    page(i + 1, 'note', `Patient ${i}`, '2026-10-12'),
  );
  const platform = batchPlatform([{ id: PDF_ID, contentType: 'application/pdf', pageCount: 501 }], {
    [PDF_ID]: many,
  });
  const ended = await flow().execute(batchRequest([PDF_ID]), platform);
  assert.equal(
    ended.outcome === 'failed' && ended.failureReason,
    'This upload has more visits than one batch can hold. Upload fewer files at a time.',
  );
});
