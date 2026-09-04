import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  CONTRACT_VERSION,
  isInvokeRequest,
  type InvokeAck,
  type InvokeRequest,
  type RunResult,
} from './contract.js';
import { type AutomationPlatform, clientFor } from './platform.js';

/**
 * The serving shell.
 *
 * Two routes and nothing else: a liveness endpoint the catalog probes, and the
 * invoke. Everything the automation is allowed to do afterwards goes out through
 * the platform client, carrying the run token it was handed.
 *
 * Accept-then-work, deliberately. The platform waits only for the acknowledgement
 * (`acceptTimeoutMs` in the manifest); the work itself may take up to
 * `runTimeoutSeconds` and reports progress as it goes. Doing the work inline would
 * make the two timeouts the same number and turn any slow run into a failed
 * dispatch.
 *
 * An automation is `serve({ templateId, execute })` and a manifest. What used to be
 * a per-automation `main.ts` lives here once, because the shell is where "refuse
 * above capacity", "drain on shutdown" and "never log the payload" are decided —
 * and a copy that drifts on any of them makes the platform's view of that
 * automation wrong.
 */

export type Logger = (
  level: 'info' | 'error',
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface ServeOptions {
  /** Must match the manifest's `templateId`; any other invoke is refused as unknown. */
  templateId: string;
  /**
   * The automation. Runs after the acknowledgement; its result is reported for it.
   *
   * If it throws, the error's MESSAGE becomes the run's `failureReason` on the
   * platform and a line in this container's log. Never build an error message
   * from the document being processed — a `JSON.parse` failure on Node embeds a
   * snippet of its input, so parse customer content inside a try that rethrows
   * with a plain message.
   */
  execute: (request: InvokeRequest, platform: AutomationPlatform) => Promise<RunResult>;
  /** Defaults to `PORT`, then 8080. `0` picks a free port. */
  port?: number;
  /**
   * How many runs this automation holds at once. Defaults to `MAX_CONCURRENT_RUNS`,
   * then 40. Must not exceed `service.maxConcurrentRuns` in the manifest, which is
   * what the platform believes: refusing above it is how backpressure reaches the
   * platform at all — a service that silently queues everything tells it nothing.
   */
  maxConcurrentRuns?: number;
  /**
   * Bound on an invoke body. The platform's webhook ingress accepts 256 KiB and the
   * invoke wraps that payload with the subscription's config and the token, so the
   * default is wider than the platform's own callback limit.
   */
  bodyLimitBytes?: number;
  /** Drain on SIGINT/SIGTERM. On by default; a test passes false. */
  handleSignals?: boolean;
  log?: Logger;
}

export interface RunningAutomation {
  port: number;
  inFlight(): number;
  /** Refuses new invokes from now on; already-accepted runs finish. */
  drain(): void;
  /** Drains, stops listening, and resolves once every accepted run has reported. */
  close(): Promise<void>;
}

export async function serve(options: ServeOptions): Promise<RunningAutomation> {
  const templateId = options.templateId;
  const log = options.log ?? jsonLogger(templateId);
  // Read strictly: a blank or misspelt value must stop the container, not start it
  // with capacity that is unbounded (NaN compares false) or zero (everything
  // refused) while the probe reports it healthy.
  const maxConcurrentRuns = options.maxConcurrentRuns ?? integerFrom('MAX_CONCURRENT_RUNS', 40, 1);
  const port = options.port ?? integerFrom('PORT', 8080, 1);
  const bodyLimitBytes = options.bodyLimitBytes ?? 1024 * 1024;

  const inFlight = new Set<Promise<void>>();
  let draining = false;

  /** A refusal, or null to accept. */
  function refuse(request: InvokeRequest): Extract<InvokeAck, { accepted: false }> | null {
    if (request.templateId !== templateId) {
      return { accepted: false, runId: request.runId, reason: 'unknown-template' };
    }
    if (draining) {
      return { accepted: false, runId: request.runId, reason: 'draining', retryAfterSeconds: 30 };
    }
    if (inFlight.size >= maxConcurrentRuns) {
      return {
        accepted: false,
        runId: request.runId,
        reason: 'at-capacity',
        retryAfterSeconds: 10,
      };
    }
    return null;
  }

  async function work(request: InvokeRequest): Promise<void> {
    const platform = clientFor(request);
    let result: RunResult;
    try {
      result = await options.execute(request, platform);
    } catch (error) {
      const reason = describe(error);
      log('error', 'run_failed', { runId: request.runId, reason });
      result = { outcome: 'failed', failureReason: reason };
    }
    // Reported exactly once. A refused result is not a failure of the run — the
    // work may be done, side effects included — so it is not re-reported as one;
    // it is logged, and the platform's own deadline sweep settles the run.
    try {
      await platform.reportResult(request.runId, result);
      log('info', 'run_finished', { runId: request.runId, outcome: result.outcome });
    } catch (error) {
      log('error', 'result_unreportable', {
        runId: request.runId,
        outcome: result.outcome,
        reason: describe(error),
      });
    }
  }

  async function invoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJson(request, bodyLimitBytes);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        // Answered, then closed: `connection: close` has Node end the socket once
        // the 413 is flushed. Destroying the request first (the obvious move) drops
        // the connection before the answer is written, and the platform sees a
        // transport failure rather than a refusal it can record.
        send(response, 413, { error: 'body_too_large' }, { close: true });
        return;
      }
      send(response, 400, { error: 'invalid_invoke' });
      return;
    }
    if (!isInvokeRequest(body)) {
      send(response, 400, { error: 'invalid_invoke' });
      return;
    }

    const refusal = refuse(body);
    if (refusal) {
      // A refusal is a real answer, returned 200 with accepted:false. The platform
      // records it as the reason the run failed rather than as a transport error.
      log('info', 'invoke_refused', { runId: body.runId, reason: refusal.reason });
      send(response, 200, refusal);
      return;
    }

    // Accepted. The work is tracked BEFORE the response is written, so a second
    // invoke arriving in the same tick counts it against capacity.
    const task = work(body).finally(() => inFlight.delete(task));
    inFlight.add(task);
    const ack: InvokeAck = { accepted: true, runId: body.runId };
    send(response, 200, ack);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/health/live') {
        // What the catalog probe reads. Answering 200 is the entire basis on which
        // this automation is reported `available`, so it means "this process can
        // accept a run" and nothing more generous — while draining it cannot.
        send(response, draining ? 503 : 200, {
          status: draining ? 'draining' : 'ok',
          templateId,
          contractVersion: CONTRACT_VERSION,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/invoke') {
        await invoke(request, response);
        return;
      }

      send(response, 404, { error: 'not_found' });
    } catch (error) {
      log('error', 'request_failed', { reason: describe(error) });
      if (!response.headersSent) send(response, 500, { error: 'internal_error' });
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  const drain = (): void => {
    draining = true;
  };
  const close = async (): Promise<void> => {
    // Refusing new invokes while finishing the ones already accepted is what
    // makes `draining` a real answer rather than a constant nobody sets.
    drain();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([...inFlight]);
    log('info', 'stopped', {});
  };

  if (options.handleSignals ?? true) {
    const shutdown = (signal: string): void => {
      log('info', 'stopping', { signal });
      void close();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  const address = server.address();
  const listening = typeof address === 'object' && address ? address.port : port;
  log('info', 'listening', { port: listening, contractVersion: CONTRACT_VERSION });
  return { port: listening, inFlight: () => inFlight.size, drain, close };
}

/** An integer from the environment, or the fallback when unset. Anything else refuses. */
function integerFrom(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (raw.trim() === '' || !Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer of at least ${minimum}, not ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

class BodyTooLarge extends Error {}

function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Past the limit nothing is buffered, so memory stays bounded while the
      // socket stays open long enough to be answered. Rejecting twice is a no-op.
      if (size > limit) {
        chunks.length = 0;
        reject(new BodyTooLarge('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(
          chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
      } catch {
        reject(new Error('body is not json'));
      }
    });
    request.on('error', reject);
  });
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  options: { close?: boolean } = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...(options.close ? { connection: 'close' } : {}),
  });
  response.end(payload);
}

/**
 * Structured logs, with one rule: never the payload.
 *
 * A run's input is a customer's document. Ids and outcomes are safe to keep; the
 * thing being processed is not.
 */
export function jsonLogger(service: string): Logger {
  return (level, message, fields = {}) => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service,
      message,
      ...fields,
    });
    if (level === 'error') console.error(line);
    else console.info(line);
  };
}

/** One line about an error, never empty: the platform refuses an empty reason. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return (message || 'unknown error').slice(0, 200);
}
