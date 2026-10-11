/**
 * A made-up invoice as monospace lines — what every sample prints, whether a PDF draws them in
 * Courier or an image in the bitmap font. Columns are counted in characters, so the same
 * layout serves both, and a text PDF holds each value as one run of text.
 */

export interface Item {
  readonly description: string;
  readonly amount: string;
  /** With a unit price: the quantity column. */
  readonly quantity?: string;
  readonly unitPrice?: string;
}

export interface Invoice {
  /** INVOICE, RECEIPT: printed top right. */
  readonly title: string;
  /** The vendor's name, then its address lines. */
  readonly vendor: readonly string[];
  /** Label and value pairs printed beside the address: the number, the dates, the terms. */
  readonly details: readonly (readonly [string, string])[];
  readonly billTo?: readonly string[];
  readonly items: readonly Item[];
  /** Label and value pairs below the lines; the last is printed bold. */
  readonly totals: readonly (readonly [string, string])[];
  readonly notes?: readonly string[];
}

export interface Line {
  readonly text: string;
  readonly bold?: boolean;
}

/** `left`, then `right` ending at column `width`. */
export function spread(left: string, right: string, width: number): string {
  const room = Math.max(1, width - left.length - right.length);
  return `${left}${' '.repeat(room)}${right}`;
}

function itemLine(item: Item, width: number): string {
  if (item.quantity === undefined) {
    return spread(item.description.slice(0, width - 14), item.amount, width);
  }
  const priced = `${item.quantity.padStart(5)}${(item.unitPrice ?? '').padStart(12)}${item.amount.padStart(12)}`;
  return spread(item.description.slice(0, width - priced.length - 2), priced, width);
}

/**
 * The whole invoice, `width` characters wide, as one run of lines — its details beside the
 * address, or `stacked` below it on a narrow receipt.
 */
export function layout(invoice: Invoice, width: number, stacked = false): Line[] {
  const [name = '', ...address] = invoice.vendor;
  const lines: Line[] = [{ text: spread(name, invoice.title, width), bold: true }];
  const details = invoice.details.map(
    ([label, value]) => `${label.padEnd(stacked ? 10 : 14)}${value}`,
  );
  if (stacked) {
    for (const line of [...address, '', ...details]) lines.push({ text: line });
  } else {
    const detailWidth = Math.max(0, ...details.map((detail) => detail.length));
    for (let row = 0; row < Math.max(address.length, details.length); row += 1) {
      lines.push({
        text: spread(address[row] ?? '', (details[row] ?? '').padEnd(detailWidth), width),
      });
    }
  }
  lines.push({ text: '' });
  if (invoice.billTo) {
    lines.push({ text: 'Bill to:', bold: true });
    for (const line of invoice.billTo) lines.push({ text: line });
    lines.push({ text: '' });
  }
  const priced = invoice.items.some((item) => item.quantity !== undefined);
  lines.push({
    text: priced
      ? spread(
          'Description',
          `${'Qty'.padStart(5)}${'Unit price'.padStart(12)}${'Amount'.padStart(12)}`,
          width,
        )
      : spread('Description', 'Amount', width),
    bold: true,
  });
  lines.push({ text: '-'.repeat(width) });
  for (const item of invoice.items) lines.push({ text: itemLine(item, width) });
  if (invoice.totals.length > 0) lines.push({ text: '-'.repeat(width) });
  invoice.totals.forEach(([label, value], index) => {
    lines.push({
      text: spread('', `${label.padEnd(18)}${value.padStart(12)}`, width),
      bold: index === invoice.totals.length - 1,
    });
  });
  if (invoice.notes && invoice.notes.length > 0) {
    lines.push({ text: '' });
    for (const note of invoice.notes) lines.push({ text: note });
  }
  return lines;
}

/**
 * `lines` cut into pages of `perPage`, each page after the first opening with `continued`,
 * and each footed with "Page i of n" when `numbered` — n the pages there are, or `claimed`.
 */
export function paginate(
  lines: readonly Line[],
  perPage: number,
  options: {
    continued?: readonly Line[];
    numbered?: boolean;
    claimed?: number;
    width?: number;
  } = {},
): Line[][] {
  const pages: Line[][] = [];
  let at = 0;
  while (at < lines.length) {
    const opening = pages.length === 0 ? [] : [...(options.continued ?? [])];
    const room = perPage - opening.length - (options.numbered ? 2 : 0);
    pages.push([...opening, ...lines.slice(at, at + room)]);
    at += room;
  }
  if (!options.numbered) return pages;
  const total = options.claimed ?? pages.length;
  return pages.map((page, index) => [
    ...page,
    { text: '' },
    { text: spread('', `Page ${index + 1} of ${total}`, options.width ?? 78) },
  ]);
}
