import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isCapability,
  isObject,
  type Capability,
  type JsonObject,
  type ModelCompletion,
  type ModelRequest,
} from './contract.js';

/**
 * Prompt modules — a versioned template with its output schema.
 *
 * A prompt is data an automation ships, not a string built at run time: it has an
 * id and a version so a change to the words is a change somebody reviewed, it
 * names the CAPABILITY it needs rather than a model, and it carries the
 * `outputSchema` the platform holds the completion to. The run's input is what
 * the template is rendered from and what travels beside it as the model's input;
 * the document itself belongs in `input`, never in the template.
 *
 * There is deliberately no field for a model name, and `definePrompt` refuses a
 * module that carries `model` or `models`: a prompt says what is asked, and a step
 * names the models that answer on the call (`StepPlatform.callModel`), where the
 * request carries them as `models`. A module's copy would otherwise be dropped
 * without a word. The platform's model callback refuses the singular `model` on
 * the wire too (its §12.1 #193, and its BUILD-PLAN 25.2.16).
 */
export interface PromptModule {
  /** Lowercase letters, digits and hyphens, like a step id. */
  id: string;
  /** A positive integer. The words change, the version moves. */
  version: number;
  capability: Capability;
  /** The instruction. `{{field}}` is replaced by that field of the run's input. */
  template: string;
  /** Honoured by the platform, not merely counted; `{}` means free text. */
  outputSchema: JsonObject;
}

const PROMPT_ID = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/u;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

/** Validates a module and returns it frozen. Throws with a message that names the module, never its text. */
export function definePrompt(module: PromptModule): PromptModule {
  if (!isObject(module)) throw new Error('a prompt module must be an object');
  const id = typeof module.id === 'string' ? module.id : '?';
  if ('model' in module || 'models' in module) {
    throw new Error(`prompt ${id} names a model; a step names its models on the call`);
  }
  if (!PROMPT_ID.test(id)) {
    throw new Error(
      `prompt id ${JSON.stringify(id)} must be lowercase letters, digits and hyphens`,
    );
  }
  if (!Number.isInteger(module.version) || module.version < 1) {
    throw new Error(`prompt ${id} must carry a positive integer version`);
  }
  if (!isCapability(module.capability)) {
    throw new Error(`prompt ${id} v${module.version} names no capability the platform offers`);
  }
  if (typeof module.template !== 'string' || module.template.trim() === '') {
    throw new Error(`prompt ${id} v${module.version} has an empty template`);
  }
  if (!isObject(module.outputSchema)) {
    throw new Error(
      `prompt ${id} v${module.version} must carry an outputSchema object ({} for free text)`,
    );
  }
  return Object.freeze({
    id,
    version: module.version,
    capability: module.capability,
    template: module.template,
    outputSchema: module.outputSchema,
  });
}

/**
 * The template rendered from the run's input, as the model request the platform
 * accepts: the capability, the words, the input itself, the schema — and no model.
 */
export function renderPrompt(module: PromptModule, input: JsonObject): ModelRequest {
  const prompt = module.template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = input[name];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    // The field name, never the value: a missing field is the author's mistake
    // and the message becomes the run's failure reason on the platform.
    throw new Error(
      `prompt ${module.id} v${module.version} names {{${name}}}, which the input does not carry as text`,
    );
  });
  return { capability: module.capability, prompt, input, outputSchema: module.outputSchema };
}

/** One prompt file. An error names the path and never the content. */
export function loadPrompt(path: string): PromptModule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not a JSON file`);
  }
  try {
    return definePrompt(parsed as PromptModule);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : 'not a prompt module'}`);
  }
}

/**
 * Every `*.json` in an automation's prompt directory, by filename. Throws when the
 * directory is missing — an automation without prompts does not call this.
 */
export function loadPrompts(directory: string): PromptModule[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => loadPrompt(join(directory, file)));
}

/**
 * A completion's text as the JSON object its `outputSchema` asked for.
 *
 * Parsed here rather than by the author's `JSON.parse`, because Node's parse
 * error embeds a snippet of its input and an error's message becomes the run's
 * failure reason on the platform — so a model's restatement of the customer's
 * document would end up in a timeline. Nothing below quotes the text.
 *
 * The platform holds a structured completion to the schema itself and refuses a
 * truncated or filtered one as a typed 422 before any text is handed over
 * (`ModelRefusedError`, `refusals.ts`), so against it only a `stop` or `other`
 * completion reaches here; the checks stay for a platform that does not.
 */
export function readJsonCompletion(completion: ModelCompletion): JsonObject {
  if (completion.finishReason !== 'stop') {
    throw new Error(`the model stopped early (${completion.finishReason})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(completion.text);
  } catch {
    throw new Error('the model completion was not JSON');
  }
  if (!isObject(parsed)) throw new Error('the model completion was not a JSON object');
  return parsed;
}
