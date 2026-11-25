import { isObject, type InvokeRequest, type JsonObject, type Step } from '@autom8x/automation-sdk';

/**
 * v6's two ways to start (README, "v6"; the platform's ADR-0053): a person's upload, as v5, and
 * the EHR's hook when a visit's chart opens. Each step's path is the run's: `byPath` runs one step
 * on an upload's runs and another on a hook's.
 */

/** The EHR provider v6 calls, the menu's `ehr-fhir` ("EHR"), and its setup field's key. */
export const EHR = 'ehr-fhir';
export const EHR_FIELD = 'ehr';

/** A FHIR id, as the platform holds a hook's `patientId` and `encounterId` (ADR-0051 Amendment 2). */
export const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/u;

/**
 * Whether the EHR's hook started this run: the invoke's `startedBy` (ADR-0053 point 5), on a v6
 * run. The SDK's `InvokeRequest` does not type the field yet; its `isInvokeRequest` keeps the body
 * whole, so it is read here, from the one place.
 */
export function isHookRun(request: InvokeRequest): boolean {
  const startedBy = (request as InvokeRequest & { startedBy?: unknown }).startedBy;
  return request.templateVersion >= 6 && startedBy === 'provider-event';
}

/** Whether the flow's setup picked the EHR: its connection field says `ehr-fhir`, else `none`. */
export const ehrChosen = (config: JsonObject): boolean => config[EHR_FIELD] === EHR;

/** The visit a hook run names: its input's `context.patientId` and `context.encounterId`. */
export function hookVisit(
  request: InvokeRequest,
): { patientId: string; encounterId: string } | undefined {
  const context = isObject(request.input.context) ? request.input.context : {};
  const { patientId, encounterId } = context;
  return typeof patientId === 'string' &&
    typeof encounterId === 'string' &&
    FHIR_ID.test(patientId) &&
    FHIR_ID.test(encounterId)
    ? { patientId, encounterId }
    : undefined;
}

/** A step neither path runs here. */
export const SKIPPED: Step = () => Promise.resolve({ outcome: 'skipped' });

/** `upload` on a person's run (a batch's visit runs), `hook` on a run the EHR's hook started. */
export const byPath =
  (upload: Step, hook: Step): Step =>
  (context) =>
    isHookRun(context.request) ? hook(context) : upload(context);

/** The notes' texts a hook run read (`read-chart`), from its state. */
export const notesOf = (state: JsonObject): string[] =>
  Array.isArray(state.notes)
    ? state.notes.filter((one): one is string => typeof one === 'string')
    : [];

/**
 * A step after `read-chart`: `upload` on an upload's run; on a hook's, skipped once no note was
 * read (nothing to code: the run succeeds with no codes), else `hook`.
 */
export const withNotes = (upload: Step, hook: Step = upload): Step =>
  byPath(upload, (context) =>
    notesOf(context.state).length === 0 ? SKIPPED(context) : hook(context),
  );
