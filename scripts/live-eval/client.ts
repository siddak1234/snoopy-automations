// The live platform as `npm run live-eval` reaches it (Round 21, Stage 2, the owner's Q4): the
// public API a person's app uses, in one test workspace, under that workspace's session — read from
// the environment at run time, sent only in the Authorization header, and never printed, logged or
// written. The file goes straight to the store's signed URL, as the app's does. Every call is
// injected (`fetch`, `sleep`), so the suite runs it against a fake platform: CI never calls a model.
import { randomUUID } from 'node:crypto';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Where the eval runs, and how it waits. */
export interface Live {
  /** The API's origin, `https://…` (or `http://localhost…` for a local stack). */
  readonly api: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly fetch: Fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Between two reads of a run that has not ended. */
  readonly pollMs: number;
  /** The most a run may take before the eval gives up on it. */
  readonly runTimeoutMs: number;
}

/** A refusal or a fault, in words that name the call and its status — never the token or a body. */
export class EvalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

/** A file the eval uploads: a sample's, or the job description's. */
export interface EvalFile {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** What a run read answers, as far as the eval reads it (`RunDetail`, the platform's OpenAPI). */
export interface RunDetail {
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly templateVersion?: number;
    readonly title?: string;
    readonly failureReason?: string;
  };
  readonly documents?: readonly {
    readonly vendor?: { readonly name?: string | null };
    readonly number?: string | null;
    readonly total?: string | null;
  }[];
  readonly sections?: readonly {
    readonly title: string;
    readonly entries: readonly { readonly title: string; readonly subtitle?: string }[];
  }[];
}

/** The subscription the eval runs, as far as it reads it. */
export interface Subscription {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly status: string;
  readonly config: Record<string, unknown>;
}

/** A run has ended — or, held for a person, stopped where the eval reads it. */
export const ENDED = new Set(['succeeded', 'failed', 'held', 'cancelled']);

const problemReason = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { details?: { reason?: unknown } };
    return typeof body.details?.reason === 'string' ? body.details.reason : undefined;
  } catch {
    return undefined;
  }
};

/** One call to the workspace's API: JSON in and out, the session as the bearer. */
async function call<T>(
  live: Live,
  method: string,
  path: string,
  body?: unknown,
  keyed = false,
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${live.token}`,
    accept: 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (keyed) headers['idempotency-key'] = `live-eval-${randomUUID()}`;
  let response: Response;
  try {
    response = await live.fetch(`${live.api}/v1/workspaces/${live.workspaceId}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new EvalError(`${method} ${path} got no answer`);
  }
  if (!response.ok) {
    const reason = await problemReason(response);
    throw new EvalError(
      `${method} ${path} answered ${response.status}${reason === undefined ? '' : ` (${reason})`}`,
    );
  }
  return (await response.json()) as T;
}

export async function readSubscription(live: Live, id: string): Promise<Subscription> {
  const answer = await call<{ subscription: Subscription }>(live, 'GET', `/subscriptions/${id}`);
  return answer.subscription;
}

/** The most times a completed upload is asked again while the platform's measuring is busy (429). */
const MEASURE_TRIES = 6;

/** A file uploaded for the subscription: its `artifactId`, which a run's file field carries. */
export async function upload(live: Live, subscriptionId: string, file: EvalFile): Promise<string> {
  const ticket = await call<{ uploadSessionId: string; uploadUrl: string }>(
    live,
    'POST',
    '/uploads',
    {
      subscriptionId,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.bytes.byteLength,
    },
  );
  // The store's signed URL: the bytes and nothing else, never the session.
  const put = await live.fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.contentType },
    body: file.bytes,
  });
  if (!put.ok) throw new EvalError(`the store refused ${file.filename} with ${put.status}`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const done = await call<{ artifact: { artifactId: string } }>(
        live,
        'POST',
        `/uploads/${ticket.uploadSessionId}/complete`,
        {},
      );
      return done.artifact.artifactId;
    } catch (error) {
      const busy = error instanceof EvalError && error.message.includes('429');
      if (!busy || attempt >= MEASURE_TRIES) throw error;
      await live.sleep(live.pollMs);
    }
  }
}

/** A run started: its id. */
export async function startRun(
  live: Live,
  body: { subscriptionId: string; input: Record<string, string>; itemId?: string },
): Promise<string> {
  const answer = await call<{ run: { id: string } }>(live, 'POST', '/runs', body, true);
  return answer.run.id;
}

/** The run once it has ended, read whole; an `EvalError` past `runTimeoutMs`. */
export async function endedRun(live: Live, runId: string): Promise<RunDetail> {
  for (let waited = 0; ; waited += live.pollMs) {
    const detail = await call<RunDetail>(live, 'GET', `/runs/${runId}`);
    if (ENDED.has(detail.run.status)) return detail;
    if (waited >= live.runTimeoutMs) {
      throw new EvalError(`run ${runId} had not ended after ${live.runTimeoutMs / 1000} s`);
    }
    await live.sleep(live.pollMs);
  }
}

/** An item made from a file (a job, for a flow with items), once its file is read: its id. */
export async function readyItem(
  live: Live,
  subscriptionId: string,
  fields: Record<string, string>,
  artifactId: string,
): Promise<string> {
  const made = await call<{ item: { id: string } }>(
    live,
    'POST',
    `/subscriptions/${subscriptionId}/items`,
    { fields, file: artifactId },
    true,
  );
  for (let waited = 0; ; waited += live.pollMs) {
    const { item } = await call<{ item: { status: string } }>(
      live,
      'GET',
      `/items/${made.item.id}`,
    );
    if (item.status === 'ready') return made.item.id;
    if (item.status === 'failed') throw new EvalError('the job could not be made from its file');
    if (waited >= live.runTimeoutMs) throw new EvalError('the job was not ready in time');
    await live.sleep(live.pollMs);
  }
}
