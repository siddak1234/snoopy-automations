import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { manifestProblems, type Json } from './manifest-rules.js';

/**
 * Every manifest in `manifests/` held to the platform's validator rules a JSON Schema cannot say
 * (`test/manifest-rules.ts`), and each refusal bitten in the platform's words.
 */

const manifestsRoot = resolve(import.meta.dirname, '..', 'manifests');

const read = (file: string) =>
  JSON.parse(readFileSync(join(manifestsRoot, file), 'utf8')) as Json & {
    pipeline: Json[];
    groups?: Json[];
    setup: Json[];
    requiredConnections: Json[];
  };

test('every manifest here passes the rules the platform adds beyond the schema', () => {
  for (const file of readdirSync(manifestsRoot).filter((name) => name.endsWith('.json'))) {
    assert.deepEqual(manifestProblems(read(file)), [], `manifests/${file}`);
  }
});

test('the rules refuse what the platform refuses', () => {
  const v2 = read('invoice-processing.v2.json');
  const [vendor, ...settings] = v2.setup as [Json, ...Json[]];
  const [quickBooks] = v2.requiredConnections as [Json];
  const cases: [string, Json, string][] = [
    [
      'an optional connection with no choice',
      { ...v2, setup: settings },
      "setup: an optional connection needs one setup field with control 'connection'",
    ],
    [
      'two choices, neither naming its providers',
      { ...v2, setup: [vendor, { ...vendor, key: 'other' }, ...settings] },
      'setup[1].providers: with more than one connection field, each must name its providers',
    ],
    [
      'providers on a setting that is no connection',
      { ...v2, setup: [vendor, { ...settings[0]!, providers: ['quickbooks'] }] },
      'setup[1].providers: is only meaningful on a connection control',
    ],
    [
      'a provider that is not optional',
      { ...v2, setup: [{ ...vendor, providers: ['google'] }, ...settings] },
      'setup[0].providers[0]: must name optional connections only',
    ],
    [
      'one provider chosen by two fields',
      {
        ...v2,
        setup: [
          { ...vendor, providers: ['quickbooks'] },
          { ...vendor, key: 'other', providers: ['quickbooks'] },
        ],
      },
      'setup[1].providers[0]: names quickbooks, which another connection field names',
    ],
    [
      'an optional connection no field chooses',
      {
        ...v2,
        requiredConnections: [quickBooks, { ...quickBooks, providerId: 'google' }],
        setup: [{ ...vendor, providers: ['quickbooks'] }],
      },
      "setup: optional connection 'google' is chosen by no connection field",
    ],
    [
      'a setting drawn in a step group nobody declared',
      { ...v2, setup: [{ ...vendor, group: 'filed' }, ...settings] },
      'setup[0].group: must name a declared group',
    ],
    [
      'a setting in a group without groups',
      { ...v2, groups: undefined, setup: [{ ...vendor, group: 'done' }, ...settings] },
      'setup[0].group: group is only meaningful when groups are declared',
    ],
    [
      'a choice of nothing optional',
      { ...v2, requiredConnections: [{ ...quickBooks, optional: false }] },
      'setup[0].control: is only meaningful when requiredConnections has an optional entry',
    ],
    [
      'a choice outside its section',
      { ...v2, setup: [{ ...vendor, section: 'rules' }, ...settings] },
      "setup[0].section: must be 'connections' for a connection control",
    ],
    [
      'a choice defaulting to the vendor',
      { ...v2, setup: [{ ...vendor, defaultValue: 'quickbooks' }, ...settings] },
      "setup[0].defaultValue: must be 'none' for a connection control",
    ],
    [
      'an ungrouped step',
      {
        ...v2,
        pipeline: v2.pipeline.map(({ group: _group, ...step }, i) =>
          i === 3 ? step : { ...step, group: _group },
        ),
      },
      'pipeline[3].group: every step needs a group when groups are declared',
    ],
    [
      'a group no step or setting names',
      {
        ...v2,
        groups: [...(v2.groups ?? []), { id: 'filed', title: 'Filed', description: 'Filed.' }],
      },
      "groups[5]: group 'filed' has no step and no setting",
    ],
    [
      'a trigger outside the first group',
      {
        ...v2,
        pipeline: v2.pipeline.map((step, i) => (i === 0 ? { ...step, group: 'read' } : step)),
      },
      'pipeline[0].group: the trigger step belongs to the first group',
    ],
    [
      'a group without groups',
      { ...v2, groups: undefined },
      'pipeline[0].group: group is only meaningful when groups are declared',
    ],
  ];
  for (const [what, manifest, refusal] of cases) {
    assert.ok(
      manifestProblems(manifest).includes(refusal),
      `${what}: ${manifestProblems(manifest).join('; ')}`,
    );
  }
});

test("the rules refuse what the platform refuses of a step that is a setting, the platform's email step and a title by connection (ADR-0041)", () => {
  const v4 = read('invoice-processing.v4.json');
  const groups = v4.groups ?? [];
  const [upload, connect, process, record, email] = groups as [Json, Json, Json, Json, Json];
  const [vendor, limit] = v4.setup as [Json, Json];
  const titled = record.titleByConnection as Json;
  const quickBooks = { providerId: 'quickbooks', title: 'QuickBooks updated' };
  const withRecord = (changed: Json) => ({
    ...v4,
    groups: [upload, connect, process, { ...record, titleByConnection: changed }, email],
  });
  const cases: [string, Json, string][] = [
    [
      'a platform other than email',
      { ...v4, groups: [upload, connect, process, record, { ...email, platform: 'sms' }] },
      'groups[4].platform: must be email',
    ],
    [
      // As the platform's `validateGroups`: a value other than email is no platform's step.
      "a platform other than email: no platform's step, so a step with nothing in it",
      { ...v4, groups: [upload, connect, process, record, { ...email, platform: 'sms' }] },
      "groups[4]: group 'email' has no step and no setting",
    ],
    [
      "two of the platform's steps",
      { ...v4, groups: [upload, connect, process, record, email, { ...email, id: 'email-again' }] },
      "groups[5].platform: only one group may be the platform's",
    ],
    [
      // The platform keeps the first; the second is a step with nothing in it.
      "two of the platform's steps: the second is no platform's step",
      { ...v4, groups: [upload, connect, process, record, email, { ...email, id: 'email-again' }] },
      "groups[5]: group 'email-again' has no step and no setting",
    ],
    [
      "the trigger step in the platform's step: refused for being outside the first group too",
      {
        ...v4,
        pipeline: v4.pipeline.map((step, i) => (i === 0 ? { ...step, group: 'email' } : step)),
      },
      'pipeline[0].group: the trigger step belongs to the first group',
    ],
    [
      "the trigger step in the platform's step",
      {
        ...v4,
        pipeline: v4.pipeline.map((step, i) => (i === 0 ? { ...step, group: 'email' } : step)),
      },
      "pipeline[0].group: no pipeline step may be in the platform's step",
    ],
    [
      "the platform's step before another",
      { ...v4, groups: [upload, connect, process, email, record] },
      "groups[3].platform: the platform's step is the last group",
    ],
    [
      "a pipeline step in the platform's step",
      {
        ...v4,
        pipeline: v4.pipeline.map((step, i) => (i === 21 ? { ...step, group: 'email' } : step)),
      },
      "pipeline[21].group: no pipeline step may be in the platform's step",
    ],
    [
      "a setting in the platform's step",
      { ...v4, setup: [vendor, { ...limit, group: 'email' }] },
      "setup[1].group: no setting may be in the platform's step",
    ],
    [
      'a step with no pipeline step and no setting',
      { ...v4, setup: [{ ...vendor, group: undefined }, limit] },
      "groups[1]: group 'connect' has no step and no setting",
    ],
    [
      'a title by a field that is no connection field',
      withRecord({ ...titled, field: 'hold-above-amount' }),
      'groups[3].titleByConnection.field: must name a connection field',
    ],
    [
      'a title for a provider the field does not choose among',
      withRecord({ ...titled, titles: [{ ...quickBooks, providerId: 'xero' }] }),
      "groups[3].titleByConnection.titles[0].providerId: must be one of that field's providers",
    ],
    [
      'two titles for one provider',
      withRecord({ ...titled, titles: [quickBooks, { ...quickBooks, title: 'Recorded' }] }),
      'groups[3].titleByConnection.titles[1].providerId: is declared more than once',
    ],
  ];
  assert.deepEqual(manifestProblems(v4), [], 'v4 passes');
  for (const [what, manifest, refusal] of cases) {
    assert.ok(
      manifestProblems(manifest).includes(refusal),
      `${what}: ${manifestProblems(manifest).join('; ')}`,
    );
  }
});
