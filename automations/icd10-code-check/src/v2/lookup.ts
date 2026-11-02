import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CodeTable, TableId } from '../tables.js';

/**
 * Code choices from the official ICD-10-CM Alphabetic Index (the owner's I1, 2026-11-01; the
 * guidelines' I.B.1, "first locate the term in the Alphabetic Index, and then verify the code in
 * the Tabular List"). Each table's index is a built asset, `assets/v2/index-<table>.json`: every
 * index path that names a code, its levels' words as `termWords` keeps them, levels joined by "|"
 * and a level's alternatives ("Disease, diseased") by ",". A diagnosis is looked up exact, then by
 * main term and subterms, then by keyword, the keyword stage with the Tabular's titles too; each
 * code found is verified in the Tabular — kept when flag 1, else its flag-1 codes under it, ranked
 * by the words their titles share with the statement, so laterality and a 7th character come from
 * the Tabular only. "with" and "without" ("no" read as it) are words: a path's "with" is said unless
 * the statement says "without", and a "without" statement settles only on a path or a code whose
 * Tabular title holds it too.
 */

const STOP = new Set('a an and as at by due for in is nec nos of on or other the to'.split(' '));

/** Short forms a note prints, read as the index words them. */
const SHORT: Readonly<Record<string, string>> = {
  afib: 'atrial fibrillation',
  aki: 'acute kidney injury',
  bph: 'benign prostatic hyperplasia',
  cad: 'coronary artery disease',
  chf: 'congestive heart failure',
  ckd: 'chronic kidney disease',
  copd: 'chronic obstructive pulmonary disease',
  dm: 'diabetes mellitus',
  esrd: 'end stage renal disease',
  gerd: 'gastro esophageal reflux disease',
  hf: 'heart failure',
  hld: 'hyperlipidemia',
  htn: 'hypertension',
  mi: 'myocardial infarction',
  no: 'without',
  osa: 'obstructive sleep apnea',
  sob: 'shortness breath',
  t1dm: 'type 1 diabetes mellitus',
  t2dm: 'type 2 diabetes mellitus',
  uti: 'urinary tract infection',
};

/** A text's words as the lookup compares them: lowercased, short forms spelt out, plurals cut, connectives left out. */
export function termWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text
    .toLowerCase()
    .replace(/'s\b/gu, '')
    .match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const word of (SHORT[raw] ?? raw).split(' ')) {
      const stem =
        word.length > 4 && word.endsWith('s') && !/(ss|us|is)$/u.test(word)
          ? word.slice(0, -1)
          : word;
      if (!STOP.has(stem)) out.push(stem);
    }
  }
  return out;
}

/**
 * An index title as one stored level: its alternatives' words ("Disease, diseased"; "atrial or
 * auricular"; "ankle and foot", either said), "" when a level is a connective alone.
 */
export function levelOf(title: string): string {
  const alternatives = title.split(/,|\bor\b|\band\b/u).map((one) => termWords(one).join(' '));
  return alternatives.includes('') ? '' : alternatives.join(',');
}

interface Index {
  paths: string[];
  codes: string[];
  /** Per word, the entries holding it, each once. */
  postings: Map<string, number[]>;
}

let held: { id: TableId; index: Index } | undefined;

/** The visit's table's index, read once and replaced when another table is needed. */
export function loadIndex(id: TableId): Index {
  if (held?.id !== id) {
    const { terms } = JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../assets/v2/index-${id}.json`, import.meta.url)),
        'utf8',
      ),
    ) as { terms: Record<string, string> };
    const paths = Object.keys(terms);
    const postings = new Map<string, number[]>();
    paths.forEach((path, at) => {
      for (const word of new Set(path.split(/[|, ]/u))) {
        if (word === '') continue;
        const list = postings.get(word);
        if (list === undefined) postings.set(word, [at]);
        else list.push(at);
      }
    });
    held = { id, index: { paths, codes: paths.map((path) => terms[path]!), postings } };
  }
  return held.index;
}

/** How a diagnosis was found: whole, by main term and subterms, by keyword, or not at all. */
export type Via = 'exact' | 'term' | 'keyword' | 'none';

export interface Lookup {
  /** The one verified code the index gives, exact or by term; null when it gives none or several. */
  settled: string | null;
  via: Via;
  /** Every verified code found, best first. */
  codes: string[];
}

const shared = (title: string, said: ReadonlySet<string>): number =>
  new Set(termWords(title).filter((word) => said.has(word))).size;

/**
 * A code verified in the Tabular: itself when flag 1, else the flag-1 codes under it ranked by the
 * words their titles share with the statement; `strict` when the first shares more than the next.
 */
export function verify(
  code: string,
  codes: CodeTable,
  said: ReadonlySet<string>,
): { codes: string[]; strict: boolean } {
  const stem = code.replace(/[.-]+$/u, '');
  if (stem in codes) return { codes: [stem], strict: true };
  const under = Object.keys(codes)
    .filter((one) => one.startsWith(stem) && (stem.length > 3 || one[3] === '.'))
    .map((one, order) => ({ one, order, score: shared(codes[one]!, said) }))
    .sort((a, b) => b.score - a.score || a.one.length - b.one.length || a.order - b.order);
  return {
    codes: under.map((entry) => entry.one),
    strict: under.length === 1 || (under.length > 1 && under[0]!.score > under[1]!.score),
  };
}

/**
 * Whether every level of a path is a connective or has an alternative whose words were all said, a
 * "with" said unless the statement says "without".
 */
const said = (path: string, words: ReadonlySet<string>): boolean =>
  path
    .split('|')
    .every(
      (level) =>
        level === '' ||
        level
          .split(',')
          .some((alternative) =>
            alternative
              .split(' ')
              .every((w) => words.has(w) || (w === 'with' && !words.has('without'))),
          ),
    );

/** A diagnosis's statement looked up in the index, its codes verified in the Tabular. */
export function lookUp(statement: string, index: Index, codes: CodeTable): Lookup {
  const words = new Set(termWords(statement));
  const hits = new Map<number, number>();
  for (const word of words) {
    for (const at of index.postings.get(word) ?? []) hits.set(at, (hits.get(at) ?? 0) + 1);
  }
  const ranked = [...hits].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const found = ranked.filter(([at]) => said(index.paths[at]!, words));
  const exact = found.filter(([, n]) => n === words.size);
  const via: Via =
    exact.length > 0 ? 'exact' : found.length > 0 ? 'term' : ranked.length > 0 ? 'keyword' : 'none';
  const most = Math.max(1, Math.ceil(words.size / 2));
  const entries =
    via === 'exact'
      ? exact
      : via === 'term'
        ? found
        : ranked.filter(([, n]) => n >= most).slice(0, 10);
  const top = entries.filter(([, n]) => n === entries[0]?.[1]);
  const verified = entries.map(([at]) => verify(index.codes[at]!, codes, words));
  const firsts = new Set(
    verified
      .slice(0, top.length)
      .map((one) => (one.strict ? one.codes[0] : undefined))
      .filter((code) => code !== undefined),
  );
  const strict = verified.slice(0, top.length).every((one) => one.strict);
  const first = firsts.size === 1 ? [...firsts][0]! : undefined;
  // A "without" statement settles only on a path, or a code's Tabular title, that holds it too.
  const negationKept =
    !words.has('without') ||
    (first !== undefined && termWords(codes[first]!).includes('without')) ||
    top.every(([at]) => index.paths[at]!.split(/[|, ]/u).includes('without'));
  const titled =
    via === 'keyword' || via === 'none'
      ? Object.keys(codes)
          .map((code) => ({ code, n: shared(codes[code]!, words) }))
          .filter((one) => one.n >= most)
          .sort((a, b) => b.n - a.n)
          .slice(0, 10)
          .map((one) => one.code)
      : [];
  return {
    settled: (via === 'exact' || via === 'term') && strict && negationKept ? (first ?? null) : null,
    via,
    codes: [...new Set([...verified.flatMap((one) => one.codes), ...titled])],
  };
}
