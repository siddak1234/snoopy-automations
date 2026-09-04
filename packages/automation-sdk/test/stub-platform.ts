import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { toArtifactListing } from '../src/contract.js';
import { artifactFixture } from '../src/testing.js';

/**
 * A stub of the platform's callback surface, answering exactly as the Runs
 * service's handlers do — the shapes below are lifted from those handlers, not
 * invented — and recording what the SDK sent so a test can assert on the wire
 * rather than on a mock's memory.
 *
 * It also serves signed-URL objects at `/objects/<id>`, recording the headers each
 * fetch presented, because "the artifact fetch carries no credential" is a claim
 * about a request nobody else sees.
 */

export interface RecordedCall {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type Answer = { status: number; body?: unknown };

export interface StubPlatform {
  origin: string;
  calls: RecordedCall[];
  /** Per-message overrides; the default answers are the handlers' real shapes. */
  answers: Partial<Record<string, (body: Record<string, unknown>) => Answer>>;
  /** Milliseconds to hold every callback before answering. */
  delayMs: number;
  objects: Map<string, Uint8Array>;
  objectRequests: IncomingHttpHeaders[];
  close(): Promise<void>;
}

function defaultAnswer(message: string, body: Record<string, unknown>): Answer {
  switch (message) {
    case 'step':
      return { status: 202, body: { accepted: true } };
    case 'result':
      return { status: 200, body: { run: { id: body.runId, status: 'ended' } } };
    case 'model':
      return {
        status: 200,
        body: {
          model: {
            text: '{"vendor":"Contoso"}',
            model: 'stub-model',
            finishReason: 'stop',
            usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
          },
        },
      };
    case 'provider':
      return { status: 200, body: { provider: { status: 200, body: { id: 'sent' } } } };
    case 'artifact':
      return body.artifactId === undefined
        ? {
            status: 200,
            body: { artifacts: [toArtifactListing(artifactFixture({ artifactId: 'a1' }))] },
          }
        : {
            status: 200,
            body: { artifact: artifactFixture({ artifactId: String(body.artifactId) }) },
          };
    default:
      return { status: 404, body: { error: 'not_found' } };
  }
}

export async function startStubPlatform(): Promise<StubPlatform> {
  const stub: StubPlatform = {
    origin: '',
    calls: [],
    answers: {},
    delayMs: 0,
    objects: new Map(),
    objectRequests: [],
    close: () => Promise.resolve(),
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '/';
      const object = /^\/objects\/([^?]+)/u.exec(path);
      if (request.method === 'GET' && object) {
        stub.objectRequests.push(request.headers);
        const bytes = stub.objects.get(object[1] ?? '');
        if (!bytes) {
          response.writeHead(403).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
        return;
      }

      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = text ? JSON.parse(text) : undefined;
      stub.calls.push({ method: request.method ?? '', path, headers: request.headers, body });

      const message = /^\/v1\/automations\/callbacks\/([a-z]+)$/u.exec(path)?.[1] ?? '';
      const parsed = (body ?? {}) as Record<string, unknown>;
      const answer = (stub.answers[message] ?? ((b) => defaultAnswer(message, b)))(parsed);
      // Unref'd so a deliberately slow answer (the timeout test) never pins the
      // process past the end of the suite.
      setTimeout(() => {
        const payload = answer.body === undefined ? '' : JSON.stringify(answer.body);
        response.writeHead(answer.status, { 'content-type': 'application/json' }).end(payload);
      }, stub.delayMs).unref();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  stub.origin = `http://127.0.0.1:${port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

/** Polls until the predicate holds, or fails the test after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await sleep(10);
  }
}
