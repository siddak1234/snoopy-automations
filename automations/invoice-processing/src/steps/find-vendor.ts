import { rowsNaming, type Clock } from '@autom8x/automation-kit/quickbooks';
import { sameName } from '@autom8x/automation-kit/values';
import type { JsonObject, Step, StepResult } from '@autom8x/automation-sdk';

import type { VendorState } from '../decide/contract.js';
import { vendorByCompanyName, vendorByName } from '../lookups/queries.js';
import { incomplete, lookupDocumentOf, lookupRows, lookupVendorOf } from '../lookups/read.js';
import { matchedVendorOf } from '../lookups/records.js';
import { notRecorded } from '../quickbooks-path.js';
import type { DocumentState } from '../state.js';

/**
 * `find-vendor` and `find-vendor-company` — the supplier or seller in QuickBooks (the plan's §5;
 * ip-review design-quickbooks-lookups.json steps[0]–[1]), on the QuickBooks path only.
 *
 * One lookup by the exact name printed and cleaned, and by the name QuickBooks gives a vendor it
 * made inactive, "<name> (deleted)" (sandbox G4–5), among vendors active or not
 * (`Active IN (true, false)`, at most two a form), each row re-checked in code: the same name after
 * cleaning, capital letters aside (`sameName`), so a row QuickBooks matched otherwise is a
 * near-miss, ignored. Rows holding the name decide; only when none does, an inactive vendor renamed
 * from it (`rowsNaming`). One row is the vendor, unless it is inactive; two are two vendors with the
 * name. None: the vendor is new for now, and `find-vendor-company` looks for a vendor whose company
 * name it is — which QuickBooks leaves as it was on an inactive vendor — by the same rules, skipped
 * past QuickBooks' 100 characters of CompanyName. A seller nobody has is `{ status: 'new' }` — a new
 * vendor for a bill (a hold), no payee for a receipt or a card refund (D20), and for a credit note
 * or a statement "not recorded" at decide (F5, F6).
 *
 * A company receipt's or a card refund's seller is looked up only to link an existing vendor (D20),
 * so an inactive vendor with its name, or two, keep nothing from being recorded: the seller is
 * `not_linked` — no payee, the seller in the memo and the line text. For a bill, a credit note or a
 * statement they do: "not recorded in QuickBooks: the vendor isn't in QuickBooks" — no active
 * vendor is that one — and the details are saved.
 *
 * Lines (§3.E): `Vendor found` or `New vendor`.
 */

/** QuickBooks' bound on a vendor's CompanyName ("Maximum of 100 chars"). */
const COMPANY_NAME_LENGTH = 100;

const FOUND = 'Vendor found';
const NEW = 'New vendor';

type Matched = Extract<VendorState, { status: 'matched' }>;
type NotLinked = Extract<VendorState, { status: 'not_linked' }>;

/** The seller looked up only to link an existing vendor (D20): a company receipt's, a card refund's. */
const linkOnly = (document: DocumentState) =>
  document.route === 'company_receipt' || document.route === 'card_refund';

/** One vendor row, matched: the vendor, a seller left unlinked, or why the record cannot be made. */
function matchedOf(
  kept: readonly JsonObject[],
  document: DocumentState,
  by: 'display name' | 'company name',
  state: JsonObject,
): Matched | NotLinked | StepResult {
  const [row] = kept as [JsonObject];
  // A missing Active is Intuit's default, true.
  const unusable = kept.length > 1 ? 'ambiguous' : row.Active === false ? 'inactive' : null;
  if (unusable !== null) {
    return linkOnly(document)
      ? { status: 'not_linked', reason: unusable, matchedBy: by }
      : notRecorded(state, 'vendor_not_in_quickbooks');
  }
  return matchedVendorOf(row, by, document.seller) ?? notRecorded(state, 'no_answer');
}

const withVendor = (state: JsonObject, vendor: VendorState, summary: string): StepResult => ({
  outcome: 'ok',
  summary,
  state: { ...state, vendor: vendor as unknown as JsonObject },
});

export function findVendor(clock: Clock): Step {
  return async (context) => {
    const { state } = context;
    const document = lookupDocumentOf(state);
    if (!document) return incomplete();
    const read = await lookupRows({
      context,
      clock,
      query: vendorByName(document.seller),
      entity: 'Vendor',
      purpose: 'looking up the vendor',
    });
    if (!read.ok) return read.result;
    const kept = rowsNaming(read.rows, 'DisplayName', document.seller, sameName).rows;
    if (kept.length === 0) return withVendor(state, { status: 'new' }, NEW);
    const vendor = matchedOf(kept, document, 'display name', state);
    if ('outcome' in vendor) return vendor;
    return withVendor(state, vendor, FOUND);
  };
}

export function findVendorCompany(clock: Clock): Step {
  return async (context) => {
    const { state } = context;
    const document = lookupDocumentOf(state);
    const vendor = lookupVendorOf(state);
    if (!document || !vendor) return incomplete();
    // Found by its name, or a seller left unlinked there: nothing more to look for.
    if (vendor.status !== 'new') return { outcome: 'skipped' };
    // No vendor can have a company name longer than QuickBooks allows: nothing to search.
    if (document.seller.length > COMPANY_NAME_LENGTH) return { outcome: 'skipped' };
    const read = await lookupRows({
      context,
      clock,
      query: vendorByCompanyName(document.seller),
      entity: 'Vendor',
      purpose: "looking up the vendor's company name",
    });
    if (!read.ok) return read.result;
    const kept = read.rows.filter((row) => sameName(row.CompanyName, document.seller));
    if (kept.length === 0) return { outcome: 'ok', summary: NEW };
    const matched = matchedOf(kept, document, 'company name', state);
    if ('outcome' in matched) return matched;
    return withVendor(state, matched, FOUND);
  };
}
