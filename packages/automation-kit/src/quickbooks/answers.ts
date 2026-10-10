import type { JsonObject } from '@autom8x/automation-sdk';

/**
 * Readers for QuickBooks' answers, in Intuit's read shapes: `{ CompanyInfo: {…}, time }`,
 * `{ Preferences: {…}, time }`, `{ QueryResponse: { startPosition, <Entity>: […],
 * maxResults }, time }` (the entity array absent when nothing matched), and a Fault as
 * `{ Fault: { Error: [{ Message, Detail, code }], type }, time }` — at the top, or inside
 * `QueryResponse` for a query. Each reader returns `undefined` for a shape it cannot
 * read and never throws, so a step answers a malformed body with its own fixed sentence.
 * None returns Intuit's `Message` or `Detail`: a Fault is known by its numeric code alone.
 */

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A Fault's code as digits — the only part of a Fault that is ever shown. */
const FAULT_CODE = /^\d{1,9}$/u;

/**
 * The Fault an answer carries, at the top or inside `QueryResponse` (Intuit: a 200 may
 * carry one, and a query's errors sit in its `QueryResponse`), with its first error's
 * code when that is a number; `undefined` when the answer carries no Fault.
 */
export function faultOf(body: unknown): { readonly code: string | undefined } | undefined {
  if (!isObject(body)) return undefined;
  const fault = isObject(body.Fault)
    ? body.Fault
    : isObject(body.QueryResponse) && isObject(body.QueryResponse.Fault)
      ? body.QueryResponse.Fault
      : undefined;
  if (!fault) return undefined;
  const first: unknown = Array.isArray(fault.Error) ? fault.Error[0] : undefined;
  const code: unknown = isObject(first) ? first.code : undefined;
  const text = typeof code === 'number' && Number.isInteger(code) ? String(code) : code;
  return { code: typeof text === 'string' && FAULT_CODE.test(text) ? text : undefined };
}

/** The one entity a read answers — `CompanyInfo`, `Preferences` — when it is an object. */
export function entityOf(body: unknown, entity: string): JsonObject | undefined {
  if (!isObject(body)) return undefined;
  const value = body[entity];
  return isObject(value) ? value : undefined;
}

/**
 * The rows a query answered for `entity`: `[]` when nothing matched (Intuit leaves the
 * array out), and `undefined` when the answer is not a `QueryResponse` at all. Rows that
 * are not objects are dropped.
 */
export function queryRowsOf(body: unknown, entity: string): JsonObject[] | undefined {
  if (!isObject(body) || !isObject(body.QueryResponse)) return undefined;
  const rows = body.QueryResponse[entity];
  return Array.isArray(rows) ? rows.filter(isObject) : [];
}

/**
 * The value of a `NameValue` entry, Intuit's list of `{ Name, Value }` pairs
 * (`CompanyInfo.NameValue`, `Preferences.OtherPrefs.NameValue`), when it is a string.
 */
export function nameValueOf(list: unknown, name: string): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    if (isObject(entry) && entry.Name === name) {
      return typeof entry.Value === 'string' ? entry.Value : undefined;
    }
  }
  return undefined;
}
