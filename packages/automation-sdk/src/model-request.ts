import type { ModelRequest } from './contract.js';

/**
 * The models a model request may name, and the one rule each model id is held to —
 * copied from the platform, which answers a request outside them with a 400 before
 * anything is spent (`snoopy-backend/apps/runs/src/routes-model.ts`, `requestedModels`; the rule is
 * `modelIdProblem` in `snoopy-backend/packages/contracts/src/model-request.ts` — ADR-0033 decision 1
 * as amended 2026-10-09, BUILD-PLAN 25.2.16). Copied, not imported: the boundary is the
 * wire format. `packages/automation-sdk/test/contract-model-request.test.ts` holds this copy to the vendored
 * `automation-model-request.json` — the same pattern, the same bounds, the same answer
 * for every sample — and the words are the platform's own, so a mistake reads the same
 * in the container as in the platform's 400, only sooner and before anything left.
 *
 * A model id is 1–128 characters from OpenRouter's own lowercase set — letters, digits and
 * `. _ : / ~ -` — because OpenRouter reads an id without regard to case (its model API
 * answers `OpenAI/GPT-4o` as `openai/gpt-4o`), so a rule that read case could be walked
 * past (`:ONLINE`). Three OpenRouter spellings are refused, each because it switches on
 * what zero data retention does not cover — "It does not apply to plugins and tools you
 * choose to enable, such as web search" (https://openrouter.ai/docs/guides/features/zdr):
 *
 *   * any `@` — a preset, `@preset/<slug>` alone or after a model
 *     (`openai/gpt-4@preset/<slug>`), which can carry its own tools
 *     (https://openrouter.ai/docs/guides/features/presets);
 *   * a `:online` segment — web search on every call
 *     (https://openrouter.ai/docs/guides/routing/model-variants/online), wherever it sits,
 *     because suffixes combine in any order
 *     (https://openrouter.ai/docs/guides/routing/model-variants/overview);
 *   * OpenRouter's own namespace — `openrouter/…` and `~openrouter/…` are routers that pick
 *     models, and can run tools, the request never named (the platform's review of its
 *     25.2.16, 2026-10-09).
 *
 * And two variants are refused by the owner's cost guard (the platform's BUILD-PLAN
 * 25.2.19, 2026-10-09), because each re-routes the call to a service tier the platform did
 * not choose: `:nitro` admits priority-tier endpoints, billed at priority rates
 * (https://openrouter.ai/docs/guides/routing/model-variants/nitro), and `:floor` admits
 * flex-tier endpoints, "cheaper, in exchange for higher latency and lower availability"
 * (https://openrouter.ai/docs/guides/features/service-tiers).
 */
export const MODEL_REQUEST_LIMITS = {
  /** The primary and up to two fallbacks, tried in order. */
  models: 3,
  /** As long as the platform's ledger column holds a model. */
  modelIdLength: 128,
  /** The makers one call may leave out (25.2.29): as many as a list holds models. */
  excludeModelAuthors: 3,
  /**
   * The owner's cap on one answer, in tokens (the platform's `MODEL_ANSWER_TOKEN_CAP`, sent on
   * every call): `maxOutputTokens` may ask for less, 1 to this, never more (the platform's Round
   * 21; the published schema's `maximum`). Without it the platform sends the cap.
   */
  maxOutputTokens: 8_000,
} as const;

/** Every rule at once: the published schema's `pattern`, character for character. */
export const MODEL_ID_PATTERN = new RegExp(
  `^(?!~?openrouter/)(?!.*:online(?::|$))(?!.*:(?:nitro|floor)(?::|$))[a-z0-9._:/~-]{1,${MODEL_REQUEST_LIMITS.modelIdLength}}$`,
  'u',
);

const SHAPE = new RegExp(`^[!-~]{1,${MODEL_REQUEST_LIMITS.modelIdLength}}$`, 'u');
const OPENROUTER_SET = /^[a-z0-9._:/~-]+$/u;
const ROUTER = /^~?openrouter\//u;
const WEB_SEARCH = /:online(?::|$)/u;

/**
 * Why `value` is not a model id the platform sends, in its words; undefined when it is
 * one. The decision is `MODEL_ID_PATTERN`'s alone; the other two tests choose the words.
 */
export function modelIdProblem(value: unknown): string | undefined {
  if (typeof value === 'string' && MODEL_ID_PATTERN.test(value)) return undefined;
  if (typeof value !== 'string' || !SHAPE.test(value)) {
    return `must be 1–${MODEL_REQUEST_LIMITS.modelIdLength} printable ASCII characters, no space`;
  }
  if (value.includes('@')) return "must not name an OpenRouter preset ('@')";
  if (!OPENROUTER_SET.test(value)) {
    return "must use only lowercase letters, digits and . _ : / ~ -, as OpenRouter's ids do";
  }
  if (ROUTER.test(value)) {
    return "must not name an OpenRouter router ('openrouter/…'), which runs models and tools the request never named";
  }
  if (WEB_SEARCH.test(value)) return "must not switch on OpenRouter's web search (':online')";
  return "must not choose OpenRouter's ':nitro' or ':floor' routing, a service tier the platform did not choose";
}

/**
 * Why `models` is not a list the platform accepts, in the words of its 400; undefined
 * when it is one. Its checks in its order: one to three entries, each id held to the
 * rule, no id twice. `undefined` is the caller's to skip — a request without `models` is
 * served by the platform's default — and anything else, `null` included, is checked.
 */
export function modelsProblem(models: unknown): string | undefined {
  const most = MODEL_REQUEST_LIMITS.models;
  if (!Array.isArray(models) || models.length === 0 || models.length > most) {
    return `models must list 1 to ${most} model ids`;
  }
  for (const [index, id] of (models as unknown[]).entries()) {
    const problem = modelIdProblem(id);
    if (problem) return `models[${index}] ${problem}`;
  }
  if (new Set(models).size !== models.length) return 'models must not name a model twice';
  return undefined;
}

/**
 * An uploaded file's id, as the platform's rule has it (`ARTIFACT_ID_PATTERN` in its
 * `@snoopy/contracts`, the emitted schema's `artifactId.pattern`) — copied, as the
 * model-id rule above is, and held to the vendored schema by
 * `packages/automation-sdk/test/contract-model-request.test.ts`.
 */
export const ARTIFACT_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;

/**
 * Why `artifactId` is not an id the platform takes, in the words of its 400; undefined
 * when it is one. `undefined` is the caller's to skip: a call without a file names none.
 */
export function artifactIdProblem(artifactId: unknown): string | undefined {
  return typeof artifactId === 'string' && ARTIFACT_ID_PATTERN.test(artifactId)
    ? undefined
    : 'artifactId must be the id of an uploaded file';
}

/**
 * A model's maker, which a model call may leave out — the platform's BUILD-PLAN 25.2.29, the
 * owner's decision of 2026-10-10 ("Approve group 2"): "an AI call can exclude a model maker: the
 * platform removes it from your switch, the code list or the default list, and refuses with no
 * charge if no other maker is left". Invoice Processing reads each invoice twice, and its second
 * read must be by another maker than the model that served the first, whatever the owner's
 * setting names. Copied, as the model-id rule above is, from the platform's
 * `snoopy-backend/packages/contracts/src/model-request.ts` (`MODEL_AUTHOR_PATTERN`, `modelAuthor`,
 * `excludeModelAuthorsProblem`) on its branch `round-17/model-author-exclusion` at `e25fd74`,
 * not yet merged, and held to the vendored schema by `packages/automation-sdk/test/contract-model-request.test.ts`.
 *
 * The maker is OpenRouter's "author": the part of a model id before its `/`. Held to the model-id
 * rule's own characters less its three markers — `/` ends an author, `:` begins a variant and
 * `~` marks an alias — and lowercase, as an id is: 1–128 lowercase letters, digits and `. _ -`.
 */
export const MODEL_AUTHOR_PATTERN = new RegExp(
  `^[a-z0-9._-]{1,${MODEL_REQUEST_LIMITS.modelIdLength}}$`,
  'u',
);

/**
 * The maker of `model`, undefined when its id names none: the part before the first `/`, an
 * alias's after its `~` (`~anthropic/claude-sonnet-latest` is Anthropic's). An id with no `/`
 * names no maker, so no exclusion removes it. The same reading serves a completion's `model`,
 * the model that served, which is how a second call learns whose model the first one was.
 */
export function modelAuthor(model: string): string | undefined {
  const slash = model.indexOf('/');
  const author = slash < 0 ? '' : model.slice(model.startsWith('~') ? 1 : 0, slash);
  return author === '' ? undefined : author;
}

/**
 * Why `value` is not a list of makers a model call may leave out, in the words of the
 * platform's 400; undefined when it is one: one to three distinct authors, each held to
 * `MODEL_AUTHOR_PATTERN`. `undefined` is the caller's to skip — a call that excludes nothing
 * names none — and anything else, `null` included, is checked.
 */
export function excludeModelAuthorsProblem(value: unknown): string | undefined {
  const most = MODEL_REQUEST_LIMITS.excludeModelAuthors;
  if (!Array.isArray(value) || value.length === 0 || value.length > most) {
    return `excludeModelAuthors must list 1 to ${most} model authors`;
  }
  for (const [index, author] of (value as unknown[]).entries()) {
    if (typeof author !== 'string' || !MODEL_AUTHOR_PATTERN.test(author)) {
      return (
        `excludeModelAuthors[${index}] must be a model author, the part of a model id before ` +
        `its '/': 1–${MODEL_REQUEST_LIMITS.modelIdLength} lowercase letters, digits and . _ -`
      );
    }
  }
  if (new Set(value).size !== value.length) {
    return 'excludeModelAuthors must not name an author twice';
  }
  return undefined;
}

/** Why `value` is not a cap the platform takes for one answer: a whole number from 1 to the owner's cap. */
export function maxOutputTokensProblem(value: unknown): string | undefined {
  const most = MODEL_REQUEST_LIMITS.maxOutputTokens;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= most
    ? undefined
    : `maxOutputTokens must be a whole number from 1 to ${most}`;
}

/**
 * Why the platform would answer this request's own lists with a 400, in its words, or undefined:
 * its `models`, then its `excludeModelAuthors`, then its `artifactId`, then its
 * `maxOutputTokens`, each only when present.
 * What the client (`platform.ts`) and the recording double (`testing.ts`) refuse before anything
 * is sent or recorded, so the two cannot disagree.
 */
export function modelRequestProblem(request: ModelRequest): string | undefined {
  return (
    (request.models === undefined ? undefined : modelsProblem(request.models)) ??
    (request.excludeModelAuthors === undefined
      ? undefined
      : excludeModelAuthorsProblem(request.excludeModelAuthors)) ??
    (request.artifactId === undefined ? undefined : artifactIdProblem(request.artifactId)) ??
    (request.maxOutputTokens === undefined
      ? undefined
      : maxOutputTokensProblem(request.maxOutputTokens))
  );
}
