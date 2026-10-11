import { BILL_TO, amount, answer, money, percentOf, sum, type Sample } from './catalog.js';
import { encodeJpeg } from './jpeg.js';
import { layout, spread, type Line } from './layout.js';
import { encodePng } from './png.js';
import { Canvas, seeded } from './raster.js';
import { drawLines, scannedPdf } from './render.js';

/**
 * The samples with no text layer, drawn in the bitmap font: a scan in a PDF, a phone photo, a
 * portal screenshot, and a hand-printed invoice — all bills. A model reads them as pictures.
 */

const scanLines: [string, number][] = [
  ['Office cleaning, September (12 visits)', 84_000],
  ['Carpet shampoo, conference room', 16_500],
  ['Window washing, ground floor', 12_000],
  ['Supplies: liners, soap, towels', 4_680],
];
const scanSubtotal = sum(scanLines.map(([, cents]) => cents));
/** 5% off the three services. */
const scanDiscount = percentOf(84_000 + 16_500 + 12_000, 500);

export const scannedImagePdf: Sample = {
  name: 'scanned-image-pdf',
  file: 'scan.pdf',
  contentType: 'application/pdf',
  marker: 'QZ7SCN',
  markerIn: 'notes',
  made: 'A scanner\'s PDF: one grayscale JPEG of a page, turned 0.6 degrees, softened and speckled, with no text layer; "Due on receipt", a discount, a bare $.',
  decisive: ['documentDate', 'paymentTermsDays', 'discount', 'total', 'currency'],
  next: 'A bill due on receipt: recorded as a bill; with no currency printed, USD is used (a new vendor holds, saying so).',
  answer: answer({
    vendorName: 'Pinecrest Janitorial Services',
    documentNumber: 'PJS-0388',
    documentDate: '2026-09-22',
    paymentTermsDays: 0,
    subtotal: amount(scanSubtotal),
    discount: amount(scanDiscount),
    total: amount(scanSubtotal - scanDiscount),
    spendType: 'repairs_and_maintenance',
    lineItems: scanLines,
  }),
  make: () => {
    const page = new Canvas(850, 1100);
    drawLines(
      page,
      layout(
        {
          title: 'INVOICE',
          vendor: [
            'Pinecrest Janitorial Services',
            '77 Placeholder Avenue',
            'Riverton, OH 45999',
            '(555) 010-2277',
          ],
          details: [
            ['Invoice No.', 'PJS-0388'],
            ['Date', '09/22/2026'],
            ['Terms', 'Due on receipt'],
          ],
          billTo: BILL_TO,
          items: scanLines.map(([description, cents]) => ({
            description,
            amount: money(cents, '$'),
          })),
          totals: [
            ['Subtotal', money(scanSubtotal, '$')],
            ['Discount 5%', money(-scanDiscount, '$')],
            ['TOTAL DUE', money(scanSubtotal - scanDiscount, '$')],
          ],
          notes: [
            'Please make checks payable to Pinecrest Janitorial Services.',
            'Crew sheet QZ7SCN on file.',
          ],
        },
        64,
      ),
      41,
      70,
      22,
    );
    const scan = page.rotated(0.6, 255);
    const random = seeded(388);
    scan.blur();
    scan.grain(random, 3);
    scan.dust(random, 300);
    return scannedPdf(scan, 50);
  },
};

const photoLines: [string, number][] = [
  ['Vinyl banner 3 x 8 ft, full color, QZ7PHO', 12_800],
  ['Business cards, 500, matte', 6_400],
  ['A-frame sign insert, 2 sided', 8_650],
];
const photoSubtotal = sum(photoLines.map(([, cents]) => cents));
const photoTax = percentOf(photoSubtotal, 825);

export const phonePhotoJpeg: Sample = {
  name: 'phone-photo-jpeg',
  file: 'photo.jpg',
  contentType: 'image/jpeg',
  marker: 'QZ7PHO',
  markerIn: 'line',
  made: 'A colour JPEG like a phone photo: the page turned 2.5 degrees on a dark table, lit unevenly, warm, grainy; dates as month/day/year, one final "AMOUNT DUE".',
  decisive: ['documentDate', 'dueDate', 'total', 'amountDue', 'spendType'],
  next: 'A bill: recorded as a bill on the advertising category.',
  answer: answer({
    vendorName: 'Bluefinch Print & Sign',
    documentNumber: 'BPS-2207',
    documentDate: '2026-09-03',
    dueDate: '2026-10-03',
    paymentTermsDays: 30,
    subtotal: amount(photoSubtotal),
    tax: amount(photoTax),
    total: amount(photoSubtotal + photoTax),
    spendType: 'advertising',
    lineItems: photoLines,
  }),
  make: () => {
    const paper = new Canvas(780, 1010, 250);
    drawLines(
      paper,
      layout(
        {
          title: 'INVOICE',
          vendor: [
            'Bluefinch Print & Sign',
            '9 Market Row',
            'Fairview, TX 75069',
            'hello@bluefinch.example',
          ],
          details: [
            ['Invoice', 'BPS-2207'],
            ['Date', '09/03/2026'],
            ['Due', '10/03/2026'],
            ['Terms', 'Net 30'],
          ],
          billTo: BILL_TO,
          items: photoLines.map(([description, cents]) => ({
            description,
            amount: money(cents, '$'),
          })),
          totals: [
            ['Subtotal', money(photoSubtotal, '$')],
            ['Sales tax 8.25%', money(photoTax, '$')],
            ['AMOUNT DUE', money(photoSubtotal + photoTax, '$')],
          ],
          notes: ['Thank you! Pay online at bluefinch.example/pay'],
        },
        60,
      ),
      30,
      44,
      22,
    );
    const table = new Canvas(960, 1280, 70);
    table.paste(paper.rotated(-2.5, 70), 90, 135);
    table.shade(90);
    table.blur();
    table.grain(seeded(2207), 4);
    return encodeJpeg(table.width, table.height, table.warm(), 3, 62);
  },
};

const portalLines: [string, number][] = [
  ['Lunch catering, 25 guests, event QZ7SCR', 56_250],
  ['Coffee service, half day', 9_500],
  ['Dessert tray, large', 4_800],
];
const portalSubtotal = sum(portalLines.map(([, cents]) => cents));
const portalTax = percentOf(portalSubtotal, 625);
const portalTotal = portalSubtotal + 4_000 + portalTax;

export const screenshotPng: Sample = {
  name: 'png-screenshot',
  file: 'screenshot.png',
  contentType: 'image/png',
  marker: 'QZ7SCR',
  markerIn: 'line',
  made: 'A grayscale PNG screenshot of a billing portal: a header bar, the invoice in a card, a Pay now button; US$ amounts, and the amount due printed beside the total.',
  decisive: ['currency', 'shipping', 'total', 'amountDue', 'paymentTermsDays'],
  next: 'A bill whose amount due equals its total: recorded as a bill on the meals category.',
  answer: answer({
    vendorName: 'Copperleaf Catering',
    documentNumber: 'CLC-0915',
    documentDate: '2026-09-18',
    dueDate: '2026-10-02',
    paymentTermsDays: 14,
    currency: 'USD',
    subtotal: amount(portalSubtotal),
    tax: amount(portalTax),
    shipping: 40,
    total: amount(portalTotal),
    amountDue: amount(portalTotal),
    spendType: 'meals',
    lineItems: portalLines,
  }),
  make: () => {
    const screen = new Canvas(900, 1040, 246);
    screen.fill(0, 0, 900, 64, 40);
    screen.text(30, 18, 'Copperleaf Catering | Customer Portal', {
      ink: 235,
      light: true,
      scale: 3,
    });
    screen.text(30, 88, 'Invoices > CLC-0915', { ink: 90 });
    screen.fill(26, 120, 848, 2, 200);
    screen.fill(26, 120, 2, 820, 200);
    screen.fill(872, 120, 2, 820, 200);
    screen.fill(26, 938, 848, 2, 200);
    screen.fill(28, 122, 844, 816, 255);
    const lines: Line[] = layout(
      {
        title: 'INVOICE',
        vendor: [
          'Copperleaf Catering',
          '310 Orchard Street',
          'Greenvale, WA 98000',
          'accounts@copperleaf.example',
        ],
        details: [
          ['Invoice', 'CLC-0915'],
          ['Issued', '2026-09-18'],
          ['Due', '2026-10-02'],
          ['Terms', 'Net 14'],
        ],
        billTo: BILL_TO,
        items: portalLines.map(([description, cents]) => ({
          description,
          amount: money(cents, 'US$'),
        })),
        totals: [
          ['Subtotal', money(portalSubtotal, 'US$')],
          ['Delivery', money(4_000, 'US$')],
          ['Tax 6.25%', money(portalTax, 'US$')],
          ['Total', money(portalTotal, 'US$')],
          ['Amount due', money(portalTotal, 'US$')],
        ],
      },
      68,
    );
    drawLines(screen, lines, 42, 150, 22);
    screen.fill(660, 960, 210, 48, 50);
    screen.text(708, 976, 'Pay now', { ink: 245, light: true, bold: true });
    screen.text(30, 1016, '(c) 2026 Copperleaf Catering', { ink: 140 });
    return encodePng(screen.width, screen.height, screen.data);
  },
};

const handLines: [string, number][] = [
  ['TUNE-UP, RIDING MOWER QZ7HND', 9_500],
  ['NEW BLADES (2)', 3_800],
  ['OIL + FILTER', 2_250],
];
const handTotal = sum(handLines.map(([, cents]) => cents));

export const handwrittenPng: Sample = {
  name: 'handwritten-png',
  file: 'handwritten.png',
  contentType: 'image/png',
  marker: 'QZ7HND',
  markerIn: 'line',
  made: 'A hand-printed invoice in capitals on ruled paper, each letter shifted and slanted by a seeded hand, as a grayscale PNG; a date in words, a total only, terms in days.',
  decisive: ['vendorName', 'documentDate', 'total', 'paymentTermsDays'],
  next: 'A bill with no subtotal: the total is checked against the three lines; recorded as a bill on the repairs and maintenance category.',
  answer: answer({
    vendorName: 'NORTHGATE MOWER REPAIR',
    documentNumber: '0417',
    documentDate: '2026-09-03',
    paymentTermsDays: 15,
    total: amount(handTotal),
    spendType: 'repairs_and_maintenance',
    lineItems: handLines,
  }),
  make: () => {
    const sheet = new Canvas(900, 1180, 250);
    for (let y = 96; y < 1160; y += 40) sheet.fill(0, y, 900, 1, 200);
    sheet.fill(70, 0, 2, 1180, 215);
    const written = [
      'NORTHGATE MOWER REPAIR',
      '18 HILL RD, MILLBROOK NY 12545',
      spread('', 'INVOICE NO. 0417', 44),
      spread('', 'DATE: SEPT 3, 2026', 44),
      'TO: SAMPLE BAKERY LLC',
      '    12 EXAMPLE LANE, SPRINGFIELD IL',
      '',
      ...handLines.map(([text, cents]) =>
        spread(`${text} `, ` ${money(cents)}`, 44).replace(
          / {3,}/u,
          (gap) => ` ${'.'.repeat(gap.length - 2)} `,
        ),
      ),
      '',
      spread('', `TOTAL  $ ${money(handTotal)}`, 44),
      'PAYABLE IN 15 DAYS.  THANK YOU!',
    ];
    // One row on every other ruled line, its letters' feet on the line.
    const hand = seeded(417);
    written.forEach((text, row) => {
      if (text.trim() !== '') sheet.text(84, 113 + row * 80, text, { scale: 3, hand });
    });
    return encodePng(sheet.width, sheet.height, sheet.data);
  },
};
