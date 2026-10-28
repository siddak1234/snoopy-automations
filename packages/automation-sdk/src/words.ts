/**
 * The words a person reads when a flow built on `defineFlow` stops, or goes on without something
 * (`flow.ts`, `settle.ts`): one plain sentence each, the same in every flow, so no flow shows the
 * error and another a raw message (Round 21, "standards across the automation flows"). Nothing
 * here carries a document, a vendor's own text or a model's words. A flow's own sentence for a
 * step (`FlowDefinition.sentences`) and its spec's §8 words (`words.md`) take the place of these
 * where it gives them.
 */
export const FLOW_WORDS = {
  /** Anything else, before any provider call answered: a step's own mistake, a refused report. */
  other: 'Something went wrong. Try again.',
  /** Connections has no connection for the provider (its 404). */
  not_connected: "An app this flow uses isn't connected. Connect it, then run it again.",
  /** The run token does not carry the provider (403 `provider_not_declared`): the flow's mistake. */
  not_declared: "This flow can't use that app yet.",
  /** The vendor answered and refused. */
  vendor_refused: 'The connected app refused this. Check it, then run it again.',
  /** The vendor answered that it is down, or the platform provably never sent the call. */
  vendor_down: "The connected app didn't answer. Try again in a minute.",
  /**
   * A provider call nothing answered that was not provably unsent: the app may have done it, and a
   * re-run is a new run's key, so it would do it again. Never "Try again".
   */
  unconfirmed: "The connected app didn't confirm this. Check it before you run this again.",
  /** A run that ends on a throw once a provider call answered: never "Try again" (`defineFlow`). */
  after_write:
    'Something went wrong after a connected app was used. Check it before you run this again.',
  /** No answer came at all. */
  unanswered: "This couldn't finish just now. Try again in a minute.",
  /**
   * The model call got no answer that decided anything: a 502/503/504 that decided nothing, a 429,
   * or a call that provably never left — what may clear on its own (`settle`'s `modelKind`).
   */
  ai_busy: 'AI is busy. Try again in a minute.',
  /** The platform refused the model call's request as too large (413): the file. */
  ai_too_large: 'This file is too large for the AI. Try a smaller file.',
  /** The platform refused the model call's request as malformed (400): the flow's own mistake. */
  ai_request: "This flow can't ask the AI yet.",
  /** The model or the platform refused the answer or the file (a filter, the file's type or size). */
  ai_refused: "The AI couldn't read this. Try a clearer file.",
  /** The plan's monthly AI allowance is spent (`over_plan_limit`). */
  ai_allowance: "This workspace's AI allowance is used up for the month.",
  /**
   * The AI cannot serve this flow at all: the plan grants none, the platform could not ask
   * (`capability_not_in_plan`, `entitlements_not_configured`), or no model the flow allows is
   * left (`no_model_left`). A clearer file or a re-run changes nothing.
   */
  ai_setup: "AI isn't set up for this flow yet.",
  /** The answer was cut off at the owner's cap, the most a call may ask for. */
  ai_too_long: "The AI's answer was too long to finish. Try a shorter file.",
  /** The answer missed its schema twice: the run waits for a person (Q2, `holdUnmatched`). */
  ai_unmatched: "The AI's answer needs a person to check it.",
  /** The answer missed its schema twice at a step whose next step cannot go on without it (Q2). */
  ai_unusable: "The AI's answer couldn't be used. Try a clearer file.",
  /** The run's time ran out. */
  timeout: 'This took too long. Try again.',
  /** A step the scaffold wrote and the developer has not (`npm run scaffold`). */
  not_built: 'Not built yet',
} as const;

export type FlowWord = keyof typeof FLOW_WORDS;

/** An optional connection chosen and not connected: the step goes on with this line (`optionalConnection`). */
export const notSentLine = (displayName: string): string =>
  `Not sent to ${displayName}: ${displayName} isn't connected`;
