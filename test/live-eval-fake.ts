import type { Fetch, RunDetail } from '../scripts/live-eval/client.js';

/**
 * A fake of the live platform for `npm run live-eval`'s suite (the owner's Q4: "CI never calls a
 * model"): the workspace API's routes the eval calls — the subscription, an upload and its
 * completion, a run and its read, a job, its read and its archive — and the store's signed URL.
 * Each run's page is `pageOf(filename)`, the file the run was given, by its upload's name.
 */

export interface FakeOptions {
  readonly templateId: string;
  readonly version: number;
  readonly config?: Record<string, unknown>;
  readonly status?: string;
  /** What the job's read ends as: `ready` unless said. */
  readonly itemStatus?: string;
  /** The archive's answer: 200 unless said (403 for a member). */
  readonly archiveStatus?: number;
  /** The page a run of this file ends with. */
  readonly pageOf: (
    filename: string,
  ) => Omit<RunDetail, 'run'> & { run?: Partial<RunDetail['run']> };
}

export interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export const API = 'https://api.autom8x.test';
export const WORKSPACE = 'ws-1';
export const SUBSCRIPTION = 'sub-1';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakePlatform(options: FakeOptions) {
  const sent: Sent[] = [];
  const uploads = new Map<string, string>();
  const runs = new Map<string, { filename: string; reads: number }>();
  let made = 0;
  const fetch: Fetch = (url, init = {}) => {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === 'string' ? init.body : undefined;
    sent.push({ method, url, headers, body });
    if (url.startsWith('https://store.test/'))
      return Promise.resolve(new Response(null, { status: 200 }));
    const base = `${API}/v1/workspaces/${WORKSPACE}`;
    if (!url.startsWith(base)) return Promise.resolve(json({ detail: 'not here' }, 404));
    const path = url.slice(base.length);
    const input = body === undefined ? {} : (JSON.parse(body) as Record<string, any>);
    made += 1;
    if (method === 'GET' && path === `/subscriptions/${SUBSCRIPTION}`) {
      return Promise.resolve(
        json({
          subscription: {
            templateId: options.templateId,
            templateVersion: options.version,
            status: options.status ?? 'live',
            config: options.config ?? {},
          },
        }),
      );
    }
    if (method === 'POST' && path === '/uploads') {
      const id = `upload-${made}`;
      uploads.set(`artifact-${id}`, String(input.filename));
      return Promise.resolve(json({ uploadSessionId: id, uploadUrl: `https://store.test/${id}` }));
    }
    const completed = /^\/uploads\/(upload-\d+)\/complete$/u.exec(path);
    if (method === 'POST' && completed) {
      return Promise.resolve(json({ artifact: { artifactId: `artifact-${completed[1]}` } }));
    }
    if (method === 'POST' && path === `/subscriptions/${SUBSCRIPTION}/items`) {
      return Promise.resolve(json({ item: { id: 'item-1', status: 'reading' } }, 201));
    }
    if (method === 'GET' && path === '/items/item-1') {
      return Promise.resolve(
        json({ item: { id: 'item-1', status: options.itemStatus ?? 'ready' } }),
      );
    }
    if (method === 'POST' && path === '/items/item-1/archive') {
      const status = options.archiveStatus ?? 200;
      return Promise.resolve(
        status === 200
          ? json({ item: { id: 'item-1', status: 'ready', archivedAt: '2026-11-04T12:00:00Z' } })
          : json({ status, details: { requiredRole: 'admin' } }, status),
      );
    }
    if (method === 'POST' && path === '/runs') {
      const artifact = Object.values(input.input as Record<string, string>)[0] ?? '';
      const id = `run-${made}`;
      runs.set(id, { filename: uploads.get(artifact) ?? '', reads: 0 });
      return Promise.resolve(json({ run: { id, status: 'running' } }, 201));
    }
    const read = /^\/runs\/(run-\d+)$/u.exec(path);
    const run = read ? runs.get(read[1]!) : undefined;
    if (method === 'GET' && run) {
      run.reads += 1;
      // Read once while it runs, then ended.
      if (run.reads === 1)
        return Promise.resolve(json({ run: { id: read![1], status: 'running' } }));
      const page = options.pageOf(run.filename);
      return Promise.resolve(
        json({ ...page, run: { id: read![1], status: 'succeeded', ...(page.run ?? {}) } }),
      );
    }
    return Promise.resolve(json({ detail: 'not here' }, 404));
  };
  return { fetch, sent };
}

export const ENV_FOR = (overrides: Record<string, string | undefined> = {}) => ({
  AUTOM8X_EVAL_API_URL: API,
  AUTOM8X_EVAL_SESSION: 'session-SECRET-123',
  AUTOM8X_EVAL_WORKSPACE_ID: WORKSPACE,
  AUTOM8X_EVAL_SUBSCRIPTION_ID: SUBSCRIPTION,
  ...overrides,
});
