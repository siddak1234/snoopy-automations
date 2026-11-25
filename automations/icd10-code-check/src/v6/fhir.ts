import { isObject, type JsonObject } from '@autom8x/automation-sdk';

import { FHIR_ID } from './paths.js';

/**
 * What v6 reads of an EHR's FHIR R4 answers (http://hl7.org/fhir/R4/bundle.html): a search's
 * Bundle, its entries of one resource type, and whether the server says there is more. An entry
 * whose `search.mode` is `outcome` is the server's note about the search (an OperationOutcome),
 * never a match.
 */

/** A search's Bundle, or undefined for any other answer. */
export function bundleOf(body: unknown): JsonObject | undefined {
  return isObject(body) && body.resourceType === 'Bundle' ? body : undefined;
}

/** The Bundle's matches of `type`, in its order. */
export function resourcesOf(bundle: JsonObject, type: string): JsonObject[] {
  const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
  return entries.flatMap((entry) =>
    isObject(entry) &&
    isObject(entry.resource) &&
    entry.resource.resourceType === type &&
    !(isObject(entry.search) && entry.search.mode === 'outcome')
      ? [entry.resource]
      : [],
  );
}

/** Whether the server has more matches than this page: a `next` link, or a `total` past it. */
export function hasMore(bundle: JsonObject, shown: number): boolean {
  const links = Array.isArray(bundle.link) ? bundle.link : [];
  const next = links.some((link) => isObject(link) && link.relation === 'next');
  return next || (typeof bundle.total === 'number' && bundle.total > shown);
}

/**
 * The one match of `type` a search found, by its id — or undefined when it found none, more
 * than one, more than this page shows, or one whose id is not a FHIR id.
 */
export function onlyMatch(body: unknown, type: string): JsonObject | undefined {
  const bundle = bundleOf(body);
  if (bundle === undefined) return undefined;
  const found = resourcesOf(bundle, type);
  if (found.length !== 1 || hasMore(bundle, found.length)) return undefined;
  const [one] = found;
  return typeof one!.id === 'string' && FHIR_ID.test(one!.id) ? one : undefined;
}
