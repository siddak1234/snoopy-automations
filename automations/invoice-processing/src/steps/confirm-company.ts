import {
  QUICKBOOKS_SENTENCES,
  entityOf,
  readQuickBooks,
  type Clock,
} from '@autom8x/automation-kit/quickbooks';
import { cleanText, fitLine } from '@autom8x/automation-kit/values';
import { isObject, type JsonObject, type Step } from '@autom8x/automation-sdk';

import type { SavedState } from '../decide/saved.js';
import { failedWith, quickBooksFailed } from '../outcome.js';
import { readSaved } from '../writes/saved-state.js';
import { AFTER_APPROVAL_SENTENCES } from '../writes/sentences.js';

/**
 * `confirm-company` (step 19) — after an approval, before anything is written, that QuickBooks is
 * still connected to the company the document was checked against: an approval can come up to 72
 * hours later, a workspace can reconnect QuickBooks to another company meanwhile, and the vendor,
 * account and record Ids decide saved mean nothing there (the plan's §2.0; ip-review
 * design-after-approval-writes-notify-tests.json steps[0]). One `companyInfo.get`.
 *
 * It compares CompanyName, LegalName and Country, cleaned on both sides (absent, null and empty
 * are one) and exactly, case included — any difference fails — and `MetaData.CreateTime`, kept by
 * read-company from the same answer, when both answers carry it: names alone cannot tell a copy
 * or a sandbox company with the same names apart (the design's open question, its recommended
 * answer applied, at no extra call; whether production answers carry it and a rename leaves it
 * unchanged is for the sandbox). A first run — straight through, its lookups moments old — skips.
 */

const WHAT = 'Company not confirmed';

/** Two creation times are one instant, however QuickBooks writes its offset. */
function sameInstant(left: string, right: string): boolean {
  const [a, b] = [Date.parse(left), Date.parse(right)];
  return Number.isNaN(a) || Number.isNaN(b) ? left === right : a === b;
}

/** What differs between the company decide checked and the one QuickBooks answers for now. */
function differences(saved: SavedState['company'], info: JsonObject): string[] {
  const same = (held: string | null, now: unknown) => cleanText(held) === cleanText(now);
  const differ: string[] = [];
  if (!same(saved.name, info.CompanyName)) differ.push('name');
  if (!same(saved.legalName, info.LegalName)) differ.push('legal name');
  if (!same(saved.country, info.Country)) differ.push('country');
  const created = isObject(info.MetaData) ? info.MetaData.CreateTime : undefined;
  if (
    saved.createdAt !== null &&
    typeof created === 'string' &&
    created.trim() !== '' &&
    !sameInstant(saved.createdAt, created.trim())
  ) {
    differ.push('creation time');
  }
  return differ;
}

export function confirmCompany(clock: Clock): Step {
  return async ({ request, state, platform }) => {
    if (!request.continuation) return { outcome: 'skipped' };
    const saved = readSaved(state);
    if (!saved) {
      return failedWith(WHAT, 'state_incomplete', AFTER_APPROVAL_SENTENCES.state_incomplete);
    }
    const read = await readQuickBooks({
      platform,
      deadline: request.deadline,
      clock,
      operation: 'companyInfo.get',
      input: {},
      purpose: 'checking the company again',
    });
    if (!read.ok) return quickBooksFailed(WHAT, read);
    const info = entityOf(read.body, 'CompanyInfo');
    if (!info) {
      return failedWith(WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
    }
    const differ = differences(saved.company, info);
    if (differ.length > 0) {
      return failedWith(
        `${WHAT}: its ${differ.join(', ')} changed`,
        'company_changed',
        AFTER_APPROVAL_SENTENCES.company_changed,
      );
    }
    return {
      outcome: 'ok',
      summary: fitLine([
        'Same QuickBooks company as when this was held: ',
        { name: cleanText(saved.company.name) ?? '' },
      ]),
    };
  };
}
