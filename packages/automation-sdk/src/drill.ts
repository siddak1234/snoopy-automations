import type { InvokeRequest, ModelCompletion, ProviderAnswer, RunResult } from './contract.js';
import { unanswered } from './marks.js';
import { retryClock } from './retry.js';
import type { Automation } from './steps.js';
import { NO_ANSWER, refusalFixture, type RecordingPlatform } from './testing.js';
import { FLOW_WORDS } from './words.js';

/**
 * The shared failure drill (Round 21, D2.5): every flow built on `defineFlow` runs it in its
 * `automations/<id>/test/drill.test.ts`, which `npm run scaffold` writes and `test/conformance.test.ts` requires.
 * It runs the flow on `RecordingPlatform` once per case, each failing what the flow reaches:
 *
 * - (a) a missing connection: the provider callback's 404, then its 403 `provider_not_declared`;
 * - (b) the vendor is down: a 502 that names no reason, then no answer at all;
 * - (c) a malformed AI answer: every answer off its schema, so the re-ask misses too — which must
 *   end `held`;
 * - (d) a timeout, on every provider and model call.
 *
 * Every case must end in a result, never a throw; a failure's reason and a hold's reason must be
 * one of the SDK's sentences (`FLOW_WORDS`) or in the flow's own words (its spec's §8 and
 * `words.md`, given as text); and no line the platform keeps may carry the failure's raw message
 * (a marker every injected error carries). The step retry's waits are skipped while it runs.
 * Throws one error naming every case that failed; returns each case, and whether the flow reached
 * what it failed (a flow with no provider never reaches (a)).
 */
export interface DrillFixture {
  /** The run each case starts with. */
  readonly request: InvokeRequest;
  /** A platform on which the run reaches its end when nothing fails: its files and answers. */
  readonly platform: () => RecordingPlatform;
  /** The flow's own words, as text: its spec (README.md) and words.md. */
  readonly words: string;
}

export interface DrillCase {
  readonly name: string;
  readonly reached: boolean;
  readonly result: RunResult | undefined;
  readonly problem: string | undefined;
}

/** In every injected error's text: found in a kept line, it is a raw message shown to people. */
export const DRILL_MARKER = 'drill-raw-message-7f3a';

const sentences = new Set<string>(Object.values(FLOW_WORDS));

const refused = (status: number, code: string, reason?: string) =>
  refusalFixture('provider', {
    status,
    code,
    detail: DRILL_MARKER,
    ...(reason === undefined ? {} : { details: { reason } }),
  });

const noAnswer = (name = 'TypeError'): Promise<never> =>
  unanswered(Promise.reject(Object.assign(new Error(DRILL_MARKER), { name })));

type Fail = (platform: RecordingPlatform) => void;

const CASES: readonly (readonly [string, Fail])[] = [
  ['a: not connected (404)', (p) => (p.provider = () => Promise.reject(refused(404, 'NOT_FOUND')))],
  [
    'a: provider_not_declared (403)',
    (p) => (p.provider = () => Promise.reject(refused(403, 'FORBIDDEN', 'provider_not_declared'))),
  ],
  [
    'b: vendor down (502)',
    (p) => {
      p.provider = () => Promise.reject(refused(502, 'DEPENDENCY_FAILURE'));
      p.model = () => Promise.resolve(NO_ANSWER);
    },
  ],
  [
    'b: no answer',
    (p) => {
      p.provider = (): Promise<ProviderAnswer> => noAnswer();
      p.model = (): Promise<ModelCompletion> => noAnswer();
    },
  ],
  [
    'c: malformed AI answer, twice',
    (p) =>
      (p.model = (_call, model) =>
        Promise.resolve({
          text: `${DRILL_MARKER} is not the JSON the schema asked for`,
          model,
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        })),
  ],
  [
    'd: timeout',
    (p) => {
      p.provider = (): Promise<ProviderAnswer> => noAnswer('TimeoutError');
      p.model = (): Promise<ModelCompletion> => noAnswer('TimeoutError');
    },
  ],
];

export async function failureDrill(
  automation: Automation,
  fixture: DrillFixture,
): Promise<DrillCase[]> {
  const allowed = (sentence: string) => sentences.has(sentence) || fixture.words.includes(sentence);
  const sleep = retryClock.sleep;
  retryClock.sleep = () => Promise.resolve();
  const cases: DrillCase[] = [];
  try {
    for (const [name, fail] of CASES) {
      const platform = fixture.platform();
      fail(platform);
      let result: RunResult | undefined;
      let problem: string | undefined;
      try {
        result = await automation.execute(fixture.request, platform);
      } catch (error) {
        problem = `threw ${error instanceof Error ? error.name : typeof error}`;
      }
      const kept = JSON.stringify([result, platform.steps]);
      const typed = platform.modelCalls.some((c) => Object.keys(c.outputSchema).length > 0);
      const reached = name.startsWith('c')
        ? typed
        : platform.providerCalls.length + platform.modelCalls.length > 0;
      if (problem === undefined && kept.includes(DRILL_MARKER)) problem = 'shows a raw message';
      if (problem === undefined && result?.outcome === 'failed' && !allowed(result.failureReason)) {
        problem = `ends with words in neither the SDK's nor the flow's: "${result.failureReason}"`;
      }
      if (problem === undefined && result?.outcome === 'held' && !allowed(result.held.reason)) {
        problem = `holds with words in neither the SDK's nor the flow's: "${result.held.reason}"`;
      }
      if (problem === undefined && name.startsWith('c') && reached && result?.outcome !== 'held') {
        problem = `ends ${result?.outcome ?? 'nowhere'}, not held for a person`;
      }
      cases.push({ name, reached, result, problem });
    }
  } finally {
    retryClock.sleep = sleep;
  }
  const failures = cases.filter((entry) => entry.problem !== undefined);
  if (failures.length > 0) {
    throw new Error(
      `the failure drill failed: ${failures.map((f) => `${f.name} ${f.problem}`).join('; ')}`,
    );
  }
  return cases;
}
