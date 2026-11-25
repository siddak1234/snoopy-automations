import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SERVED_VERSIONS } from '../src/automation.js';
import { EHR, EHR_FIELD } from '../src/v6/paths.js';
import { WORDS_V6 } from '../src/v6/words.js';
import { flow } from './fixtures.js';

/**
 * v6's manifest (README, "v6"; BUILD-PLAN 30.6.1 and 30.21.5): v5's, word for word, but its
 * version, its own origin and service account, its ways to start — v5's manual one unchanged and
 * the EHR's `patient-view` hook — the EHR connection, optional, with the operations the code calls
 * and only their scopes, the setup's Connections section and its "Integrations" renamed
 * "Continuous improvement" (30.10.4), the two steps of the EHR, and the output's `diagnosisCodes`
 * and `chartNote`. This image serves v6 alone; v5's file stays, served by its own container until
 * v6 is live.
 */

type Json = Record<string, any>;
const manifestsDir = join(flow, '..', '..', 'manifests');
const read = (version: number): Json =>
  JSON.parse(readFileSync(join(manifestsDir, `icd10-code-check.v${version}.json`), 'utf8')) as Json;
const v5 = read(5);
const v6 = read(6);
const menu = JSON.parse(
  readFileSync(join(flow, '..', '..', 'contract', 'schemas', 'platform-menu.json'), 'utf8'),
) as Json;

/** A manifest without what v6 changes: each part v6 adds taken out, the sections and their ids. */
function withoutV6(manifest: Json): Json {
  const {
    version: _v,
    service,
    trigger,
    triggers,
    requiredConnections,
    setupSections: _s,
    setup,
    pipeline,
    outputSchema,
    ...rest
  } = manifest;
  const { origin: _o, serviceAccount: _a, ...kept } = service as Json;
  const { diagnosisCodes: _d, chartNote: _c, ...properties } = outputSchema.properties as Json;
  return {
    ...rest,
    service: kept,
    trigger: trigger ?? (triggers as Json[])[0],
    requiredConnections: (requiredConnections as Json[]).filter((c) => c.providerId !== EHR),
    setup: (setup as Json[])
      .filter((field) => field.key !== EHR_FIELD)
      .map(({ sectionId: _id, ...field }) => field),
    pipeline: (pipeline as Json[]).filter((s) => !['read-chart', 'write-chart'].includes(s.id)),
    outputSchema: { ...outputSchema, properties },
  };
}

test("v6 is v5's manifest, word for word, but for what it adds", () => {
  assert.deepEqual(withoutV6(v6), withoutV6(v5));
  assert.equal(v6.version, 6);
  assert.equal(v6.dataProtection, 'hipaa', 'its runs carry health data, its EHR connection too');
  assert.equal(v6.service.origin, 'http://icd10-code-check-v6.autom8x.internal:8080');
  assert.equal(v6.service.serviceAccount, 'icd10-code-check-v6@autom8x.iam.gserviceaccount.com');
  assert.equal(v6.trigger, undefined, 'one of trigger and triggers');
});

test("its ways to start: v5's upload, unchanged, then the EHR's patient-view hook", () => {
  assert.deepEqual(v6.triggers, [
    v5.trigger,
    { kind: 'provider-event', connection: EHR, event: 'patient-view' },
  ]);
  assert.ok((menu.providerEvents[EHR] as string[]).includes('patient-view'));
  assert.ok((menu.triggers as string[]).includes('provider-event'));
});

/** The `operation: '…'` literals a source file holds, one or a union of several. */
const literals = (text: string): string[] =>
  [...text.matchAll(/\boperation\??\s*:\s*((?:(['"])[^'"]+\2\s*\|?\s*)+)/gu)].flatMap((m) =>
    [...m[1]!.matchAll(/(['"])([^'"]+)\1/gu)].map((one) => one[2]!),
  );

test('the EHR connection: optional, the operations v6 calls and only the scopes they need', () => {
  const [nppes, ehr] = v6.requiredConnections as Json[];
  assert.deepEqual(nppes, v5.requiredConnections[0], "v5's NPI Registry, unchanged");
  const v6Dir = join(flow, 'src', 'v6');
  const called = new Set(
    readdirSync(v6Dir).flatMap((file) => literals(readFileSync(join(v6Dir, file), 'utf8'))),
  );
  assert.deepEqual([...called].sort(), [...(ehr!.operations as string[])].sort());
  assert.deepEqual(ehr!.operations, [
    'notes.search',
    'binary.read',
    'patients.search',
    'encounters.search',
    'notes.create',
  ]);
  const offered = (menu.providers as Json[]).find((p) => p.id === EHR)!.operations as Json[];
  const needed = new Set(
    (ehr!.operations as string[]).flatMap(
      (name) => offered.find((op) => op.name === name)!.scopes as string[],
    ),
  );
  assert.deepEqual([...(ehr!.scopes as string[])].sort(), [...needed].sort());
  assert.equal(ehr!.optional, true);
  assert.equal(ehr!.displayName, 'EHR');
  assert.ok(ehr!.purpose.length <= 200);
});

test('the setup: NPI, Specialty, Connections, Continuous improvement — the EHR field in Connections', () => {
  const { npi, specialty, connections, improvement } = WORDS_V6.setupSections;
  assert.deepEqual(v6.setupSections, [
    { id: 'npi', title: npi },
    { id: 'specialty', title: specialty },
    { id: 'connections', title: connections },
    { id: 'improvement', title: improvement },
  ]);
  assert.deepEqual(
    v5.setupSections.map((s: Json) => s.title),
    ['NPI', 'Specialty', 'Integrations'],
    'v5 keeps its words',
  );
  assert.deepEqual(
    (v6.setup as Json[]).map((field) => [field.key, field.sectionId]),
    [
      ['npi', 'npi'],
      ['specialties', 'specialty'],
      [EHR_FIELD, 'connections'],
      ['learn', 'improvement'],
    ],
  );
  const field = (v6.setup as Json[]).find((each) => each.key === EHR_FIELD)!;
  assert.deepEqual(
    [field.control, field.section, field.required, field.defaultValue, field.providers],
    ['connection', 'connections', false, 'none', [EHR]],
  );
});

test('its two EHR steps: notes read after the visit arrives, the note added after the save', () => {
  const ids = (v6.pipeline as Json[]).map((s) => s.id);
  assert.deepEqual(ids, [
    'receive-visit',
    'read-chart',
    ...(v5.pipeline as Json[]).slice(1).map((s) => s.id),
    'write-chart',
  ]);
  for (const id of ['read-chart', 'write-chart']) {
    const step = (v6.pipeline as Json[]).find((s) => s.id === id)!;
    assert.equal(step.kicker, 'ACTION');
  }
});

test("its output adds the card's codes and the visit's chart note outcome; v5's is unchanged", () => {
  const { diagnosisCodes, chartNote } = v6.outputSchema.properties as Json;
  assert.deepEqual(diagnosisCodes.items.required, ['code', 'system', 'display', 'reason']);
  assert.equal(diagnosisCodes.maxItems, 12);
  assert.deepEqual(chartNote.required, ['outcome']);
  assert.deepEqual(v6.outputSchema.required, v5.outputSchema.required);
});

test('this image serves v6 alone', () => {
  assert.deepEqual(SERVED_VERSIONS, [6]);
  const dockerfile = readFileSync(join(flow, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY --chown=node:node manifests\/icd10-code-check\.v6\.json /mu);
});
