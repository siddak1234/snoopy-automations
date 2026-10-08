import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  loadPrompts,
  readManifests,
  type Automation,
  type Manifest,
} from '@autom8x/automation-sdk';

/**
 * The conformance test (platform BUILD-PLAN 25.3.5): every automation here is
 * built on the step runner, and what its code can do agrees with what its
 * manifests declare.
 *
 * - every step the code can report is declared by a manifest the container
 *   serves, and every declared step is implemented — the platform refuses an
 *   undeclared step with 422 and does not store it;
 * - every capability a prompt uses is in `requiredCapabilities` of every served
 *   manifest — the platform refuses an undeclared capability with 403 before
 *   anything reaches a vendor;
 * - every prompt file in the automation's `prompts/` directory is registered, so
 *   a template nobody wired in cannot sit there looking shipped;
 * - every `manifests/<id>.v<n>.json` is served by that automation's container.
 *
 * `defineAutomation` refuses the first two at startup; this test states the rules
 * for the repository and reads each automation's definition the way `main.ts`
 * builds it, from `src/automation.ts`'s `define(manifests)`.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const automationsRoot = join(repositoryRoot, 'automations');
const manifestsRoot = join(repositoryRoot, 'manifests');
const templateRoot = join(repositoryRoot, 'templates', 'automation');
const schemasRoot = join(repositoryRoot, 'contract', 'schemas');

interface AutomationModule {
  TEMPLATE_ID: string;
  define(manifests: readonly Manifest[]): Automation;
}

function childDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

async function load(directory: string): Promise<AutomationModule> {
  const file = join(directory, 'src', 'automation.ts');
  const label = relative(repositoryRoot, file);
  assert.ok(existsSync(file), `${label} is missing — an automation is defined there`);
  const module = (await import(pathToFileURL(file).href)) as Partial<AutomationModule>;
  assert.equal(typeof module.TEMPLATE_ID, 'string', `${label} exports no TEMPLATE_ID`);
  assert.equal(typeof module.define, 'function', `${label} exports no define(manifests)`);
  return module as AutomationModule;
}

function assertConforms(
  automation: Automation,
  manifests: readonly Manifest[],
  label: string,
): void {
  const declared = new Map(
    manifests.map((manifest) => [manifest.version, new Set(manifest.pipeline.map((s) => s.id))]),
  );
  for (const stepId of automation.steps) {
    assert.ok(
      [...declared.values()].some((ids) => ids.has(stepId)),
      `${label}: the code can report step "${stepId}", which no served manifest declares`,
    );
  }
  for (const [version, ids] of declared) {
    for (const stepId of ids) {
      assert.ok(
        automation.steps.includes(stepId),
        `${label}: v${version} declares step "${stepId}", which the code does not implement`,
      );
    }
  }
  for (const prompt of automation.prompts) {
    for (const manifest of manifests) {
      assert.ok(
        manifest.requiredCapabilities.includes(prompt.capability),
        `${label}: prompt ${prompt.id} v${prompt.version} uses ${prompt.capability}, which v${manifest.version} does not declare in requiredCapabilities`,
      );
    }
  }
  assert.deepEqual(
    automation.versions,
    manifests.map((manifest) => manifest.version),
    `${label}: the container serves every version in its manifests`,
  );
}

function assertPromptsRegistered(automation: Automation, directory: string, label: string): void {
  const promptsDirectory = join(directory, 'prompts');
  if (!existsSync(promptsDirectory)) {
    assert.equal(
      automation.prompts.length,
      0,
      `${label} registers prompts but has no prompts/ directory`,
    );
    return;
  }
  const registered = new Set(automation.prompts.map((prompt) => `${prompt.id}@${prompt.version}`));
  for (const prompt of loadPrompts(promptsDirectory)) {
    assert.ok(
      registered.has(`${prompt.id}@${prompt.version}`),
      `${label}/prompts holds ${prompt.id} v${prompt.version}, which define() does not register`,
    );
  }
}

test('every automation conforms to the manifests it serves', async () => {
  const directories = childDirectories(automationsRoot);
  assert.ok(directories.length > 0, 'automations/ holds no automation');
  for (const directory of directories) {
    const name = basename(directory);
    const module = await load(directory);
    assert.equal(
      module.TEMPLATE_ID,
      name,
      `automations/${name} declares templateId ${module.TEMPLATE_ID}`,
    );
    const manifests = readManifests(manifestsRoot, name);
    const automation = module.define(manifests);
    assert.equal(automation.templateId, name);
    assertConforms(automation, manifests, `automations/${name}`);
    assertPromptsRegistered(automation, directory, `automations/${name}`);
  }
});

test('the template automation conforms to its example manifest, which validates against the vendored schema', async () => {
  const module = await load(templateRoot);
  const manifests = readManifests(templateRoot, module.TEMPLATE_ID);
  const automation = module.define(manifests);
  assertConforms(automation, manifests, 'templates/automation');
  assertPromptsRegistered(automation, templateRoot, 'templates/automation');
  assert.ok(automation.prompts.length > 0, 'the template shows a prompt module');

  // Validated here because test/architecture.test.ts validates `manifests/` only,
  // and a template manifest that would be refused at registration teaches wrong.
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats.default(ajv);
  const validate = ajv.compile(
    JSON.parse(readFileSync(join(schemasRoot, 'automation-manifest.json'), 'utf8')) as object,
  );
  for (const file of readdirSync(templateRoot).filter((name) => /\.v\d+\.json$/u.test(name))) {
    const parsed: unknown = JSON.parse(readFileSync(join(templateRoot, file), 'utf8'));
    assert.ok(validate(parsed), `templates/automation/${file}: ${ajv.errorsText(validate.errors)}`);
  }
});
