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
