import {
  QUICKBOOKS_SENTENCES,
  lookupQuery,
  queryRowsOf,
  readQuickBooks,
  type Clock,
} from '@autom8x/automation-kit/quickbooks';
import { MAXIMUM_NAME_LENGTH, cleanText } from '@autom8x/automation-kit/values';
import { isObject, truncateText, type JsonObject, type Step } from '@autom8x/automation-sdk';

import { failedWith, quickBooksFailed } from '../outcome.js';
import type { AccountRef, AccountsState, PayerState } from '../state.js';

/**
 * `find-payer` — who paid, when someone paid with their own money (the owner's D13–D15),
 * before the document is read, so its checks hold whatever the document turns out to be
 * and cost no model call. The run's two inputs: the switch "I paid for this with my own
 * money" (`paidPersonally`) and "Who paid" (`paidBy`); the platform does not say who started
 * a run, and checks each input on its own, so these checks are this step's (P0, P1).
 *
 * A name in "Owners and partners" is an owner, with no QuickBooks call, and wins over an
 * employee of the same name; their own account, or else "Owner's investment account", must
 * be set (P4). Any other name is looked up among employees by display name — one query; an
 * email cannot be searched — and an employee must be active (P2), with "Owed to team
 * members" set (P3). A name that is no employee is passed on: find-vendor looks it up among
 * vendors (V1). Whether the accounting scope can read Employee is sandbox item S7. Skipped
 * when the switch is off and no name is typed.
 */

/** Every sentence ends "Nothing was created.", as the plan's §2.3 words them. */
export const FIND_PAYER_SENTENCES = {
  paid_by_without_switch:
    "You typed a name in 'Who paid' but didn't turn on 'I paid for this with my own money'. Turn it on, or clear the name, then run it again. Nothing was created.",
  paid_by_missing:
    "You turned on 'I paid for this with my own money' but left 'Who paid' empty. Type your name as QuickBooks shows it, then run it again. Nothing was created.",
  paid_by_too_long:
    "The name in 'Who paid' is longer than QuickBooks allows. Type your name as QuickBooks shows it, then run it again. Nothing was created.",
  payer_inactive:
    "The person in 'Who paid' is inactive in QuickBooks. Make them active, then run it again. Nothing was created.",
  team_owed_account_missing:
    "Set 'Owed to team members' in this flow's settings before recording a purchase an employee paid for, then run it again. Nothing was created.",
  owner_account_missing:
    "Set 'Owner's investment account', or give this owner their own account in 'Owners and partners', before recording a purchase an owner paid for, then run it again. Nothing was created.",
  payer_ambiguous:
    "Two QuickBooks employees have the name in 'Who paid'. Rename one in QuickBooks, then run it again. Nothing was created.",
  state_incomplete:
    "'Who paid' could not be checked because of a fault on our side. Nothing was created.",
} as const;

type Reason = keyof typeof FIND_PAYER_SENTENCES;

const WHAT = 'Who paid not accepted';

function refused(reason: Reason) {
  return failedWith(WHAT, reason, FIND_PAYER_SENTENCES[reason]);
}

/** `find-accounts`' state; only the parts this step reads, each checked. */
function accountsOf(state: JsonObject): AccountsState | undefined {
  const accounts = state.accounts;
  return isObject(accounts) && Array.isArray(accounts.owners)
    ? (accounts as unknown as AccountsState)
    : undefined;
}

function done(payer: PayerState, summary: string, state: JsonObject) {
  return {
    outcome: 'ok' as const,
    summary,
    state: { ...state, payer: payer as unknown as JsonObject },
  };
}

export function findPayer(clock: Clock): Step {
  return async ({ request, state, platform }) => {
    const switchedOn = request.input.paidPersonally === true;
    const name = cleanText(request.input.paidBy);
    if (!switchedOn && name === null) return { outcome: 'skipped' };
    if (!switchedOn) return refused('paid_by_without_switch');
    if (name === null) return refused('paid_by_missing');
    if (name.length > MAXIMUM_NAME_LENGTH) return refused('paid_by_too_long');
    const accounts = accountsOf(state);
    if (!accounts) return refused('state_incomplete');

    const owner = accounts.owners.find((each) => each.name.toLowerCase() === name.toLowerCase());
    if (owner) {
      const account: AccountRef | null = owner.account ?? accounts.ownerInvestment;
      if (!account) return refused('owner_account_missing');
      return done(
        { route: 'owner', name: owner.name, employeeId: null, account },
        `Who paid: ${truncateText(owner.name, 60)}, an owner in this flow's settings (account ${truncateText(account.fullyQualifiedName, 60)})`,
        state,
      );
    }

    // Built once: every attempt sends exactly these bytes under the step's one key.
    const read = await readQuickBooks({
      platform,
      deadline: request.deadline,
      clock,
      operation: 'query.run',
      input: { query: lookupQuery('Employee', 'DisplayName', name, 2) },
      purpose: "looking up the name in 'Who paid'",
      advice: 'Remove unusual characters from it, then run it again.',
    });
    if (!read.ok) return quickBooksFailed(WHAT, read);
    const rows = queryRowsOf(read.body, 'Employee');
    if (!rows) return failedWith(WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
    // Intuit compares without case; so does this re-check, after cleaning QuickBooks' name.
    const matches = rows.filter(
      (row) => cleanText(row.DisplayName)?.toLowerCase() === name.toLowerCase(),
    );
    const [employee] = matches;
    if (!employee) {
      return done(
        { route: 'not_employee', name, employeeId: null, account: null },
        `Who paid: ${truncateText(name, 60)}, not an employee in QuickBooks; to be looked for among vendors`,
        state,
      );
    }
    if (matches.length > 1) return refused('payer_ambiguous');
    // A missing Active is Intuit's default, true.
    if (employee.Active === false) return refused('payer_inactive');
    if (!accounts.teamOwed) return refused('team_owed_account_missing');
    if (typeof employee.Id !== 'string' || employee.Id.trim() === '') {
      return failedWith(WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
    }
    const shown = cleanText(employee.DisplayName) ?? name;
    return done(
      { route: 'employee', name: shown, employeeId: employee.Id, account: accounts.teamOwed },
      `Who paid: ${truncateText(shown, 60)}, an employee in QuickBooks (Id ${truncateText(employee.Id, 20)})`,
      state,
    );
  };
}
