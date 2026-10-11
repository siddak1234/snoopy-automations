import type { JsonObject } from '@autom8x/automation-sdk';

/**
 * A made-up QuickBooks company in Intuit's answer shapes (its published samples for
 * CompanyInfo, Preferences, Account and Employee, with every value invented: this
 * repository is public, so nothing here names a real company, address or person). The
 * simulator answers from it; a suite edits a fresh copy per test.
 */

/** Planted in every Fault's `Message` and `Detail`: text that must never reach a summary or a reason. */
export const FAULT_MARKER = 'FAULT-TEXT-0c7e1d';

/** The `time` every simulated answer carries. */
export const TIME = '2026-10-10T09:00:00.000-07:00';

/** The day a record is dated when its request names none: Intuit uses "the current date on the server". */
export const TODAY = '2026-10-10';

export const META = {
  CreateTime: '2024-01-02T09:00:00-08:00',
  LastUpdatedTime: '2024-01-02T09:00:00-08:00',
};

export interface SimulatedCompany {
  /** Answered by `companyInfo.get` as `{ CompanyInfo, time }`. */
  companyInfo: JsonObject;
  /** Answered by `preferences.get` as `{ Preferences, time }`. */
  preferences: JsonObject;
  /** Searched by `query.run` on `Account`. */
  accounts: JsonObject[];
  /** Searched by `query.run` on `Employee`. */
  employees: JsonObject[];
  /** Expenses: searched on `Purchase`, added by `purchase.create`. */
  purchases: JsonObject[];
  /** Searched on `VendorCredit`, added by `vendorCredit.create`. */
  vendorCredits: JsonObject[];
  /** Searched on `JournalEntry`, added by `journalEntry.create`. */
  journalEntries: JsonObject[];
}

/** An Account entity: a sub-account names its parent by `ParentRef` and `Parent:Child`. */
export function sampleAccount(
  id: string,
  fullyQualifiedName: string,
  accountType: string,
  overrides: JsonObject = {},
): JsonObject {
  const parts = fullyQualifiedName.split(':');
  return {
    Id: id,
    Name: parts.at(-1) ?? fullyQualifiedName,
    FullyQualifiedName: fullyQualifiedName,
    SubAccount: parts.length > 1,
    AccountType: accountType,
    Classification: 'Expense',
    Active: true,
    CurrentBalance: 0,
    CurrencyRef: { value: 'USD', name: 'United States Dollar' },
    SyncToken: '0',
    domain: 'QBO',
    sparse: false,
    MetaData: META,
    ...overrides,
  };
}

/**
 * An Employee entity: `DisplayName` is the name QuickBooks shows, and the one a lookup
 * searches; an inactive one is `Active: false`.
 */
export function sampleEmployee(
  id: string,
  displayName: string,
  overrides: JsonObject = {},
): JsonObject {
  const [given = displayName, ...rest] = displayName.split(' ');
  return {
    Id: id,
    DisplayName: displayName,
    GivenName: given,
    FamilyName: rest.join(' '),
    PrintOnCheckName: displayName,
    Active: true,
    BillableTime: false,
    SyncToken: '0',
    domain: 'QBO',
    sparse: false,
    MetaData: META,
    ...overrides,
  };
}

/**
 * A fresh company: US, home currency USD, books closed through 2025-12-31, no payroll; an
 * account for every role a flow's settings may name, one employee, and no transactions.
 */
export function sampleCompany(): SimulatedCompany {
  return {
    companyInfo: {
      CompanyName: 'Sample Bakery',
      LegalName: 'Sample Bakery LLC',
      Country: 'USA',
      CompanyAddr: {
        Id: '1',
        Line1: '100 Example Street',
        City: 'Anytown',
        CountrySubDivisionCode: 'CA',
        PostalCode: '90000',
        Country: 'USA',
      },
      NameValue: [
        { Name: 'OfferingSku', Value: 'QuickBooks Online Plus' },
        { Name: 'PayrollFeature', Value: 'false' },
      ],
      FiscalYearStartMonth: 'January',
      SupportedLanguages: 'en',
      Id: '1',
      SyncToken: '1',
      domain: 'QBO',
      sparse: false,
      MetaData: META,
    },
    preferences: {
      CurrencyPrefs: { HomeCurrency: { value: 'USD' }, MultiCurrencyEnabled: false },
      AccountingInfoPrefs: {
        BookCloseDate: '2025-12-31',
        UseAccountNumbers: false,
        FirstMonthOfFiscalYear: 'January',
      },
      SalesFormsPrefs: { CustomTxnNumbers: false },
      OtherPrefs: {
        NameValue: [
          { Name: 'WarnDuplicateCheckNumber', Value: 'true' },
          { Name: 'WarnDuplicateBillNumber', Value: 'false' },
        ],
      },
      Id: '1',
      SyncToken: '1',
      domain: 'QBO',
      sparse: false,
      MetaData: META,
    },
    accounts: [
      sampleAccount('56', 'Utilities', 'Expense'),
      sampleAccount('57', 'Utilities:Electric', 'Expense', { ParentRef: { value: '56' } }),
      sampleAccount('64', 'Office Supplies', 'Expense'),
      sampleAccount('80', 'Cost of Goods Sold', 'Cost of Goods Sold'),
      sampleAccount('35', 'Checking', 'Bank', { Classification: 'Asset' }),
      sampleAccount('41', 'Company Visa', 'Credit Card', { Classification: 'Liability' }),
      sampleAccount('33', 'Accounts Payable (A/P)', 'Accounts Payable', {
        Classification: 'Liability',
      }),
      sampleAccount('120', 'Owed to Team Members', 'Other Current Liability', {
        Classification: 'Liability',
      }),
      sampleAccount('125', 'Owner investments', 'Equity', { Classification: 'Equity' }),
      sampleAccount('66', 'Meals', 'Expense'),
    ],
    employees: [sampleEmployee('55', 'Robin Example')],
    purchases: [],
    vendorCredits: [],
    journalEntries: [],
  };
}

/** A read answer: `{ <entity>: value, time }`. */
export function readAnswer(entity: string, value: JsonObject): JsonObject {
  return { [entity]: structuredClone(value), time: TIME };
}

/** A query answer: the rows under `QueryResponse.<entity>`, or none at all when nothing matched. */
export function queryAnswer(entity: string, rows: readonly JsonObject[]): JsonObject {
  return {
    QueryResponse:
      rows.length === 0
        ? {}
        : { startPosition: 1, [entity]: structuredClone(rows), maxResults: rows.length },
    time: TIME,
  };
}

/** A Fault in Intuit's shape, with `FAULT_MARKER` in the text a reader must never repeat. */
export function faultAnswer(code: string, type = 'ValidationFault'): JsonObject {
  return {
    Fault: {
      Error: [
        {
          Message: `${FAULT_MARKER} message`,
          Detail: `${FAULT_MARKER} detail`,
          code,
          element: '',
        },
      ],
      type,
    },
    time: TIME,
  };
}
