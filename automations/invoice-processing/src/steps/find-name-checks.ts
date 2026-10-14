import type { Clock } from '@autom8x/automation-kit/quickbooks';
import { sameName, shorten } from '@autom8x/automation-kit/values';
import type { JsonObject, Step, StepContext, StepResult } from '@autom8x/automation-sdk';

import type { NameClash, SimilarVendorsState } from '../decide/contract.js';
import { customerByName, employeeByName, similarVendorsQuery } from '../lookups/queries.js';
import { incomplete, lookupDocumentOf, lookupRows, lookupVendorOf } from '../lookups/read.js';
import { distinctiveWord, similarLine, similarNamesOf } from '../lookups/similar.js';

/**
 * Three checks for a bill whose vendor is new — skipped, with no line, for any other document or a
 * vendor found (the plan's §5; ip-review design-quickbooks-lookups.json steps[2]–[4]), on the
 * QuickBooks path only:
 *
 * - `find-similar-vendors` lists, for the approver, up to three vendors whose name holds the printed
 *   name's distinctive word, inactive ones included (G4-2); it never holds or stops anything — when
 *   QuickBooks cannot answer, the run goes on as a new vendor anyway;
 * - `find-customer-name` and `find-employee-name` check that no customer and no employee, active or
 *   not, already has the name: QuickBooks wants a vendor's display name unique across all three, so
 *   a clash creates the vendor as "Name (vendor)" (decision 7) and holds.
 *
 * Lines (§3.E, §2.6's phrases): `New vendor`, `New vendor, 2 similar names`, or `Name used by a
 * customer or employee`.
 */

const NEW = 'New vendor';
const NAME_IN_USE = 'Name used by a customer or employee';

/** The new vendor's printed name, when this is a bill whose vendor is new; else why not. */
function newVendorName(state: JsonObject): string | 'skipped' | 'incomplete' {
  const document = lookupDocumentOf(state);
  const vendor = lookupVendorOf(state);
  if (!document) return 'incomplete';
  if (document.route !== 'bill') return 'skipped';
  if (!vendor) return 'incomplete';
  return vendor.status === 'new' ? document.seller : 'skipped';
}

export function findSimilarVendors(clock: Clock): Step {
  return async (context) => {
    const printed = newVendorName(context.state);
    if (printed === 'skipped') return { outcome: 'skipped' };
    if (printed === 'incomplete') return incomplete();
    const word = distinctiveWord(printed);
    if (word === null) return { outcome: 'ok', summary: NEW };
    const read = await lookupRows({
      context,
      clock,
      query: similarVendorsQuery(word),
      entity: 'Vendor',
      purpose: 'looking for similar vendor names',
    });
    if (!read.ok) {
      // QuickBooks could not answer: the run holds as a new vendor anyway, so it goes on. A
      // connection that is gone keeps the document out of QuickBooks (decision 6).
      const quickBooksSide = ['qb_busy', 'qb_error', 'qb_forbidden', 'unexpected_answer'];
      return quickBooksSide.includes(read.reason) ? { outcome: 'ok', summary: NEW } : read.result;
    }
    const names = similarNamesOf(read.rows, word, printed);
    const similar: SimilarVendorsState = { names: names.map((each) => shorten(each.name, 100)) };
    return {
      outcome: 'ok',
      summary: similarLine(names.length),
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
  const key = customer ? 'customerNameClash' : 'employeeNameClash';
  const printed = newVendorName(context.state);
  if (printed === 'skipped') return { outcome: 'skipped' };
  if (printed === 'incomplete') return incomplete();
  const read = await lookupRows({
    context,
    clock,
    query: customer ? customerByName(printed) : employeeByName(printed),
    entity,
    purpose: `checking ${customer ? 'customer' : 'employee'} names`,
  });
  if (!read.ok) {
    // Employees this connection cannot read — a 403, or QuickBooks refusing the query — are
    // unreadable, and the run goes on: a real clash then stops create-vendor after approval.
    // Sandbox S7 settles whether the accounting scope can read Employee.
    if (!customer && (read.reason === 'qb_forbidden' || read.reason === 'qb_error')) {
      const clash: NameClash = 'unreadable';
      return { outcome: 'ok', summary: NEW, state: { ...context.state, [key]: clash } };
    }
    return read.result;
  }
  const match = read.rows.some((row) => sameName(row.DisplayName, printed));
  const clash: NameClash = match ? 'match' : 'none';
  return {
    outcome: 'ok',
    summary: match ? NAME_IN_USE : NEW,
    state: { ...context.state, [key]: clash },
  };
}

export const findCustomerName =
  (clock: Clock): Step =>
  (context) =>
    nameClash(context, clock, 'Customer');

export const findEmployeeName =
  (clock: Clock): Step =>
  (context) =>
    nameClash(context, clock, 'Employee');
