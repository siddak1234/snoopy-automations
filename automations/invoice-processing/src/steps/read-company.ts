import { entityOf, readQuickBooks, type Clock } from '@autom8x/automation-kit/quickbooks';
import { isObject, type Step } from '@autom8x/automation-sdk';

import { notRecorded, readFailed } from '../quickbooks-path.js';
import type { CompanyState } from '../state.js';
import { lineWith } from '../words.js';

/**
 * `read-company` — the first QuickBooks step, on the QuickBooks path only: prove the workspace's
 * QuickBooks connection works and that the company is a US company (this automation serves US
 * companies only: a record elsewhere needs tax settings it does not send), and keep its names for
 * the later checks that compare them, and — from the same answer — when the company file was
 * created (`MetaData.CreateTime`), which confirm-company compares after an approval. One
 * `companyInfo.get`. Anything that keeps QuickBooks from recording the document — not connected,
 * no usable answer, another country — is "not recorded in QuickBooks", and the run goes on to
 * save the details (decision 6).
 */

/** `CompanyInfo.Country` for a US company: Intuit's samples show `USA` and `US`. */
const UNITED_STATES = new Set(['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA']);

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
    if (!read.ok) return readFailed(state, read);
    const info = entityOf(read.body, 'CompanyInfo');
    const name = info?.CompanyName;
    if (!info || typeof name !== 'string' || name.trim() === '') {
      return notRecorded(state, 'no_answer');
    }
    const country = String(info.Country ?? '');
    const normalized = country.trim().toUpperCase();
    // A company that does not say where it is answered unusably; one elsewhere cannot be used.
    if (normalized === '') return notRecorded(state, 'no_answer');
    if (!UNITED_STATES.has(normalized)) return notRecorded(state, 'not_us');
    const legalName = info.LegalName;
    const created = isObject(info.MetaData) ? info.MetaData.CreateTime : undefined;
    const company: CompanyState = {
      name,
      legalName: typeof legalName === 'string' && legalName.trim() !== '' ? legalName : null,
      country,
      createdAt: typeof created === 'string' && created.trim() !== '' ? created.trim() : null,
    };
    return {
      outcome: 'ok',
      summary: lineWith('QuickBooks: ', name.trim()),
      state: { ...state, company },
    };
  };
}
