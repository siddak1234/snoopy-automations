import { amount, answer, money, percentOf, sum, type Sample } from './catalog.js';
import { encodeJpeg } from './jpeg.js';
import { layout, spread, type Line } from './layout.js';
import { Canvas, seeded } from './raster.js';
import { drawLines } from './render.js';

/**
 * Receipts photographed with a phone (the owner's plan of 2026-10-11, §4's new samples), each
 * a JPEG: a store receipt and a fuel stop's card slip on a dark table, and a long thermal
 * receipt at the 2,576-pixel long side the apps shrink a photo to.
 */

/** Thermal paper holding `lines`: 12 px a character, `row` px apart, from a 30 px margin. */
function thermal(lines: readonly Line[], columns: number, row = 24, height?: number): Canvas {
  const paper = new Canvas(columns * 12 + 60, height ?? lines.length * row + 90, 246);
  drawLines(paper, lines, 30, 30, row, { ink: 45 });
  return paper;
}

/** The paper on a dark table, turned, lit unevenly, soft, grainy and warm: a phone's colour JPEG. */
function photographed(paper: Canvas, degrees: number, seed: number): Uint8Array {
  const table = new Canvas(paper.width + 220, paper.height + 260, 70);
  table.paste(paper.rotated(degrees, 70), 110, 130);
  table.shade(80);
  table.blur();
  table.grain(seeded(seed), 4);
  return encodeJpeg(table.width, table.height, table.warm(), 3, 62);
}

const office: [string, number][] = [
  ['Printer paper, case', 5_299],
  ['Gel pens, black 12pk', 1_149],
  ['Shipping labels 120ct', 1_875],
  ['Stapler, desktop', 1_429],
];
const officeSubtotal = sum(office.map(([, cents]) => cents));
const officeTax = percentOf(officeSubtotal, 650);

export const storeReceiptJpeg: Sample = {
  name: 'store-receipt',
  file: 'photo.jpg',
  contentType: 'image/jpeg',
  marker: 'QZ7STR',
  markerIn: 'notes',
  made: "A phone photo of an office store's thermal receipt on a dark table, turned 1.8 degrees: four items, tax, paid by debit card ending 2291.",
  decisive: ['documentType', 'paymentMethod', 'cardLast4', 'total'],
  next: "A store receipt paid by card: recorded as an expense on office supplies from 'Paid from'; the card check compares 2291 with the company card's digits.",
  answer: answer({
    documentType: 'receipt',
    vendorName: 'Brightquill Office Mart',
    documentNumber: '448190',
    documentDate: '2026-09-29',
    subtotal: amount(officeSubtotal),
    tax: amount(officeTax),
    total: amount(officeSubtotal + officeTax),
    paymentMethod: 'card',
    cardLast4: '2291',
    spendType: 'office_supplies',
    lineItems: office,
  }),
  make: () => {
    const lines = layout(
      {
        title: 'RECEIPT',
        vendor: [
          'Brightquill Office Mart',
          '220 Commerce Way',
          'Anytown, MN 56000',
          'Store 0214 (555) 010-6620',
        ],
        details: [
          ['Trans #', '448190'],
          ['Date', '09/29/2026 11:04'],
          ['Register', '3'],
        ],
        items: office.map(([description, cents]) => ({ description, amount: money(cents) })),
        totals: [
          ['Subtotal', money(officeSubtotal)],
          ['Sales tax 6.5%', money(officeTax)],
          ['TOTAL', money(officeSubtotal + officeTax)],
        ],
        notes: [
          'DEBIT CARD ****2291',
          'APPROVED  AUTH 004512',
          '',
          'Thank you for shopping!',
          'Rewards QZ7STR',
        ],
      },
      40,
      true,
    );
    return photographed(thermal(lines, 40), -1.8, 448);
  },
};

const FUEL = 4_915;
const fuelLines: Line[] = [
  { text: 'RIDGEWICK FUEL STOP', bold: true },
  { text: '4400 Highway 9' },
  { text: 'Anytown, CO 81000' },
  { text: '' },
  { text: 'CUSTOMER COPY' },
  { text: '09/21/2026  17:36' },
  { text: 'TRAN # 091842' },
  { text: '' },
  { text: 'PUMP 04' },
  { text: spread('UNLEADED 14.210 GAL', `$${money(FUEL)}`, 32) },
  { text: '  @ $3.459/GAL' },
  { text: '' },
  { text: spread('TOTAL', `$${money(FUEL)}`, 32), bold: true },
  { text: '' },
  { text: 'MASTERCARD ****6604' },
  { text: 'AUTH 093317   APPROVED' },
  { text: '' },
  { text: 'Loyalty QZ7CRD' },
];

export const cardSlipJpeg: Sample = {
  name: 'card-slip',
  file: 'photo.jpg',
  contentType: 'image/jpeg',
  marker: 'QZ7CRD',
  markerIn: 'notes',
  made: "A phone photo of a fuel stop's card slip on a dark table, turned 2.2 degrees: one fuel line and the total, paid by Mastercard ending 6604.",
  decisive: ['documentType', 'cardLast4', 'total', 'spendType'],
  next: "A card slip: recorded as an expense on vehicle and fuel from 'Paid from'; the card check compares 6604.",
  answer: answer({
    documentType: 'receipt',
    vendorName: 'RIDGEWICK FUEL STOP',
    documentNumber: '091842',
    documentDate: '2026-09-21',
    total: amount(FUEL),
    paymentMethod: 'card',
    cardLast4: '6604',
    spendType: 'vehicle_and_fuel',
    lineItems: [['UNLEADED 14.210 GAL', FUEL]],
  }),
  make: () => photographed(thermal(fuelLines, 32), 2.2, 6604),
};

const PANTRY = [
  'Bread flour 50 lb',
  'Cake flour 25 lb',
  'Granulated sugar 50 lb',
  'Brown sugar 25 lb',
  'Powdered sugar 10 lb',
  'Butter, unsalted 36 lb',
  'Shortening 50 lb',
  'Eggs, large 15 dz',
  'Whole milk 4 gal',
  'Heavy cream 1 gal',
  'Cream cheese 3 lb',
  'Yeast, instant 2 lb',
  'Baking soda 5 lb',
  'Baking powder 5 lb',
  'Salt, fine 25 lb',
  'Vanilla extract 32 oz',
  'Cocoa powder 5 lb',
  'Chocolate chips 25 lb',
  'Walnut halves 5 lb',
  'Pecan pieces 5 lb',
];
/** Sixty lines, the same on every run. */
const supplies: [string, number][] = Array.from({ length: 60 }, (_, index) => [
  `${PANTRY[index % 20] ?? ''}${index >= 20 ? ` #${Math.floor(index / 20) + 1}` : ''}`,
  500 + ((index * 3_331 + 17) % 6_400),
]);
const suppliesSubtotal = sum(supplies.map(([, cents]) => cents));
const suppliesTax = percentOf(suppliesSubtotal, 290);
/** The long side the apps shrink a photo to (ip-review spec.json items[14]). */
const LONG_SIDE = 2_576;

export const longThermalJpeg: Sample = {
  name: 'long-thermal-receipt',
  file: 'photo.jpg',
  contentType: 'image/jpeg',
  marker: 'QZ7LTR',
  markerIn: 'notes',
  made: "A restaurant supplier's 60-line thermal receipt photographed flat as a grayscale JPEG 600 px wide and 2,576 px long, the long side the apps shrink a photo to; small print, soft and grainy.",
  decisive: ['lineItems', 'lineItemsComplete', 'subtotal', 'tax', 'total'],
  next: 'A receipt of more than 40 lines: the lines are not checked (lineItemsComplete false); recorded as an expense on materials. Its recordings measure whether the small print stays readable.',
  answer: answer({
    documentType: 'receipt',
    vendorName: 'Fernwick Restaurant Supply',
    documentNumber: 'R-77102',
    documentDate: '2026-09-30',
    subtotal: amount(suppliesSubtotal),
    tax: amount(suppliesTax),
    total: amount(suppliesSubtotal + suppliesTax),
    paymentMethod: 'card',
    cardLast4: '1180',
    spendType: 'materials',
    lineItems: supplies.slice(0, 40),
    lineItemsComplete: false,
  }),
  make: () => {
    const lines = layout(
      {
        title: 'RECEIPT',
        vendor: [
          'Fernwick Restaurant Supply',
          '1200 Commerce Park Dr',
          'Anytown, IN 46000',
          '(555) 010-5530',
        ],
        details: [
          ['Receipt', 'R-77102'],
          ['Date', '09/30/2026 07:55'],
        ],
        items: supplies.map(([description, cents]) => ({ description, amount: money(cents) })),
        totals: [
          ['Subtotal', money(suppliesSubtotal)],
          ['Tax 2.9%', money(suppliesTax)],
          ['TOTAL', money(suppliesSubtotal + suppliesTax)],
        ],
        notes: ['VISA ****1180   APPROVED', '', 'Member QZ7LTR - thank you'],
      },
      40,
      true,
    );
    const row = Math.floor((LONG_SIDE - 90) / lines.length);
    const paper = thermal(lines, 45, row, LONG_SIDE);
    paper.blur();
    paper.grain(seeded(77_102), 3);
    return encodeJpeg(paper.width, paper.height, paper.data, 1, 70);
  },
};
