import { BILL_TO, amount, answer, money, percentOf, sum, type Sample } from './catalog.js';
import { layout, spread } from './layout.js';
import { encodePng } from './png.js';
import { Canvas } from './raster.js';
import { drawLines, textPdf } from './render.js';

/**
 * Statements of three kinds (the owner's plan of 2026-10-11, §4's new samples): a utility
 * bill titled "Statement" with an earlier balance, a utility bill whose most prominent
 * number is its account number, a supplier's statement of account, and the company's own
 * card statement. Every value is printed once from the same data the answer is built from.
 */

const energy: [string, number][] = [
  ['Energy charge, 1,042 kWh at 0.1138', 11_858],
  ['Delivery charge', 980],
  ['Customer charge', 1_200],
];
const energySubtotal = sum(energy.map(([, cents]) => cents));
const energyTax = percentOf(energySubtotal, 650);
const current = energySubtotal + energyTax;
const PREVIOUS = 11_840;
const PAID = 6_000;
const forward = PREVIOUS - PAID;

export const utilityStatementPdf: Sample = {
  name: 'utility-statement-balance',
  file: 'statement.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7UTB',
  markerIn: 'notes',
  made: "An electric utility's bill titled STATEMENT, typed into a PDF: an account number and a bill number, this period's charges and tax, then the previous balance, a part payment, and a total amount due that includes the 58.40 left over.",
  decisive: ['documentType', 'documentNumber', 'total', 'amountDue'],
  next: "A bill whose amount due includes an earlier balance: recorded as a bill for this period's 149.50 on utilities and phone, holding with 'earlier balance $58.40 also due' (D24).",
  answer: answer({
    vendorName: 'Sample Valley Electric Cooperative',
    documentNumber: '4471-0926',
    documentDate: '2026-09-24',
    dueDate: '2026-10-15',
    subtotal: amount(energySubtotal),
    tax: amount(energyTax),
    total: amount(current),
    amountDue: amount(forward + current),
    spendType: 'utilities_and_phone',
    lineItems: energy,
  }),
  make: () =>
    textPdf([
      layout(
        {
          title: 'STATEMENT',
          vendor: [
            'Sample Valley Electric Cooperative',
            '9 Powerhouse Road',
            'Anytown, KS 66000',
            'Billing (555) 010-7741',
          ],
          details: [
            ['Account no.', '30-118-9902-7'],
            ['Bill no.', '4471-0926'],
            ['Bill date', '09/24/2026'],
            ['Due date', '10/15/2026'],
          ],
          billTo: BILL_TO,
          items: energy.map(([description, cents]) => ({ description, amount: money(cents) })),
          totals: [
            ['Current subtotal', money(energySubtotal)],
            ['Sales tax 6.5%', money(energyTax)],
            ['Current charges', money(current)],
            ['Previous balance', money(PREVIOUS)],
            ['Payment 09/02', money(-PAID)],
            ['Past due', money(forward)],
            ['TOTAL AMOUNT DUE', money(forward + current)],
          ],
          notes: ['Pay by 10/15/2026 to avoid a late fee.', 'Energy saver code QZ7UTB.'],
        },
        78,
      ),
    ]),
};

const water: [string, number][] = [
  ['Water, 6,200 gal', 3_162],
  ['Sewer', 2_740],
  ['Stormwater fee', 875],
];
const waterTotal = sum(water.map(([, cents]) => cents));

export const utilityAccountPng: Sample = {
  name: 'utility-account-number',
  file: 'bill.png',
  contentType: 'image/png',
  marker: 'QZ7UTA',
  markerIn: 'notes',
  made: 'A water bill as a grayscale PNG whose largest print is its account number, in a box at the top; its own invoice number, the meter number and the dates in ordinary print below.',
  decisive: ['documentNumber'],
  next: "A bill whose most prominent number is the account number: its own number is W-260915 (rule 4), so next month's bill is not held as a possible duplicate; recorded as a bill on utilities and phone.",
  answer: answer({
    vendorName: 'Example County Water District',
    documentNumber: 'W-260915',
    documentDate: '2026-09-15',
    dueDate: '2026-10-05',
    total: amount(waterTotal),
    spendType: 'utilities_and_phone',
    lineItems: water,
  }),
  make: () => {
    const page = new Canvas(860, 640, 255);
    page.text(40, 36, 'Example County Water District', { scale: 3, bold: true });
    page.text(40, 72, '1 Reservoir Drive, Anytown, MN 55000', { ink: 70 });
    page.fill(40, 110, 780, 4, 30);
    page.fill(40, 236, 780, 4, 30);
    page.text(60, 130, 'ACCOUNT NUMBER', { scale: 3, ink: 40 });
    page.text(60, 166, '0081-2276-554', { scale: 7, bold: true });
    drawLines(
      page,
      [
        { text: spread('Invoice no. W-260915', 'Bill date 09/15/2026', 64) },
        { text: spread('Meter no. 55-10294', 'Due date 10/05/2026', 64) },
        { text: 'Service: 12 Example Lane, Springfield' },
        { text: '' },
        { text: spread('Charges', 'Amount', 64), bold: true },
        { text: '-'.repeat(64) },
        ...water.map(([text, cents]) => ({ text: spread(text, `$${money(cents)}`, 64) })),
        { text: '-'.repeat(64) },
        { text: spread('', `TOTAL DUE  $${money(waterTotal)}`, 64), bold: true },
        { text: '' },
        { text: 'Conserve water: tip QZ7UTA at countywater.example' },
      ],
      40,
      270,
      26,
    );
    return encodePng(page.width, page.height, page.data);
  },
};

/** Each row a statement lists: its date, its words, its reference, its cents, its kind. */
const rows: [
  string,
  string,
  string,
  number,
  'invoice' | 'payment' | 'credit' | 'balance_forward',
][] = [
  ['09/01/2026', 'Balance forward', 'Balance forward', 21_420, 'balance_forward'],
  ['09/03/2026', 'Invoice', 'HOS-1031', 38_000, 'invoice'],
  ['09/10/2026', 'Payment - thank you', 'PMT-5520', -21_420, 'payment'],
  ['09/14/2026', 'Invoice', 'HOS-1042', 41_334, 'invoice'],
  ['09/22/2026', 'Credit memo', 'CM-0077', -20_320, 'credit'],
  ['09/28/2026', 'Invoice', 'HOS-1050', 9_640, 'invoice'],
];
const closing = sum(rows.map(([, , , cents]) => cents));

export const supplierStatementPdf: Sample = {
  name: 'supplier-statement',
  file: 'statement.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7STM',
  markerIn: 'notes',
  made: "A supplier's statement of account typed into a PDF: a balance forward, three invoices (the typed sample's HOS-1042 among them, and the latest, HOS-1050), a payment and the credit memo sample's CM-0077, then the balance due.",
  decisive: ['documentType', 'documentCount', 'listedItems', 'listedItemsComplete', 'total'],
  next: "A supplier statement: compared with the vendor's bills and open balance in QuickBooks; nothing recorded and no approval (F6 if the vendor is not in QuickBooks).",
  answer: answer({
    documentType: 'supplier_statement',
    vendorName: 'Harrowgate Office Supply',
    documentNumber: 'ST-2609-118',
    documentDate: '2026-09-30',
    total: amount(closing),
    spendType: 'other',
    lineItems: [],
    listedItems: rows.map(([, , reference, cents, kind]) => [reference, cents, kind] as const),
  }),
  make: () =>
    textPdf([
      layout(
        {
          title: 'STATEMENT OF ACCOUNT',
          vendor: [
            'Harrowgate Office Supply',
            '4100 Sample Road',
            'Springfield, IL 62704',
            'billing@harrowgate.example',
          ],
          details: [
            ['Statement no.', 'ST-2609-118'],
            ['Date', '09/30/2026'],
            ['Account', 'SB-0042'],
          ],
          billTo: BILL_TO,
          items: rows.map(([date, words, reference, cents]) => ({
            description: `${date}  ${words === reference ? words : `${words} ${reference}`}`,
            amount: money(cents),
          })),
          totals: [['Balance due', money(closing)]],
          notes: ['Please remit the balance due. Thank you.', 'Statement run QZ7STM.'],
        },
        78,
      ),
    ]),
};

const card: [string, number][] = [
  ['09/02  TIDEWELL HARDWARE PORTSIDE ME', 6_063],
  ['09/05  BLUEFINCH PRINT & SIGN', 29_853],
  ['09/21  RIDGEWICK FUEL STOP', 4_915],
];
const CARD_PREVIOUS = 61_240;
const CARD_PAYMENT = 50_000;
const purchases = sum(card.map(([, cents]) => cents));
const newBalance = CARD_PREVIOUS - CARD_PAYMENT + purchases;

export const bankStatementPdf: Sample = {
  name: 'bank-card-statement',
  file: 'statement.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7BNK',
  markerIn: 'notes',
  made: "The company's own business card statement typed into a PDF: the card ending 4417, three purchases, a payment, the previous and new balances and a minimum payment.",
  decisive: ['documentType'],
  next: "The company's own card statement: check-document fails it (C1), asking for each receipt or bill on its own and the statement to reconcile in QuickBooks (D31).",
  answer: answer({
    documentType: 'bank_statement',
    vendorName: 'Larkspur Example Bank',
    documentNumber: null,
    documentDate: '2026-09-25',
    total: amount(newBalance),
    spendType: 'other',
    lineItems: card,
  }),
  make: () =>
    textPdf([
      layout(
        {
          title: 'STATEMENT',
          vendor: [
            'Larkspur Example Bank',
            'Card Services, PO Box 0100',
            'Larkspur, CA 94939',
            'cards@larkspur-bank.example',
          ],
          details: [
            ['Account', 'Visa ending 4417'],
            ['Period', '08/26-09/25/2026'],
            ['Closing date', '09/25/2026'],
            ['Payment due', '10/20/2026'],
          ],
          billTo: BILL_TO,
          items: [
            ...card.slice(0, 2),
            ['09/18  PAYMENT - THANK YOU', -CARD_PAYMENT] as [string, number],
            ...card.slice(2),
          ].map(([description, cents]) => ({ description, amount: money(cents) })),
          totals: [
            ['Previous balance', money(CARD_PREVIOUS)],
            ['Payments', money(-CARD_PAYMENT)],
            ['Purchases', money(purchases)],
            ['Minimum payment', money(3_500)],
            ['New balance', money(newBalance)],
          ],
          notes: ['Customer service (555) 010-9930.', 'Statement code QZ7BNK.'],
        },
        78,
      ),
    ]),
};
