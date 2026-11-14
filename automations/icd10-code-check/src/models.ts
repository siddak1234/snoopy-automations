/**
 * The models both AI steps ask (the spec, section 4; README, "Pick a model"): a primary that reads
 * PDFs and photos, then a fallback by another maker. Both were on OpenRouter's US zero-retention
 * list on 2026-10-28 with `structured_outputs`, `response_format`, `temperature` and `max_tokens`,
 * within the owner's price ceiling: Amazon Bedrock in the US, $1.10 and $5.50 per million prompt and
 * completion tokens; Google Vertex in the US, $0.275 and $1.65. The owner's setting wins over them.
 */
export const MODELS: readonly string[] = [
  'anthropic/claude-haiku-4.5',
  'google/gemini-3.1-flash-lite',
];

/**
 * The versions whose manifest says `dataProtection: 'hipaa'` (v4 and v5; README, "v4"): their runs
 * carry health data, so the platform sends their model calls only to its BAA gateway, which refuses
 * an automation's own `models` (the platform's ADR-0049, C2). Their calls name none, and the
 * platform's HIPAA default list serves them; a version still served on OpenRouter keeps `MODELS`.
 * `automations/icd10-code-check/test/v4-manifest.test.ts` holds this list to the manifests.
 */
export const HEALTH_VERSIONS: readonly number[] = [4, 5];

/** The models a call of a run on `version` names: none on a health version, else `MODELS`. */
export const modelsFor = (version: number): { models?: readonly string[] } =>
  HEALTH_VERSIONS.includes(version) ? {} : { models: MODELS };
