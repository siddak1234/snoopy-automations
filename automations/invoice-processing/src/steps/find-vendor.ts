import { QUICKBOOKS_SENTENCES, rowsNaming, type Clock } from '@autom8x/automation-kit/quickbooks';
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
 * One lookup by the exact name — printed and cleaned, or typed in "Who paid" — and by the name
 * QuickBooks gives a vendor it made inactive, "<name> (deleted)" (sandbox G4–5), among vendors
 * active or not (`Active IN (true, false)`, at most two a form), each row re-checked in code: the
 * same name after cleaning, capital letters aside (`sameName`), so a row QuickBooks matched
 * otherwise is a near-miss, ignored. Rows holding the name decide; only when none does, an
 * inactive vendor renamed from it (`rowsNaming`) — so a vendor made with the name an inactive one
 * had is that vendor, and an inactive vendor alone fails "reactivate it" instead of reading as
 * new. One row is the vendor, unless it is inactive, and two fail as two vendors with the name.
 * None: the vendor is new for now, and step 10 looks for a vendor whose company name it is —
 * which QuickBooks leaves as it was on an inactive vendor — by the same rules, skipped past
 * QuickBooks' 100 characters of CompanyName. A seller nobody has is `{ status: 'new' }` — a new
 * vendor for a bill (a hold), no payee for a receipt or a card refund (D20), and for a credit note
 * or a statement decide's F5 or F6. A person nobody has is V1, once both lookups have found nobody.
 *
 * A company receipt's or a card refund's seller is looked up only to link an existing vendor
 * (D20), so an inactive vendor with its name, or two, fail nothing: the seller is `not_linked` —
 * no payee, the seller in the memo and the line text — and the line says why; step 10 then has
 * nothing to look for.
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

type Matched = Extract<VendorState, { status: 'matched' }>;
type NotLinked = Extract<VendorState, { status: 'not_linked' }>;

/** The seller looked up only to link an existing vendor (D20): a company receipt's, a card refund's. */
const linkOnly = (searched: Searched) =>
  searched.document.route === 'company_receipt' || searched.document.route === 'card_refund';

/** The sentence a vendor lookup QuickBooks refuses ends with: a statement is compared, never entered. */
function refusedSentence(searched: Searched, by: 'display name' | 'company name'): LookupSentence {
  if (searched.person) return 'payer_refused';
  if (searched.document.route === 'statement') return 'statement_vendor_refused';
  return by === 'company name' ? 'vendor_company_refused' : 'vendor_refused';
}

/** One vendor row, matched: the vendor, a seller left unlinked, or why it cannot be used. */
function matchedOf(
  kept: readonly JsonObject[],
  searched: Searched,
  by: 'display name' | 'company name',
): Matched | NotLinked | StepResult {
  const company = by === 'company name';
  const [row] = kept as [JsonObject];
  // A missing Active is Intuit's default, true.
  const unusable = kept.length > 1 ? 'ambiguous' : row.Active === false ? 'inactive' : null;
  if (unusable !== null && linkOnly(searched)) {
    return { status: 'not_linked', reason: unusable, matchedBy: by };
  }
  if (unusable === 'ambiguous') {
    const reason: LookupSentence = searched.person
      ? 'payer_ambiguous'
      : company
        ? 'vendor_company_ambiguous'
        : 'vendor_ambiguous';
    return refused(ACCEPT_WHAT, reason);
  }
  if (unusable === 'inactive') {
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

/**
 * Why a seller is not linked, as its line says it: "An inactive vendor has the name 'Tidewell
 * Hardware' in QuickBooks, so it is not linked: no payee".
 */
function notLinkedLine(vendor: NotLinked, name: string, ignored = ''): string {
  const which = vendor.matchedBy === 'company name' ? 'the company name' : 'the name';
  return fitLine([
    vendor.reason === 'inactive'
      ? `An inactive vendor has ${which} '`
      : `Two vendors have ${which} '`,
    { name },
    `' in QuickBooks, so it is not linked: no payee${ignored}`,
  ]);
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
      refused: refusedSentence(searched, 'display name'),
    });
    if (!read.ok) return read.result;
    const named = rowsNaming(read.rows, 'DisplayName', searched.name, sameName);
    const kept = named.rows;
    const ignored = nearMisses(named.others);
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
    if (vendor.status === 'not_linked') {
      return {
        outcome: 'ok',
        summary: notLinkedLine(vendor, searched.name, ignored),
        state: { ...context.state, vendor: vendor as unknown as JsonObject },
      };
    }
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
    // Found by its name, or a seller left unlinked there: nothing more to look for.
    if (vendor.status !== 'new') return { outcome: 'skipped' };
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
      refused: refusedSentence(searched, 'company name'),
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
    if (matched.status === 'not_linked') {
      return {
        outcome: 'ok',
        summary: notLinkedLine(matched, searched.name),
        state: { ...context.state, vendor: matched as unknown as JsonObject },
      };
    }
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
