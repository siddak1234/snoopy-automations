import { BILL_TO, amount, answer, money, percentOf, sum, type Sample } from './catalog.js';
import { layout, spread } from './layout.js';
import { textPdf } from './render.js';

/**
 * Receipts and credits a PDF prints as text (the owner's plan of 2026-10-11, §4's new
 * samples): a receipt with cash back, an invoice stamped PAID, a refund to a card, and a
 * credit memo with minus signs and an allowance. Every value is printed once from the same
 * data the expected answer is built from.
 */

/** A till roll: 80 mm wide, 40 columns of 8-point Courier. */
const ROLL = { width: 226, height: 360, size: 8, leading: 11, top: 30, left: 17 };

const groceries: [string, number][] = [
  ['Flour, all-purpose, 25 lb', 1_899],
  ['Sugar, granulated, 10 lb', 1_149],
  ['Butter, unsalted, 4 lb', 1_796],
  ['Eggs, large, 5 dozen', 1_545],
  ['Vanilla extract, 16 oz', 1_298],
];
const groceriesTotal = sum(groceries.map(([, cents]) => cents));
const CASH_BACK = 4_000;

export const cashBackReceipt: Sample = {
  name: 'cash-back-receipt',
  file: 'receipt.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7CBK',
  markerIn: 'notes',
  made: 'A grocery till receipt as a narrow text PDF, paid by debit card ending 7731 with 40.00 cash back, the card charged the total and the cash back together.',
  decisive: ['documentType', 'cashBackPrinted', 'total'],
  next: 'A receipt with cash back: check-document fails it (C16), since cash back is not an expense; it is entered by hand.',
  answer: answer({
    documentType: 'receipt',
    vendorName: 'Bramblewick Market',
    documentNumber: '20714',
    documentDate: '2026-09-26',
    subtotal: amount(groceriesTotal),
    tax: 0,
    total: amount(groceriesTotal),
    cashBackPrinted: true,
    paymentMethod: 'card',
    cardLast4: '7731',
    spendType: 'materials',
    lineItems: groceries,
  }),
  make: () =>
    textPdf(
      [
        layout(
          {
            title: 'RECEIPT',
            vendor: [
              'Bramblewick Market',
              '18 Bramble Street',
              'Anytown, PA 19000',
              'Tel (555) 010-4482',
            ],
            details: [
              ['Receipt #', '20714'],
              ['Date', '09/26/2026 08:12'],
              ['Lane', '4, cashier 11'],
            ],
            items: groceries.map(([description, cents]) => ({ description, amount: money(cents) })),
            totals: [
              ['Subtotal', money(groceriesTotal)],
              ['Tax', money(0)],
              ['TOTAL', money(groceriesTotal)],
            ],
            notes: [
              spread('CASH BACK', money(CASH_BACK), 40),
              spread('DEBIT ****7731 CHARGED', money(groceriesTotal + CASH_BACK), 40),
              '',
              '  Rewards card QZ7CBK - thank you!',
            ],
          },
          40,
          true,
        ),
      ],
      ROLL,
    ),
};

const bookkeeping: [string, number][] = [
  ['Monthly bookkeeping, September 2026', 35_000],
  ['Quarterly payroll filing, Q3 2026', 13_000],
];
const bookkeepingTotal = sum(bookkeeping.map(([, cents]) => cents));

export const paidInvoicePdf: Sample = {
  name: 'paid-invoice',
  file: 'invoice.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7PAI',
  markerIn: 'notes',
  made: 'An invoice typed into a PDF, its payment by check printed below the total, a balance due of 0.00 and PAID IN FULL across its notes; terms and a due date still printed.',
  decisive: ['documentType', 'paymentMethod', 'amountDue', 'dueDate'],
  next: "An invoice marked PAID with nothing left to pay is a receipt: recorded as an expense from 'Paid from', unless a bill for it is already in QuickBooks, which holds it (D22).",
  answer: answer({
    documentType: 'receipt',
    vendorName: 'Wrenfield & Pike Bookkeeping',
    documentNumber: 'LH-2609',
    documentDate: '2026-09-30',
    subtotal: amount(bookkeepingTotal),
    total: amount(bookkeepingTotal),
    amountDue: 0,
    paymentMethod: 'check',
    spendType: 'professional_services',
    lineItems: bookkeeping,
  }),
  make: () =>
    textPdf([
      layout(
        {
          title: 'INVOICE',
          vendor: [
            'Wrenfield & Pike Bookkeeping',
            '640 Ledger Lane, Suite 2',
            'Anytown, WV 26000',
            'office@wrenfieldpike.example',
          ],
          details: [
            ['Invoice #', 'LH-2609'],
            ['Invoice date', 'September 30, 2026'],
            ['Terms', 'Net 15'],
            ['Due date', 'October 15, 2026'],
          ],
          billTo: BILL_TO,
          items: bookkeeping.map(([description, cents]) => ({ description, amount: money(cents) })),
          totals: [
            ['Subtotal', money(bookkeepingTotal)],
            ['Total', money(bookkeepingTotal)],
            ['Paid 10/01, check 1043', money(-bookkeepingTotal)],
            ['Balance due', money(0)],
          ],
          notes: ['*****  PAID IN FULL - THANK YOU  *****', 'Engagement file QZ7PAI.'],
        },
        78,
      ),
    ]),
};

const returned: [string, number][] = [
  ['Hose nozzle, 8 pattern', -949],
  ['Work gloves, large', -1_299],
];
const returnedSubtotal = sum(returned.map(([, cents]) => cents));
const returnedTax = -percentOf(-returnedSubtotal, 550);
const refunded = returnedSubtotal + returnedTax;

export const cardRefundPdf: Sample = {
  name: 'card-refund',
  file: 'refund.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7RFD',
  markerIn: 'notes',
  made: 'A return slip as a narrow text PDF from the store of the receipt sample: two items returned, amounts printed with minus signs, refunded to the Visa ending 4417, the original receipt number printed.',
  decisive: ['documentType', 'refundMethod', 'cardLast4', 'total', 'originalInvoiceNumber'],
  next: "A refund to a card: recorded as a card refund (an expense with Credit = true) on the 'Paid from' card account, its amounts made positive; the card check compares 4417.",
  answer: answer({
    documentType: 'credit_note',
    vendorName: 'Tidewell Hardware',
    documentNumber: 'R-6603',
    documentDate: '2026-10-02',
    subtotal: amount(returnedSubtotal),
    tax: amount(returnedTax),
    total: amount(refunded),
    cardLast4: '4417',
    refundMethod: 'refund_to_card',
    originalInvoiceNumber: '55120',
    spendType: 'repairs_and_maintenance',
    lineItems: returned,
  }),
  make: () =>
    textPdf(
      [
        layout(
          {
            title: 'RETURN',
            vendor: [
              'Tidewell Hardware',
              '501 Harbor Street',
              'Portside, ME 04101',
              'Tel (555) 010-8810',
            ],
            details: [
              ['Return #', 'R-6603'],
              ['Date', '10/02/2026 10:05'],
              ['Orig rcpt', '55120'],
            ],
            items: returned.map(([description, cents]) => ({ description, amount: money(cents) })),
            totals: [
              ['Subtotal', money(returnedSubtotal)],
              ['Sales tax 5.5%', money(returnedTax)],
              ['REFUND TOTAL', money(refunded)],
            ],
            notes: [
              spread('REFUNDED TO VISA ****4417', money(refunded), 40),
              '',
              '  Return code QZ7RFD',
            ],
          },
          40,
          true,
        ),
      ],
      ROLL,
    ),
};

const credited: [string, number][] = [
  ['Return: Toner cartridge, black, HL-200', -18_900],
  ['Return: Desk organizer, mesh (RMA QZ7CRM)', -2_490],
];
const creditedSubtotal = sum(credited.map(([, cents]) => cents));
/** A 5% returns allowance, kept by the supplier: printed positive, it reduces the credit. */
const allowance = percentOf(-creditedSubtotal, 500);

export const creditMemoPdf: Sample = {
  name: 'credit-memo',
  file: 'credit-memo.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7CRM',
  markerIn: 'line',
  made: 'A supplier credit memo typed into a PDF: returned lines and the total printed with minus signs, a 5% allowance printed as a positive discount, the credited invoice named, the credit kept on account.',
  decisive: [
    'documentType',
    'refundMethod',
    'subtotal',
    'discount',
    'total',
    'originalInvoiceNumber',
  ],
  next: 'A credit note kept on account: every amount but the discount is negative, so code makes them positive (213.90 less the 10.70 allowance is the 203.20 credit), with no false hold; recorded as a vendor credit for an existing vendor (F5 otherwise).',
  answer: answer({
    documentType: 'credit_note',
    vendorName: 'Harrowgate Office Supply',
    documentNumber: 'CM-0077',
    documentDate: '2026-09-22',
    subtotal: amount(creditedSubtotal),
    discount: amount(allowance),
    total: amount(creditedSubtotal + allowance),
    refundMethod: 'credit_on_account',
    originalInvoiceNumber: 'HOS-1042',
    spendType: 'office_supplies',
    lineItems: credited,
  }),
  make: () =>
    textPdf([
      layout(
        {
          title: 'CREDIT MEMO',
          vendor: [
            'Harrowgate Office Supply',
            '4100 Sample Road',
            'Springfield, IL 62704',
            'billing@harrowgate.example',
          ],
          details: [
            ['Credit memo #', 'CM-0077'],
            ['Date', 'September 22, 2026'],
            ['For invoice', 'HOS-1042'],
          ],
          billTo: BILL_TO,
          items: credited.map(([description, cents]) => ({ description, amount: money(cents) })),
          totals: [
            ['Subtotal', money(creditedSubtotal)],
            ['Less 5% allowance', money(allowance)],
            ['Total credit', money(creditedSubtotal + allowance)],
          ],
          notes: [
            'This credit has been applied to your account.',
            'It will be taken off your next payment.',
          ],
        },
        78,
      ),
    ]),
};
