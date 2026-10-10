export {
  CAPABILITIES,
  CONTRACT_VERSION,
  MAIL_BODY_MAX_LENGTH,
  MAIL_SUBJECT_MAX_LENGTH,
  ONE_LINE_MAX_LENGTH,
  isArtifactListing,
  isArtifactReference,
  isCapability,
  isContinuation,
  isInvokeRequest,
  isMailAcceptance,
  isModelCompletion,
  isObject,
  oneLine,
  toArtifactListing,
  truncateText,
} from './contract.js';
export type {
  ArtifactListing,
  ArtifactReference,
  Capability,
  Continuation,
  InvokeAck,
  InvokeRequest,
  JsonObject,
  MailRequest,
  ModelCompletion,
  ModelRequest,
  ModelUsage,
  ProviderAnswer,
  ProviderRequest,
  RefusalReason,
  RunResult,
  StepOutcome,
  StepReport,
} from './contract.js';
export { isManifest, readManifest, readManifests } from './manifest.js';
export type { Manifest } from './manifest.js';
export { PlatformClient, boundedResult, clientFor } from './platform.js';
export type { AutomationPlatform, PlatformClientOptions } from './platform.js';
export {
  CallbackRefusedError,
  MODEL_REFUSAL_REASONS,
  ModelRefusedError,
  isModelRefusalReason,
  mailCertainlyNotSent,
} from './refusals.js';
export type { ModelRefusalReason } from './refusals.js';
export {
  definePrompt,
  loadPrompt,
  loadPrompts,
  readJsonCompletion,
  renderPrompt,
} from './prompt.js';
export type { PromptModule } from './prompt.js';
export type { RetryPolicy } from './retry.js';
export { defineAutomation } from './runner.js';
export { held, idempotencyKeyFor } from './steps.js';
export type {
  Automation,
  AutomationDefinition,
  ModelCallOptions,
  Step,
  StepContext,
  StepPlatform,
  StepResult,
} from './steps.js';
export { jsonLogger, serve } from './serve.js';
export type { Logger, RunningAutomation, ServeOptions } from './serve.js';
