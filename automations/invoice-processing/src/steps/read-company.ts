import {
  QUICKBOOKS_SENTENCES,
  entityOf,
  readQuickBooks,
  type Clock,
} from '@autom8x/automation-kit/quickbooks';
import { truncateText, type Step } from '@autom8x/automation-sdk';

import { failedWith, quickBooksFailed } from '../outcome.js';
import type { CompanyState } from '../state.js';

/**
 * `read-company` — prove the workspace's QuickBooks connection works and that the
 * company is a US company (v1 serves US companies only: a bill elsewhere needs tax
 * settings this automation does not send), and keep its names for the later checks
 * that compare them. One `companyInfo.get`.
 */

export const READ_COMPANY_SENTENCES = {
  company_not_us:
    'Invoice Processing works only with US QuickBooks companies, and this company is set up for another country.',
  company_country_unknown:
    'QuickBooks did not say which country this company is in, so Invoice Processing cannot use it. Nothing was created.',
} as const;

/** `CompanyInfo.Country` for a US company: Intuit's samples show `USA` and `US`. */
const UNITED_STATES = new Set(['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA']);

const WHAT = 'QuickBooks company not checked';

export function readCompany(clock: Clock): Step {
  return async ({ request, state, platform }) => {
    const read = await readQuickBooks({
      platform,
      deadline: request.deadline,
      clock,
      operation: 'companyInfo.get',
      input: {},
      purpose: 'reading the company',
    });
    if (!read.ok) return quickBooksFailed(WHAT, read);
    const info = entityOf(read.body, 'CompanyInfo');
    const name = info?.CompanyName;
    if (!info || typeof name !== 'string' || name.trim() === '') {
      return failedWith(WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
    }
    const country = String(info.Country ?? '');
    const normalized = country.trim().toUpperCase();
    if (normalized === '') {
      return failedWith(
        WHAT,
        'company_country_unknown',
        READ_COMPANY_SENTENCES.company_country_unknown,
      );
    }
    if (!UNITED_STATES.has(normalized)) {
      return failedWith(WHAT, 'company_not_us', READ_COMPANY_SENTENCES.company_not_us);
    }
    const legalName = info.LegalName;
    const company: CompanyState = {
      name,
      legalName: typeof legalName === 'string' && legalName.trim() !== '' ? legalName : null,
      country,
    };
    return {
      outcome: 'ok',
      summary: `QuickBooks company: ${truncateText(name.trim(), 120)} (US)`,
      state: { ...state, company },
    };
  };
}
