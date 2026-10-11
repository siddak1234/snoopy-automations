import { createHash } from 'node:crypto';

import type { JsonObject, ProviderAnswer, ProviderRequest } from '@autom8x/automation-sdk';
import type { ProblemInput } from '@autom8x/automation-sdk/testing';

import {
  faultAnswer,
  queryAnswer,
  readAnswer,
  sampleCompany,
  type SimulatedCompany,
} from './quickbooks-company.js';

/**
 * QuickBooks behind the platform, for a suite: plugged in as `RecordingPlatform.provider`
 * (`platform.provider = simulator.provider`), it answers as QuickBooks does and holds the
 * platform's Connections to its rules, read at snoopy-backend `4875579`
 * (`apps/connections/src/routes-operations.ts`, `operations.ts`; `apps/runs/src/connections-client.ts`):
 *
 * - **No live connection** is a 404 before anything else — a replay included.
 * - **A final answer is recorded per idempotency key** with the request it answered, and
 *   replayed for the same request under that key without asking QuickBooks; a DIFFERENT
 *   request under a used key is refused 409 `idempotency_key_reused`.
 * - **Nothing is recorded for 5xx, 401, 403, 408, 425 or 429**, so a repeat asks again.
 * - **An answer over 192 KiB** reaches the automation as a 502 naming no reason, recorded nowhere.
 * - **An input naming `accountId`** — the platform fills it — is refused 400 `reserved_parameter`.
 *
 * QuickBooks itself answers from `company`: `companyInfo.get`, `preferences.get`, and
 * `query.run` for exactly the text `lookupQuery` builds on `Account` by
 * `FullyQualifiedName`, matched without case as Intuit matches; any other query text is a
 * 400 parser Fault, so a changed query fails the suite that sent it. `script` queues
 * answers or refusals per operation ahead of the company's.
 *
 * The kit runs on Node built-ins alone, so the simulator throws a refusal through the
 * SDK's own `refusalFixture`, which the suite hands it — the very error the SDK's client
 * throws for that answer, so the SDK's step retry reads it exactly as it reads the wire.
 */

/** Connections' bound on a provider's answer (`MAXIMUM_RESPONSE_BYTES`). */
const MAXIMUM_ANSWER_BYTES = 192 * 1024;

/** The platform's refusals of a QuickBooks call, as its Runs service writes them. */
export const PROVIDER_REFUSALS = {
  /** No live QuickBooks connection, or one waiting to be reconnected. */
  notConnected: (): ProblemInput => ({
    status: 404,
    code: 'NOT_FOUND',
    detail: 'The requested resource was not found',
  }),
  /** QuickBooks unreachable, slower than Connections' 10 s, or an answer over 192 KiB. */
  noAnswer: (): ProblemInput => ({
    status: 502,
    code: 'DEPENDENCY_FAILURE',
    detail: 'The provider call failed',
    details: { providerId: 'quickbooks' },
  }),
  /** Connections refused the request itself: `insufficient_scope`, `reserved_parameter`, … */
  badRequest: (operation: string, reason: string): ProblemInput => ({
    status: 400,
    code: 'BAD_REQUEST',
    detail: 'The provider request was refused',
    details: { reason, providerId: 'quickbooks', operation },
  }),
  keyReused: (operation: string): ProblemInput => ({
    status: 409,
    code: 'CONFLICT',
    detail: 'The idempotency key was already used for a different provider request',
    details: { reason: 'idempotency_key_reused', providerId: 'quickbooks', operation },
  }),
  notConfigured: (operation: string): ProblemInput => ({
    status: 503,
    code: 'NOT_CONFIGURED',
    detail: 'The connections service is not configured',
    details: { reason: 'connections_not_configured', providerId: 'quickbooks', operation },
  }),
  providerNotDeclared: (): ProblemInput => ({
    status: 403,
    code: 'FORBIDDEN',
    detail: 'The automation did not declare that provider',
    details: { providerId: 'quickbooks', reason: 'provider_not_declared' },
  }),
} as const;

/**
 * The next call's outcome: QuickBooks' own answer — a `body`, else the company's answer
 * for a 2xx and a Fault with the status as its code otherwise — or the platform refusing
 * the callback, which reaches no QuickBooks and records nothing.
 */
export type ScriptedAnswer =
  { readonly status: number; readonly body?: unknown } | { readonly refuse: ProblemInput };

export interface SimulatedCall {
  readonly operation: string;
  readonly input: JsonObject;
  readonly idempotencyKey: string;
  /** Asked of QuickBooks, answered from Connections' record, or refused by the platform. */
  readonly outcome: 'answered' | 'replayed' | 'refused';
  /** QuickBooks' status, or the refusal's. */
  readonly status: number;
}

export interface QuickBooksSimulatorOptions {
  /** `refusalFixture` from `@autom8x/automation-sdk/testing`. */
  readonly refusal: (callback: string, problem: ProblemInput) => Error;
}

export class QuickBooksSimulator {
  /** What QuickBooks holds — a fresh made-up company; a test edits it between calls. */
  public company: SimulatedCompany = sampleCompany();
  /** `false` is no live connection. */
  public connected = true;
  /** Every call, in order, with how it ended. */
  public readonly calls: SimulatedCall[] = [];
  readonly #refusal: QuickBooksSimulatorOptions['refusal'];
  readonly #scripts = new Map<string, ScriptedAnswer[]>();
  readonly #records = new Map<string, { hash: string; answer: ProviderAnswer }>();

  public constructor(options: QuickBooksSimulatorOptions) {
    this.#refusal = options.refusal;
  }

  /** Queues outcomes for the next calls of `operation`, in order, ahead of the company's answers. */
  public script(operation: string, answers: readonly ScriptedAnswer[]): void {
    this.#scripts.set(operation, [...(this.#scripts.get(operation) ?? []), ...answers]);
  }

  /** `RecordingPlatform.provider`. */
  public readonly provider = async (call: ProviderRequest): Promise<ProviderAnswer> => {
    if (call.providerId !== 'quickbooks') {
      throw new Error(`the QuickBooks simulator was asked for provider ${call.providerId}`);
    }
    if (!this.connected) return this.#refuse(call, PROVIDER_REFUSALS.notConnected());
    const hash = requestHash(call);
    const record = this.#records.get(call.idempotencyKey);
    if (record) {
      if (record.hash !== hash) {
        return this.#refuse(call, PROVIDER_REFUSALS.keyReused(call.operation));
      }
      this.#log(call, 'replayed', record.answer.status);
      return structuredClone(record.answer);
    }
    if (Object.hasOwn(call.input, 'accountId')) {
      return this.#refuse(call, PROVIDER_REFUSALS.badRequest(call.operation, 'reserved_parameter'));
    }
    const scripted = this.#scripts.get(call.operation)?.shift();
    if (scripted && 'refuse' in scripted) return this.#refuse(call, scripted.refuse);
    const answer = scripted ? this.#scripted(call, scripted) : this.#quickBooks(call);
    if (Buffer.byteLength(JSON.stringify(answer.body ?? null)) > MAXIMUM_ANSWER_BYTES) {
      return this.#refuse(call, PROVIDER_REFUSALS.noAnswer());
    }
    if (isFinalAnswer(answer.status)) {
      this.#records.set(call.idempotencyKey, { hash, answer: structuredClone(answer) });
    }
    this.#log(call, 'answered', answer.status);
    return answer;
  };

  #scripted(call: ProviderRequest, scripted: { status: number; body?: unknown }): ProviderAnswer {
    if (scripted.body !== undefined) {
      return { status: scripted.status, body: structuredClone(scripted.body) };
    }
    if (scripted.status >= 200 && scripted.status < 300) {
      return { ...this.#quickBooks(call), status: scripted.status };
    }
    return { status: scripted.status, body: faultAnswer(String(scripted.status)) };
  }

  /** QuickBooks answering from the company. */
  #quickBooks(call: ProviderRequest): ProviderAnswer {
    switch (call.operation) {
      case 'companyInfo.get':
        return { status: 200, body: readAnswer('CompanyInfo', this.company.companyInfo) };
      case 'preferences.get':
        return { status: 200, body: readAnswer('Preferences', this.company.preferences) };
      case 'query.run': {
        const lookup = ACCOUNT_LOOKUP.exec(String(call.input.query));
        if (!lookup) return { status: 400, body: faultAnswer('4000') };
        const name = lookup[1]!.replace(/\\(.)/gu, '$1').toLowerCase();
        const rows = this.company.accounts.filter(
          (account) => String(account.FullyQualifiedName).toLowerCase() === name,
        );
        return { status: 200, body: queryAnswer('Account', rows.slice(0, Number(lookup[2]))) };
      }
      default:
        throw new Error(`the QuickBooks simulator does not answer ${call.operation}`);
    }
  }

  #refuse(call: ProviderRequest, problem: ProblemInput): never {
    this.#log(call, 'refused', problem.status);
    throw this.#refusal('provider', problem);
  }

  #log(call: ProviderRequest, outcome: SimulatedCall['outcome'], status: number): void {
    this.calls.push({
      operation: call.operation,
      input: structuredClone(call.input),
      idempotencyKey: call.idempotencyKey,
      outcome,
      status,
    });
  }
}

/** Exactly `lookupQuery('Account', 'FullyQualifiedName', value, n)`: the value, then n. */
const ACCOUNT_LOOKUP =
  /^SELECT \* FROM Account WHERE FullyQualifiedName = '((?:[^'\\]|\\.)*)' AND Active IN \(true, false\) MAXRESULTS ([1-9][0-9]{0,3})$/u;

/** Connections records an answer that is the provider's verdict on the request (`isFinalAnswer`). */
function isFinalAnswer(status: number): boolean {
  return status < 500 && ![401, 403, 408, 425, 429].includes(status);
}

/** Connections' request identity: sha256 of the canonical `{ providerId, operation, input }`. */
function requestHash(call: ProviderRequest): string {
  const request = { providerId: call.providerId, operation: call.operation, input: call.input };
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

/** Keys sorted at every depth; arrays keep their order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as JsonObject)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
