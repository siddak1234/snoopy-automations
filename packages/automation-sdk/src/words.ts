/**
 * The words a person reads when a flow built on `defineFlow` stops, or goes on without something
 * (`flow.ts`, `settle.ts`): one plain sentence each, the same in every flow, so no flow shows the
 * error and another a raw message (Round 21, "standards across the automation flows"). Nothing
 * here carries a document, a vendor's own text or a model's words. A flow's own sentence for a
 * step (`FlowDefinition.sentences`) and its spec's §8 words (`words.md`) take the place of these
 * where it gives them.
 */
export const FLOW_WORDS = {
  /** Anything else: a step's own mistake, a report the platform refused. */
  other: 'Something went wrong. Try again.',
  /** Connections has no connection for the provider (its 404). */
  not_connected: "An app this flow uses isn't connected. Connect it, then run it again.",
  /** The run token does not carry the provider (403 `provider_not_declared`): the flow's mistake. */
  not_declared: "This flow can't use that app yet.",
  /** The vendor answered and refused. */
  vendor_refused: 'The connected app refused this. Check it, then run it again.',
  /** The vendor, or the platform's hop to it, did not answer usably. */
  vendor_down: "The connected app didn't answer. Try again in a minute.",
  /** No answer came at all. */
  unanswered: "This couldn't finish just now. Try again in a minute.",
  /** The model call got no usable answer in time. */
  ai_busy: 'AI is busy. Try again in a minute.',
  /** The model or the platform refused the call (a filter, the month's allowance, no model left). */
  ai_refused: "The AI couldn't read this. Try a clearer file.",
  /** The answer was cut off at the owner's cap, the most a call may ask for. */
  ai_too_long: "The AI's answer was too long to finish. Try a shorter file.",
  /** The answer missed its schema twice: the run waits for a person (Q2). */
  ai_unmatched: "The AI's answer needs a person to check it.",
  /** The run's time ran out. */
  timeout: 'This took too long. Try again.',
  /** A step the scaffold wrote and the developer has not (`npm run scaffold`). */
  not_built: 'Not built yet',
} as const;

export type FlowWord = keyof typeof FLOW_WORDS;

/** An optional connection chosen and not connected: the step goes on with this line (`optionalConnection`). */
export const notSentLine = (displayName: string): string =>
  `Not sent to ${displayName}: ${displayName} isn't connected`;
