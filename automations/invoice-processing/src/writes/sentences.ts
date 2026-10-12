import {
  QUICKBOOKS_SENTENCES,
  type QuickBooksRead,
  type QuickBooksWrite,
} from '@autom8x/automation-kit/quickbooks';

/**
 * The fixed sentences of steps 19–24 (the plan's §5; ip-review design-after-approval-writes-
 * notify-tests.json cross_cutting[6]): each at most 200 characters, never a word from the
 * document, the model, or Intuit's `Message` and `Detail`. Before any write a failure says
 * "Nothing was created."; once create-vendor has added the vendor, every later one says so, as
 * the recommended answer to keeping that order has it: "The new vendor was added to QuickBooks."
 */

export const AFTER_APPROVAL_SENTENCES = {
  company_changed:
    'QuickBooks was connected to a different company while this waited for approval. Nothing was created.',
  /** §5, word for word. */
  duplicate_appeared:
    'A matching record was added in QuickBooks while this waited for approval, possibly from your bank feed. Nothing was created.',
  vendor_name_in_use:
    'A customer, employee or vendor with this name was added to QuickBooks while this waited for approval. Nothing was created.',
  vendor_name_too_long:
    "The vendor's name is longer than QuickBooks allows. Enter this bill by hand. Nothing was created.",
  vendor_subscription_ended:
    'The QuickBooks subscription has ended or has a billing problem. Nothing was created.',
  vendor_refused: 'QuickBooks refused to add the new vendor. Nothing was created.',
  vendor_unconfirmed:
    'QuickBooks did not confirm whether the new vendor was added, and nothing else was created. Check QuickBooks for the vendor before running this again.',
  state_incomplete:
    'Bills & Receipts could not finish its checks. Run it again. Nothing was created.',
} as const;

/** What follows a failure once create-vendor may have run: "Nothing was created.", or the vendor kept. */
export function ending(noun: string, vendorAdded: boolean): string {
  return vendorAdded
    ? `No ${noun} was created. The new vendor was added to QuickBooks.`
    : 'Nothing was created.';
}

/** A sentence that says nothing of what was created, then the ending. */
const ended = (words: string, noun: string, vendorAdded: boolean) =>
  `${words} ${ending(noun, vendorAdded)}`;

/** §5's sentence for a matching record added while the run waited, the vendor kept when it was added. */
export function duplicateAppeared(noun: string, vendorAdded: boolean): string {
  return vendorAdded
    ? ended(
        'A matching record was added in QuickBooks while this waited for approval, possibly from your bank feed.',
        noun,
        true,
      )
    : AFTER_APPROVAL_SENTENCES.duplicate_appeared;
}

/** "could not finish its checks", the vendor kept when it was added. */
export const stateIncomplete = (noun: string, vendorAdded: boolean) =>
  ended('Bills & Receipts could not finish its checks. Run it again.', noun, vendorAdded);

/**
 * confirm-no-duplicate's read failures, the kit's words for each without "nothing was created",
 * which the ending says instead: after create-vendor it would not be true.
 */
const RECHECK_WORDS: Readonly<
  Record<Extract<QuickBooksRead, { ok: false }>['reason'] | 'unexpected_answer', string>
> = {
  qb_not_connected: QUICKBOOKS_SENTENCES.qb_not_connected,
  qb_reauthorize: QUICKBOOKS_SENTENCES.qb_reauthorize,
  qb_forbidden: QUICKBOOKS_SENTENCES.qb_forbidden,
  qb_missing_scope: QUICKBOOKS_SENTENCES.qb_missing_scope,
  qb_not_configured: 'QuickBooks calls are not available on Autom8x right now. Run it again later.',
  qb_busy: QUICKBOOKS_SENTENCES.qb_busy,
  qb_error:
    'QuickBooks could not search for a matching record added while this waited for approval. Run it again.',
  platform_refused: 'Autom8x could not ask QuickBooks for a matching record. Run it again.',
  unexpected_answer:
    'QuickBooks answered the search for a matching record in an unexpected way. Run it again.',
};

export function recheckFailure(
  reason: keyof typeof RECHECK_WORDS,
  noun: string,
  vendorAdded: boolean,
): string {
  return ended(RECHECK_WORDS[reason], noun, vendorAdded);
}

/** A read of confirm-no-duplicate that threw until the SDK's attempts were spent. */
export const recheckUnreachable = (noun: string, vendorAdded: boolean) =>
  ended('Autom8x could not reach QuickBooks. Run it again in a few minutes.', noun, vendorAdded);

/**
 * create-record's sentence per Intuit code (the plan's §5 error mapping, 6200 beside 6210, and
 * 2290, 2300 and 6430 added; the design's 6140, 6240, 610, 2500, 6190 and 2050), each naming the
 * record; any other code is the kit's "QuickBooks refused the …".
 */
export function intuitSentence(code: string, noun: string): string | undefined {
  const none = `so no ${noun} was created`;
  const one = /^[aeiou]/u.test(noun) ? `an ${noun}` : `a ${noun}`;
  switch (code) {
    case '6140':
      return `QuickBooks already has ${one} with this number, ${none}. Check QuickBooks before running this again.`;
    case '6240':
      return `QuickBooks reported a name conflict on this ${noun}, ${none}.`;
    case '610':
    case '2500':
      return `An account or name this ${noun} uses is inactive or missing in QuickBooks, ${none}. Make it active, then run it again.`;
    case '6190':
      return `The QuickBooks subscription has ended or has a billing problem, ${none}.`;
    case '6200':
    case '6210':
      return `The document's date is in a period closed in QuickBooks, ${none}.`;
    case '2050':
      return `A value on this ${noun} is longer than QuickBooks allows, ${none}. Enter it by hand in QuickBooks.`;
    case '2290':
      return `QuickBooks refused a negative amount on this ${noun}, ${none}. Enter it by hand in QuickBooks.`;
    case '2300':
      return `QuickBooks found this ${noun}'s debits and credits unequal, ${none}. Enter it by hand in QuickBooks.`;
    case '6430':
      return `An account in this flow's settings is the wrong kind for this ${noun}, ${none}. Check the settings, then run it again.`;
    default:
      return undefined;
  }
}

/** The Intuit codes create-record words itself. */
export const INTUIT_CODES = [
  '6140',
  '6240',
  '610',
  '2500',
  '6190',
  '6200',
  '6210',
  '2050',
  '2290',
  '2300',
  '6430',
] as const;

/**
 * create-record's sentence for a failed write: its Intuit code's, else the kit's — "did not
 * confirm" for a write QuickBooks may have made (a 429, a 5xx, a lost answer, Fault 600) — and
 * the vendor kept when this run added it.
 */
export function recordFailure(
  write: Extract<QuickBooksWrite, { ok: false }>,
  noun: string,
  vendorAdded: boolean,
): string {
  const coded =
    write.reason === 'qb_refused' && write.detail !== undefined
      ? intuitSentence(write.detail, noun)
      : undefined;
  const sentence = coded ?? write.sentence;
  return vendorAdded ? `${sentence} The new vendor was added to QuickBooks.` : sentence;
}

/** create-vendor's sentence for a failed write: certain ones say nothing was created. */
export function vendorFailure(write: Extract<QuickBooksWrite, { ok: false }>): string {
  if (write.reason === 'qb_unconfirmed') return AFTER_APPROVAL_SENTENCES.vendor_unconfirmed;
  if (write.reason === 'qb_refused') {
    switch (write.detail) {
      case '6240':
        return AFTER_APPROVAL_SENTENCES.vendor_name_in_use;
      case '2050':
        return AFTER_APPROVAL_SENTENCES.vendor_name_too_long;
      case '6190':
        return AFTER_APPROVAL_SENTENCES.vendor_subscription_ended;
      default:
        return AFTER_APPROVAL_SENTENCES.vendor_refused;
    }
  }
  return write.sentence;
}
