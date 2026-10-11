import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { PlatformClient, type ModelRequest } from '@autom8x/automation-sdk';

/**
 * Real failures on a real wire, for the model call's one retry: the SDK marks an error where
 * it makes the request (`unsent`, `unanswered`), and only its own client can — so these come
 * from a `PlatformClient` aimed at local sockets, never from a constructed error.
 */

/** Any model request: the client fails it before an answer, or the server answers it. */
const REQUEST: ModelRequest = {
  capability: 'document-extraction',
  prompt: 'Extract.',
  input: {},
  outputSchema: {},
};

export interface LocalServer {
  readonly origin: string;
  /** How many requests reached it. */
  received(): number;
  close(): Promise<void>;
}

/** A server on a free local port, answering each request with `handler`. */
export async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LocalServer> {
  let count = 0;
  const server = createServer((request, response) => {
    count += 1;
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    received: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** An origin nobody listens on: a port taken, then given back. */
export async function closedOrigin(): Promise<string> {
  const server = await localServer(() => undefined);
  await server.close();
  return server.origin;
}

/** What a real client throws for a model call to `origin`, with `options`. */
async function thrownBy(origin: string, modelTimeoutMs = 2_000): Promise<unknown> {
  const outcome = await new PlatformClient(origin, 'run-token', { modelTimeoutMs })
    .callModel(REQUEST)
    .then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
  if (!outcome) throw new Error('the call was answered, so no failure to hand over');
  return outcome.error;
}

/** The connection refused before a byte left: marked unsent (and unanswered) by the SDK. */
export async function refusedConnection(): Promise<unknown> {
  return thrownBy(await closedOrigin());
}

/** A request read whole, then the connection dropped without a word: unanswered, not unsent. */
export async function droppedConnection(): Promise<unknown> {
  const server = await localServer((request) => {
    request.resume();
    request.on('end', () => request.socket.destroy());
  });
  try {
    return await thrownBy(server.origin);
  } finally {
    await server.close();
  }
}

/** No answer inside the client's bound: unanswered, not unsent. */
export async function timedOut(): Promise<unknown> {
  const server = await localServer(() => undefined);
  try {
    return await thrownBy(server.origin, 50);
  } finally {
    await server.close();
  }
}

/** A page from in front of the platform: a 503 naming no code. */
export async function proxyPage(status = 503): Promise<unknown> {
  const server = await localServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'text/html' }).end('no upstreams available');
  });
  try {
    return await thrownBy(server.origin);
  } finally {
    await server.close();
  }
}
