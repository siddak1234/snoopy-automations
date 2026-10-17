import type { RunDocument } from '../src/documents.js';

/** The spec's §1.1 example, field for field, with AM7's number label and references. */
export const EXAMPLE: RunDocument = {
  index: 1,
  status: 'recorded',
  statusText: 'Recorded in QuickBooks: expense',
  type: 'receipt',
  vendor: {
    name: "Lowe's",
    address: '2150 W Shaw Ave',
    city: 'Fresno, CA 93711',
    storeNumber: '1234',
  },
  number: '48291',
  numberLabel: 'Trans #',
  references: [{ label: 'Register', value: '07' }],
  date: '2026-10-14',
  time: '14:32',
  currency: 'USD',
  lineItems: [{ description: '2X4-8 STUD', quantity: '4', unitPrice: '3.98', amount: '15.92' }],
  lineItemsComplete: true,
  subtotal: '15.92',
  tax: '1.27',
  tip: null,
  discount: null,
  total: '17.19',
  payment: { method: 'card', cardLast4: '4417' },
  recordedIn: { providerId: 'quickbooks', recordType: 'expense', recordId: '1452' },
  details: [
    { label: 'Category', value: 'Materials' },
    { label: 'Paid from', value: 'Visa 4417' },
  ],
};
