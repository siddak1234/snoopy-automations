/**
 * Currency codes (ip-review design-checks-rules-and-approval.json, cross_cutting[0] item 4; Group
 * 3's D1): a printed code is kept only when it is a currency of ISO 4217's List One in use today.
 */

/**
 * ISO 4217 List One as SIX published it on 2026-09-17
 * (https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml),
 * 178 codes, less the ten fund codes (BOV, CHE, CHW, CLF, COU, MXV, USN, UYI, UYW, XAD) and the
 * thirteen with no minor unit (XAG, XAU, XBA, XBB, XBC, XBD, XDR, XPD, XPT, XSU, XTS, XUA, XXX):
 * 155 codes, in the list's alphabetical order. XAF, XCD, XCG, XOF and XPF are currencies and stay.
 */
export const ISO_4217_LIST_ONE = {
  published: '2026-09-17',
  codes: [
    'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN',
    'BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB',
    'EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR',
    'ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD',
    'MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR',
    'PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE',
    'SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU',
    'UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG',
  ]
    .join(' ')
    .split(' ') as readonly string[],
} as const;

const CODES: ReadonlySet<string> = new Set(ISO_4217_LIST_ONE.codes);

/** One currency as read: none printed, a code on the list, or anything else — whose text is not kept. */
export type CurrencyReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'unrecognised' };

/** A printed currency, trimmed and upper-cased: `usd` is USD; `US$`, `XXX` and `XAU` are not recognised. */
export function cleanCurrency(value: unknown): CurrencyReading {
  if (value === null || value === undefined) return { kind: 'none' };
  if (typeof value !== 'string') return { kind: 'unrecognised' };
  const code = value.trim().toUpperCase();
  if (code === '') return { kind: 'none' };
  return CODES.has(code) ? { kind: 'code', code } : { kind: 'unrecognised' };
}
