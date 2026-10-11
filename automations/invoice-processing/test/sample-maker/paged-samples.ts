import { BILL_TO, amount, answer, money, percentOf, sum, type Sample } from './catalog.js';
import { layout, paginate, type Invoice, type Line } from './layout.js';
import { textPdf } from './render.js';

/**
 * The samples a PDF prints as text over pages: 300 lines on seven, two invoices in one file,
 * and the first page of two alone. Every value is printed once from the same data the
 * expected answer is built from.
 */

const KINDS = [
  'Hex bolt',
  'Socket cap screw',
  'Flat washer',
  'Nylon lock nut',
  'Wood screw',
  'Blind rivet',
];
const SIZES = ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12'];
const FINISHES = ['zinc', 'stainless', 'black oxide', 'brass'];
/** 300 lines: a description and an amount each, the same on every run. */
const longLines: [string, number][] = Array.from({ length: 300 }, (_, index) => [
  `${KINDS[index % 6] ?? ''} ${SIZES[index % 7] ?? ''} x ${10 + (index % 9) * 5} mm, ${FINISHES[index % 4] ?? ''}, box of ${[25, 50, 100][index % 3] ?? 0}`,
  300 + ((index * 7_919 + 13) % 4_700),
]);
const longSubtotal = sum(longLines.map(([, cents]) => cents));
const longTax = percentOf(longSubtotal, 725);
const longInvoice: Invoice = {
  title: 'INVOICE',
  vendor: [
    'Marlowe Fastener Supply',
    '2200 Industrial Parkway',
    'Dayton, OH 45404',
    'orders@marlowe.example',
  ],
  details: [
    ['Invoice #', 'MFS-7781'],
    ['Invoice date', '09/08/2026'],
    ['Due date', '10/08/2026'],
    ['Terms', 'Net 30'],
  ],
  billTo: BILL_TO,
  items: longLines.map(([description, cents]) => ({ description, amount: money(cents) })),
  totals: [
    ['Subtotal', money(longSubtotal)],
    ['Sales tax 7.25%', money(longTax)],
    ['Freight', money(4_500)],
    ['Total', money(longSubtotal + longTax + 4_500)],
  ],
  notes: ['All amounts in USD.', 'Picked and packed by team QZ7LNG.'],
};

export const longInvoicePdf: Sample = {
  name: 'long-300-lines',
  file: 'invoice.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7LNG',
  markerIn: 'notes',
  made: 'A seven-page text PDF of 300 charged lines, numbered "Page n of 7", the totals on the last page.',
  decisive: ['lineItems', 'lineItemsComplete', 'subtotal', 'total'],
  next: 'A bill of more than 40 lines: the lines are not checked (lineItemsComplete false), the total is checked against the subtotal, tax and freight; recorded as a bill on the materials category.',
  answer: answer({
    vendorName: 'Marlowe Fastener Supply',
    documentNumber: 'MFS-7781',
    documentDate: '2026-09-08',
    dueDate: '2026-10-08',
    paymentTermsDays: 30,
    currency: 'USD',
    subtotal: amount(longSubtotal),
    tax: amount(longTax),
    shipping: 45,
    total: amount(longSubtotal + longTax + 4_500),
    spendType: 'materials',
    lineItems: longLines.slice(0, 40),
    lineItemsComplete: false,
  }),
  make: () => {
    const lines = layout(longInvoice, 78);
    const header = lines.findIndex((line) => line.text.startsWith('Description'));
    const continued: Line[] = [
      { text: 'Marlowe Fastener Supply - Invoice MFS-7781 (continued)', bold: true },
      { text: '' },
      ...lines.slice(header, header + 2),
    ];
    return textPdf(paginate(lines, 52, { continued, numbered: true }));
  },
};

const courier = (
  number: string,
  date: string,
  due: string,
  lines: [string, number][],
): Invoice => ({
  title: 'INVOICE',
  vendor: [
    'Kestrel Courier Co',
    '45 Depot Street',
    'Lakeport, MI 48059',
    'billing@kestrel.example',
  ],
  details: [
    ['Invoice #', number],
    ['Date', date],
    ['Terms', 'Net 15'],
    ['Due date', due],
  ],
  billTo: BILL_TO,
  items: lines.map(([description, cents]) => ({ description, amount: money(cents) })),
  totals: [
    ['Subtotal', money(sum(lines.map(([, cents]) => cents)))],
    ['Total (USD)', money(sum(lines.map(([, cents]) => cents)))],
  ],
});
const firstRuns: [string, number][] = [
  ['Same-day courier, 6 runs, route QZ7TWO', 13_200],
  ['Fuel surcharge', 1_100],
];

export const twoInvoicesPdf: Sample = {
  name: 'two-invoices',
  file: 'invoices.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7TWO',
  markerIn: 'line',
  made: 'Two one-page invoices from one courier in one text PDF; the answer reads the first.',
  decisive: ['documentCount'],
  next: 'More than one document in the file: check-document fails it (C5), asking for one document per run.',
  answer: answer({
    documentCount: 2,
    vendorName: 'Kestrel Courier Co',
    documentNumber: 'KCC-301',
    documentDate: '2026-09-10',
    dueDate: '2026-09-25',
    paymentTermsDays: 15,
    currency: 'USD',
    subtotal: amount(14_300),
    total: amount(14_300),
    spendType: 'other',
    lineItems: firstRuns,
  }),
  make: () =>
    textPdf([
      layout(courier('KCC-301', 'September 10, 2026', 'September 25, 2026', firstRuns), 78),
      layout(
        courier('KCC-302', 'September 17, 2026', 'October 2, 2026', [
          ['Same-day courier, 4 runs', 8_800],
          ['Weekend delivery', 3_500],
        ]),
        78,
      ),
    ]),
};

const linenLines: [string, number][] = Array.from({ length: 12 }, (_, index) => [
  `${['Table linen', 'Napkins', 'Aprons', 'Kitchen towels'][index % 4] ?? ''}, week ${index + 1}, laundered (${20 + index * 5})`,
  1_800 + index * 350,
]);

export const missingPagePdf: Sample = {
  name: 'missing-page',
  file: 'invoice.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7MSP',
  markerIn: 'notes',
  made: 'The first page of a two-page text PDF alone: "Page 1 of 2", the lines continued, no totals.',
  decisive: ['pagesMissing'],
  next: 'Pages are missing: check-document fails it (C6), asking for the whole document.',
  answer: answer({
    pagesMissing: true,
    vendorName: 'Fernhill Linen Service',
    documentNumber: 'FLS-4470',
    documentDate: '2026-09-25',
    dueDate: '2026-10-25',
    paymentTermsDays: 30,
    total: null,
    spendType: 'other',
    lineItems: linenLines,
    lineItemsComplete: false,
    uncertainFields: ['total'],
  }),
  make: () => {
    const lines = layout(
      {
        title: 'INVOICE',
        vendor: [
          'Fernhill Linen Service',
          '820 Mill Road',
          'Ashby, MA 01431',
          'ar@fernhill.example',
        ],
        details: [
          ['Invoice #', 'FLS-4470'],
          ['Invoice date', '09/25/2026'],
          ['Due date', '10/25/2026'],
          ['Terms', 'Net 30'],
        ],
        billTo: BILL_TO,
        items: linenLines.map(([description, cents]) => ({ description, amount: money(cents) })),
        totals: [],
        notes: ['Continued on page 2.', 'Delivery route QZ7MSP.'],
      },
      78,
    );
    const [first = []] = paginate(lines, 52, { numbered: true, claimed: 2 });
    return textPdf([first]);
  },
};
