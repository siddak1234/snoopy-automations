import type { Clock } from '@autom8x/automation-kit/quickbooks';
import { cleanText, fitLine, sameName, shorten } from '@autom8x/automation-kit/values';
import type { JsonObject, Step, StepContext, StepResult } from '@autom8x/automation-sdk';

import type { NameClash, SimilarVendorsState } from '../decide/contract.js';
import {
  MAX_RESULTS,
  customerByName,
  employeeByName,
  similarVendorsQuery,
} from '../lookups/queries.js';
import { lookupDocumentOf, lookupRows, lookupVendorOf, refused } from '../lookups/read.js';
import { distinctiveWord, similarLine, similarNamesOf } from '../lookups/similar.js';

/**
 * Steps 11–13, for a bill whose vendor is new — skipped, with no line, for any other document or a
 * vendor found (the plan's §5; ip-review design-quickbooks-lookups.json steps[2]–[4]):
 *
 * - `find-similar-vendors` lists, for the approver, up to three vendors whose name holds the printed
 *   name's distinctive word, inactive ones included and marked (G4-2); it never holds or fails —
 *   when QuickBooks cannot answer, its line says so and the run goes on;
 * - `find-customer-name` and `find-employee-name` check that no customer and no employee, active or
 *   not, already has the name: QuickBooks wants a vendor's display name unique across all three, so
 *   a clash creates the vendor as "Name (vendor)" (decision 7) and holds.
 */

const SIMILAR_WHAT = 'Similar vendor names not looked up';
const CUSTOMER_WHAT = 'Customer names not checked';
const EMPLOYEE_WHAT = 'Employee names not checked';

/** The new vendor's printed name, when this is a bill whose vendor is new; else why not. */
function newVendorName(state: JsonObject): string | 'skipped' | 'incomplete' {
  const document = lookupDocumentOf(state);
  const vendor = lookupVendorOf(state);
  if (!document) return 'incomplete';
  if (document.route !== 'bill') return 'skipped';
  if (!vendor) return 'incomplete';
  return vendor.status === 'new' ? document.seller : 'skipped';
}

/** A failed step the run goes on past: visible, with no reason, carrying `state` when it has one. */
const goOn = (summary: string, state?: JsonObject): StepResult => ({
  outcome: 'failed',
  summary,
  ...(state === undefined ? {} : { state }),
});

export function findSimilarVendors(clock: Clock): Step {
  return async (context) => {
    const printed = newVendorName(context.state);
    if (printed === 'skipped') return { outcome: 'skipped' };
    if (printed === 'incomplete') return refused(SIMILAR_WHAT, 'state_incomplete');
    const word = distinctiveWord(printed);
    if (word === null) {
      return {
        outcome: 'ok',
        summary: 'No distinctive word in the vendor name to look for similar vendors',
      };
    }
    const read = await lookupRows({
      context,
      clock,
      query: similarVendorsQuery(word),
      entity: 'Vendor',
      what: SIMILAR_WHAT,
      purpose: 'looking for similar vendor names',
      refused: 'vendor_refused',
    });
    if (!read.ok) {
      // QuickBooks could not answer: the run holds as a new vendor anyway, so it goes on, saying so.
      const quickBooksSide = ['qb_busy', 'qb_error', 'qb_forbidden', 'unexpected_answer'];
      return quickBooksSide.includes(read.reason)
        ? goOn(
            'Similar vendor names could not be looked up; check QuickBooks for this vendor before approving',
          )
        : read.result;
    }
    const names = similarNamesOf(read.rows, word, printed);
    const similar: SimilarVendorsState = { names: names.map((each) => shorten(each.name, 100)) };
    return {
      outcome: 'ok',
      summary: similarLine(word, names, read.rows.length >= MAX_RESULTS.similar),
      state: { ...context.state, similarVendors: similar as unknown as JsonObject },
    };
  };
}

/** One name check: a customer or an employee with the new vendor's name. */
async function nameClash(
  context: StepContext,
  clock: Clock,
  entity: 'Customer' | 'Employee',
): Promise<StepResult> {
  const customer = entity === 'Customer';
  const what = customer ? CUSTOMER_WHAT : EMPLOYEE_WHAT;
  const key = customer ? 'customerNameClash' : 'employeeNameClash';
  const printed = newVendorName(context.state);
  if (printed === 'skipped') return { outcome: 'skipped' };
  if (printed === 'incomplete') return refused(what, 'state_incomplete');
  const read = await lookupRows({
    context,
    clock,
    query: customer ? customerByName(printed) : employeeByName(printed),
    entity,
    what,
    purpose: `checking ${customer ? 'customer' : 'employee'} names`,
    // An employee lookup QuickBooks refuses is unreadable instead, below.
    refused: 'customer_refused',
  });
  if (!read.ok) {
    // Employees this connection cannot read — a 403, or QuickBooks refusing the query (an
    // AuthorizationFault, or any other 4xx it records) — are unreadable, and the run goes on: a real
    // clash then stops create-vendor after approval, with its own sentence. A 401 still fails,
    // since Connections has already marked the connection for reconnection. Sandbox S7 settles,
    // before v1 registers, whether the accounting scope can read Employee — and if Intuit answers
    // 401 there, every new vendor would knock the owner's connection out, so this step goes.
    if (!customer && (read.reason === 'qb_forbidden' || read.reason === 'qb_error')) {
      const clash: NameClash = 'unreadable';
      return goOn(
        'Employee names could not be read with this connection; a clash would stop the vendor being created',
        { ...context.state, [key]: clash },
      );
    }
    return read.result;
  }
  const [match] = read.rows.filter((row) => sameName(row.DisplayName, printed));
  const clash: NameClash = match ? 'match' : 'none';
  const kind = customer ? 'customer' : 'employee';
  const summary = match
    ? fitLine([
        `A${customer ? '' : 'n'} ${kind} in QuickBooks is named '`,
        { name: cleanText(match.DisplayName) ?? printed },
        "'; the new vendor would be created as '",
        { name: printed },
        " (vendor)'",
      ])
    : fitLine([`No ${kind} in QuickBooks is named '`, { name: printed }, "'"]);
  return { outcome: 'ok', summary, state: { ...context.state, [key]: clash } };
}

export const findCustomerName =
  (clock: Clock): Step =>
  (context) =>
    nameClash(context, clock, 'Customer');

export const findEmployeeName =
  (clock: Clock): Step =>
  (context) =>
    nameClash(context, clock, 'Employee');
