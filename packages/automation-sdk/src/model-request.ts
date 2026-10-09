/**
 * The models a model request may name, and the one rule each model id is held to —
 * copied from the platform, which answers a request outside them with a 400 before
 * anything is spent (its `apps/runs/src/routes-model.ts`, `requestedModels`; the rule is
 * `modelIdProblem` in its `packages/contracts/src/model-request.ts` — ADR-0033 decision 1
 * as amended 2026-10-09, BUILD-PLAN 25.2.16). Copied, not imported: the boundary is the
 * wire format. `test/contract.test.ts` holds this copy to the vendored
 * `automation-model-request.json` — the same pattern, the same bounds, the same answer
 * for every sample — and the words are the platform's own, so a mistake reads the same
 * in the container as in the platform's 400, only sooner and before anything left.
 *
 * A model id is 1–128 printable ASCII characters with no space, and two OpenRouter
 * spellings are refused, each because it switches on what zero data retention does not
 * cover — "It does not apply to plugins and tools you choose to enable, such as web
 * search" (https://openrouter.ai/docs/guides/features/zdr):
 *
 *   * any `@` — a preset, `@preset/<slug>` alone or after a model
 *     (`openai/gpt-4@preset/<slug>`), which can carry its own tools
 *     (https://openrouter.ai/docs/guides/features/presets);
 *   * a `:online` segment — web search on every call
 *     (https://openrouter.ai/docs/guides/routing/model-variants/online), wherever it sits,
 *     because suffixes combine in any order
 *     (https://openrouter.ai/docs/guides/routing/model-variants/overview).
 */
export const MODEL_REQUEST_LIMITS = {
  /** The primary and up to two fallbacks, tried in order. */
  models: 3,
  /** As long as the platform's ledger column holds a model. */
  modelIdLength: 128,
} as const;

/** Every rule at once: the published schema's `pattern`, character for character. */
export const MODEL_ID_PATTERN = new RegExp(
  `^(?!.*@)(?!.*:online(?::|$))[!-~]{1,${MODEL_REQUEST_LIMITS.modelIdLength}}$`,
  'u',
);

const SHAPE = new RegExp(`^[!-~]{1,${MODEL_REQUEST_LIMITS.modelIdLength}}$`, 'u');

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
  return "must not switch on OpenRouter's web search (':online')";
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
