import { QUICKBOOKS_SENTENCES, type Clock } from '@autom8x/automation-kit/quickbooks';
import { fitLine, sameName, shorten } from '@autom8x/automation-kit/values';
import type { JsonObject, Step, StepResult } from '@autom8x/automation-sdk';

import type { VendorState } from '../decide/contract.js';
import { vendorByCompanyName, vendorByName } from '../lookups/queries.js';
import {
  lookupDocumentOf,
  lookupRows,
  lookupVendorOf,
  payerNameOf,
  refused,
  type LookupSentence,
} from '../lookups/read.js';
import { matchedVendorOf } from '../lookups/records.js';
import { failedWith } from '../outcome.js';
import type { DocumentState } from '../state.js';

/**
 * `find-vendor` (step 9) and `find-vendor-company` (step 10) — the supplier or seller in QuickBooks,
 * or, for a contractor, the person who paid (the plan's §5; ip-review
 * design-quickbooks-lookups.json steps[0]–[1]). Skipped on the employee and owner routes, which
 * have no vendor.
 *
 * One lookup by the exact name — printed and cleaned, or typed in "Who paid" — among vendors active
 * or not (`Active IN (true, false)`, at most 2), each row re-checked in code: the same name after
 * cleaning, capital letters aside (`sameName`), so a row QuickBooks matched otherwise is a
 * near-miss, ignored. One row is the vendor, unless it is inactive — "reactivate it" — and two fail
 * as two vendors with the name. None: the vendor is new for now, and step 10 looks for a vendor
 * whose company name it is, by the same rules, skipped past QuickBooks' 100 characters of
 * CompanyName. A seller nobody has is `{ status: 'new' }` — a new vendor for a bill (a hold), no
 * payee for a receipt or a card refund (D20), and for a credit note or a statement decide's F5 or
 * F6. A person nobody has is V1, once both lookups have found nobody.
 */

const VENDOR_WHAT = 'Vendor not looked up';
const COMPANY_WHAT = 'Vendor not looked up by company name';
const ACCEPT_WHAT = 'Vendor not accepted';
/** QuickBooks' bound on a vendor's CompanyName ("Maximum of 100 chars"). */
const COMPANY_NAME_LENGTH = 100;

interface Searched {
  readonly document: DocumentState;
  /** The name looked up: the seller, or the person who paid. */
  readonly name: string;
  /** The person who paid: a contractor, found among vendors. */
  readonly person: boolean;
}

/** What a vendor lookup searches for, or why it does not: skipped, or a state no step left so. */
function searchedOf(state: JsonObject): Searched | 'skipped' | 'incomplete' {
  const document = lookupDocumentOf(state);
  if (!document) return 'incomplete';
  if (document.route === 'employee' || document.route === 'owner') return 'skipped';
  const person = document.route === 'contractor';
  const name = person ? payerNameOf(state) : document.seller;
  return name === undefined ? 'incomplete' : { document, name, person };
}

const incomplete = (what: string) => refused(what, 'state_incomplete');

/** One vendor row, matched: the vendor, or why it cannot be used. */
function matchedOf(
  kept: readonly JsonObject[],
  searched: Searched,
  by: 'display name' | 'company name',
): Extract<VendorState, { status: 'matched' }> | StepResult {
  const company = by === 'company name';
  if (kept.length > 1) {
    const reason: LookupSentence = searched.person
      ? 'payer_ambiguous'
      : company
        ? 'vendor_company_ambiguous'
        : 'vendor_ambiguous';
    return refused(ACCEPT_WHAT, reason);
  }
  const [row] = kept as [JsonObject];
  // A missing Active is Intuit's default, true.
  if (row.Active === false) {
    const reason: LookupSentence = searched.person
      ? 'payer_inactive'
      : company
        ? 'vendor_company_inactive'
        : 'vendor_inactive';
    return refused(ACCEPT_WHAT, reason);
  }
  const vendor = matchedVendorOf(row, by, searched.name);
  return (
    vendor ??
    failedWith(
      company ? COMPANY_WHAT : VENDOR_WHAT,
      'unexpected_answer',
      QUICKBOOKS_SENTENCES.unexpected_answer,
    )
  );
}

/** What a seller nobody has means, per route: a hold, no payee, or decide's F5 or F6. */
const NEW_VENDOR_WORDS: Readonly<Partial<Record<DocumentState['route'], string>>> = {
  bill: 'new vendor',
  company_receipt: 'no vendor to link',
  card_refund: 'no vendor to link',
  vendor_credit: 'not in QuickBooks',
  statement: 'not in QuickBooks',
};

const nearMisses = (ignored: number) =>
  ignored === 0 ? '' : `; ${ignored} near-miss${ignored === 1 ? '' : 'es'} ignored`;

export function findVendor(clock: Clock): Step {
  return async (context) => {
    const searched = searchedOf(context.state);
    if (searched === 'skipped') return { outcome: 'skipped' };
    if (searched === 'incomplete') return incomplete(VENDOR_WHAT);
    const read = await lookupRows({
      context,
      clock,
      query: vendorByName(searched.name),
      entity: 'Vendor',
      what: VENDOR_WHAT,
      purpose: 'looking up the vendor',
      refused: searched.person ? 'payer_refused' : 'vendor_refused',
    });
    if (!read.ok) return read.result;
    const kept = read.rows.filter((row) => sameName(row.DisplayName, searched.name));
    const ignored = nearMisses(read.rows.length - kept.length);
    if (kept.length === 0) {
      const vendor: VendorState = { status: 'new' };
      return {
        outcome: 'ok',
        summary: fitLine([
          "No vendor named '",
          { name: searched.name },
          `' in QuickBooks${ignored}`,
        ]),
        state: { ...context.state, vendor: vendor as unknown as JsonObject },
      };
    }
    const vendor = matchedOf(kept, searched, 'display name');
    if ('outcome' in vendor) return vendor;
    const id = shorten(vendor.id, 20);
    return {
      outcome: 'ok',
      summary: searched.person
        ? fitLine([
            "Found the person who paid, '",
            { name: vendor.displayName },
            `', among QuickBooks vendors (Id ${id})${ignored}`,
          ])
        : fitLine([
            "Found vendor '",
            { name: vendor.displayName },
            `' in QuickBooks by its name (Id ${id})${ignored}`,
          ]),
      state: { ...context.state, vendor: vendor as unknown as JsonObject },
    };
  };
}

export function findVendorCompany(clock: Clock): Step {
  return async (context) => {
    const searched = searchedOf(context.state);
    if (searched === 'skipped') return { outcome: 'skipped' };
    const vendor = lookupVendorOf(context.state);
    if (searched === 'incomplete' || !vendor) return incomplete(COMPANY_WHAT);
    if (vendor.status === 'matched') return { outcome: 'skipped' };
    // No vendor can have a company name longer than QuickBooks allows: nothing to search.
    if (searched.name.length > COMPANY_NAME_LENGTH) {
      return searched.person ? refused(ACCEPT_WHAT, 'payer_not_found') : { outcome: 'skipped' };
    }
    const read = await lookupRows({
      context,
      clock,
      query: vendorByCompanyName(searched.name),
      entity: 'Vendor',
      what: COMPANY_WHAT,
      purpose: "looking up the vendor's company name",
      refused: searched.person ? 'payer_refused' : 'vendor_company_refused',
    });
    if (!read.ok) return read.result;
    const kept = read.rows.filter((row) => sameName(row.CompanyName, searched.name));
    if (kept.length === 0) {
      // V1: a person who paid is an owner, an employee or a vendor, and they are none.
      if (searched.person) return refused(ACCEPT_WHAT, 'payer_not_found');
      return {
        outcome: 'ok',
        summary: fitLine([
          "No vendor has the company name '",
          { name: searched.name },
          `' either: ${NEW_VENDOR_WORDS[searched.document.route] ?? 'new vendor'}`,
        ]),
      };
    }
    const matched = matchedOf(kept, searched, 'company name');
    if ('outcome' in matched) return matched;
    return {
      outcome: 'ok',
      summary: fitLine([
        "Found vendor '",
        { name: matched.displayName },
        `' (Id ${shorten(matched.id, 20)}) by its company name '`,
        { name: searched.name },
        "'",
      ]),
      state: { ...context.state, vendor: matched as unknown as JsonObject },
    };
  };
}
