import { amount, answer, money, percentOf, sum, type Sample } from './catalog.js';
import { layout, spread, type Line } from './layout.js';
import { encodePng } from './png.js';
import { Canvas, seeded } from './raster.js';
import { drawLines } from './render.js';

/**
 * Receipts a person writes on (the owner's plan of 2026-10-11, §4's new samples), each a
 * grayscale PNG as a flat scan: a restaurant receipt with a handwritten tip and total, one
 * with a tip written under a total printed before it, a card slip with only a tip written in,
 * and a receipt-book page filled in by hand for cash. The print is the bitmap font; the
 * writing is it in a seeded hand.
 */

/** Printed rows: 12 px a character at scale 2, 24 px apart, from a 30 px margin. */
const MARGIN = 30;
const ROW = 24;
const COLUMN = 12;

/** A paper `columns` wide holding `lines`, with `spare` rows below them. */
function printed(lines: readonly Line[], columns: number, spare = 1): Canvas {
  const paper = new Canvas(
    columns * COLUMN + MARGIN * 2,
    (lines.length + spare) * ROW + MARGIN * 2,
    252,
  );
  drawLines(paper, lines, MARGIN, MARGIN, ROW, { ink: 35 });
  return paper;
}

/** `text` written by hand on printed row `row`, from column `column`. */
function written(paper: Canvas, row: number, column: number, text: string, seed: number): void {
  paper.text(MARGIN + column * COLUMN, MARGIN + row * ROW - 8, text, {
    scale: 3,
    hand: seeded(seed),
  });
}

function rowOf(lines: readonly Line[], start: string): number {
  const row = lines.findIndex((line) => line.text.startsWith(start));
  if (row === -1) throw new Error(`no printed row starts ${start}`);
  return row;
}

const bistro: [string, number][] = [
  ['Grilled salmon', 2_400],
  ['Mushroom risotto', 1_800],
];
const bistroSubtotal = sum(bistro.map(([, cents]) => cents));
const bistroTax = percentOf(bistroSubtotal, 825);
const BISTRO_TIP = 900;

export const restaurantWrittenTotalPng: Sample = {
  name: 'restaurant-tip-written-total',
  file: 'receipt.png',
  contentType: 'image/png',
  marker: 'QZ7RTW',
  markerIn: 'notes',
  made: 'A restaurant receipt scanned as a grayscale PNG: two dishes, tax and the amount printed, then the tip and the final total written in by hand on its blank lines; paid by Visa ending 8812.',
  decisive: ['total', 'tip', 'subtotal', 'tax', 'paymentMethod'],
  next: "A receipt whose parts add up with the tip (42.00 + 3.47 + 9.00 = 54.47): the tip is in the total, recorded as an expense of 54.47 on meals from 'Paid from'.",
  answer: answer({
    documentType: 'receipt',
    vendorName: 'Juniperwick Bistro',
    documentNumber: '0451',
    documentDate: '2026-09-19',
    subtotal: amount(bistroSubtotal),
    tax: amount(bistroTax),
    total: amount(bistroSubtotal + bistroTax + BISTRO_TIP),
    tip: amount(BISTRO_TIP),
    paymentMethod: 'card',
    cardLast4: '8812',
    spendType: 'meals',
    lineItems: bistro,
  }),
  make: () => {
    const lines = layout(
      {
        title: 'RECEIPT',
        vendor: ['Juniperwick Bistro', '75 Orchard Lane', 'Anytown, NY 12000', '(555) 010-3317'],
        details: [
          ['Order #', '0451'],
          ['Date', '09/19/2026 13:22'],
          ['Table', '12'],
        ],
        items: bistro.map(([description, cents]) => ({ description, amount: money(cents) })),
        totals: [
          ['Subtotal', money(bistroSubtotal)],
          ['Tax 8.25%', money(bistroTax)],
          ['Amount', money(bistroSubtotal + bistroTax)],
        ],
        notes: [
          'VISA ****8812   APPROVED',
          '',
          'Tip:    ________________',
          '',
          'Total:  ________________',
          '',
          'Thank you for dining with us!',
          'Table survey QZ7RTW',
        ],
      },
      40,
      true,
    );
    const paper = printed(lines, 40);
    written(paper, rowOf(lines, 'Tip:'), 10, money(BISTRO_TIP), 451);
    written(paper, rowOf(lines, 'Total:'), 10, money(bistroSubtotal + bistroTax + BISTRO_TIP), 452);
    return encodePng(paper.width, paper.height, paper.data);
  },
};

const diner: [string, number][] = [
  ['Club sandwich', 1_450],
  ['Soup of the day', 650],
  ['Iced tea x2', 900],
];
const dinerSubtotal = sum(diner.map(([, cents]) => cents));
const dinerTax = percentOf(dinerSubtotal, 825);
const DINER_TIP = 600;

export const restaurantTipUnderTotalPng: Sample = {
  name: 'restaurant-tip-under-total',
  file: 'receipt.png',
  contentType: 'image/png',
  marker: 'QZ7RTU',
  markerIn: 'notes',
  made: 'A diner receipt scanned as a grayscale PNG: three items, tax and a printed TOTAL, then a tip written by hand under the total and no final amount; paid by Visa ending 3346.',
  decisive: ['total', 'tip', 'subtotal', 'tax'],
  next: "A tip written under a total printed before it: the parts add up only without the tip, so the expense is 32.48 plus the 6.00 tip, and the run holds ('tip of $6.00 added to the printed total').",
  answer: answer({
    documentType: 'receipt',
    vendorName: 'Saltmarsh Lane Diner',
    documentNumber: '7713',
    documentDate: '2026-09-23',
    subtotal: amount(dinerSubtotal),
    tax: amount(dinerTax),
    total: amount(dinerSubtotal + dinerTax),
    tip: amount(DINER_TIP),
    paymentMethod: 'card',
    cardLast4: '3346',
    spendType: 'meals',
    lineItems: diner,
  }),
  make: () => {
    const lines = layout(
      {
        title: 'RECEIPT',
        vendor: ['Saltmarsh Lane Diner', '3 Saltmarsh Lane', 'Anytown, ME 04000', '(555) 010-2468'],
        details: [
          ['Order #', '7713'],
          ['Date', '09/23/2026 12:47'],
        ],
        items: diner.map(([description, cents]) => ({ description, amount: money(cents) })),
        totals: [
          ['Subtotal', money(dinerSubtotal)],
          ['Tax 8.25%', money(dinerTax)],
          ['TOTAL', money(dinerSubtotal + dinerTax)],
        ],
        notes: [
          '',
          '',
          'VISA ****3346   APPROVED',
          '',
          'Thank you! Come again.',
          'Shift code QZ7RTU',
        ],
      },
      40,
      true,
    );
    const paper = printed(lines, 40);
    const total = lines.findIndex((line) => line.text.trim().startsWith('TOTAL'));
    written(paper, total + 2, 22, `TIP ${money(DINER_TIP)}`, 7713);
    return encodePng(paper.width, paper.height, paper.data);
  },
};

const SLIP_AMOUNT = 3_850;
const SLIP_TIP = 700;
const slipLines: Line[] = [
  { text: 'COPPERVANE CAFE', bold: true },
  { text: '210 Station Road' },
  { text: 'Anytown, MI 48000' },
  { text: '' },
  { text: 'MERCHANT COPY       SALE' },
  { text: 'VISA ****5521' },
  { text: 'REF # 771203' },
  { text: '09/25/2026  08:41' },
  { text: '' },
  { text: spread('AMOUNT', `$${money(SLIP_AMOUNT)}`, 32), bold: true },
  { text: '' },
  { text: spread('TIP', '__________', 32) },
  { text: '' },
  { text: spread('TOTAL', '__________', 32) },
  { text: '' },
  { text: 'X ______________________' },
  { text: 'I agree to pay the above total' },
  { text: 'per my card issuer agreement.' },
  { text: '' },
  { text: 'Terminal QZ7SLP' },
];

export const cardSlipTipOnlyPng: Sample = {
  name: 'card-slip-tip-only',
  file: 'slip.png',
  contentType: 'image/png',
  marker: 'QZ7SLP',
  markerIn: 'notes',
  made: "A café's card slip scanned as a grayscale PNG: the amount printed, a tip written on the tip line, and the total line left blank, with nothing itemised.",
  decisive: ['total', 'tip', 'subtotal'],
  next: 'A tip written in with nothing printed to show whether the total includes it: check-document fails it (C28), asking for the final total to be written on it.',
  answer: answer({
    documentType: 'receipt',
    vendorName: 'COPPERVANE CAFE',
    documentNumber: '771203',
    documentDate: '2026-09-25',
    total: amount(SLIP_AMOUNT),
    tip: amount(SLIP_TIP),
    paymentMethod: 'card',
    cardLast4: '5521',
    spendType: 'meals',
    lineItems: [],
  }),
  make: () => {
    const paper = printed(slipLines, 32);
    written(paper, rowOf(slipLines, 'TIP'), 22, money(SLIP_TIP), 5521);
    return encodePng(paper.width, paper.height, paper.data);
  },
};

export const handwrittenCashPng: Sample = {
  name: 'handwritten-cash-receipt',
  file: 'receipt.png',
  contentType: 'image/png',
  marker: 'QZ7CSH',
  markerIn: 'notes',
  made: "A receipt-book page as a grayscale PNG: the glazier's stamp and the form printed, the date, payer, purpose and amount written by hand, CASH ticked, a note written in the notes box.",
  decisive: ['documentType', 'paymentMethod', 'vendorName', 'total'],
  next: "A receipt paid in cash: recorded as an expense of 150.00 on repairs and maintenance from 'Paid from', holding with 'paid in cash' (D18).",
  answer: answer({
    documentType: 'receipt',
    vendorName: 'GLIMMERFIELD GLASS & GLAZING',
    documentNumber: '0412',
    documentDate: '2026-09-18',
    total: 150,
    paymentMethod: 'cash',
    spendType: 'repairs_and_maintenance',
    lineItems: [],
  }),
  make: () => {
    const page = new Canvas(900, 620, 250);
    page.text(40, 30, 'GLIMMERFIELD GLASS & GLAZING', { scale: 3, bold: true, ink: 60 });
    page.text(40, 64, '77 Mill Road, Anytown MA 01000  (555) 010-6125', { ink: 80 });
    page.text(40, 108, 'RECEIPT', { scale: 4, bold: true, ink: 30 });
    page.text(640, 112, 'No. 0412', { scale: 3, ink: 40 });
    const form = [
      'DATE ________________________',
      'RECEIVED FROM ______________________________________',
      'FOR ________________________________________________',
      'AMOUNT $ ______________',
      '[ ] CASH     [ ] CHECK     [ ] CARD',
      'BY ____________',
    ];
    form.forEach((text, row) => page.text(40, 190 + row * 60, text, { ink: 40 }));
    page.fill(520, 480, 340, 2, 60);
    page.fill(520, 600, 340, 2, 60);
    page.fill(520, 480, 2, 122, 60);
    page.fill(858, 480, 2, 122, 60);
    page.text(532, 490, 'NOTES', { ink: 60 });
    const hand = seeded(412);
    const write = (x: number, y: number, text: string) => page.text(x, y, text, { scale: 3, hand });
    write(110, 176, 'SEPT 18, 2026');
    write(220, 236, 'SAMPLE BAKERY LLC');
    write(96, 296, 'FRONT DOOR GLASS REPAIR');
    write(156, 356, '150.00');
    write(48, 412, 'X');
    write(84, 476, 'D.O.');
    write(540, 530, 'KEEP COPY QZ7CSH');
    return encodePng(page.width, page.height, page.data);
  },
};
