import {
  BLOCK_LIMITS,
  type EmittedBlock,
  type EmittedLeaf,
  type LinkBrand,
  type LinksBlock,
  type ListItem,
  type SectionBlock,
} from '@autom8x/automation-sdk';

import type { Posting, Resume } from './reading.js';
import type { Scoring } from './scoring.js';
import { periodLine } from './years.js';

/**
 * What a person opens (the spec's §7), v4 (the owner's items 11–13 on build 37, 2026-11-05): the
 * blocks of a candidate's run page, and of a job's "What AI read", in place of v3's sections. A
 * candidate is one group, "Candidate details", of sections in v3's order; a job is its four
 * sections. A section with nothing in it is left out; the SDK bounds every block before it is sent
 * (`boundedBlocks`). No top-level metric or badge: the run email stays as it is.
 */

/** The group a candidate's sections sit in: the title the run page gave v3's sections. */
export const CANDIDATE_GROUP = 'Candidate details';

/** The words of Contact's rows and a job's Details (the owner's items 11–13, approved 2026-11-06). */
export const CONTACT_WORDS = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  location: 'Location',
} as const;

/** The most characters a links button's label shows: the platform's word (its `wordLength`). */
export const LABEL_LENGTH = 40;

/** A section of these blocks, or nothing when none has anything in it. */
function section(title: string, ...blocks: (EmittedLeaf | undefined)[]): SectionBlock[] {
  const kept = blocks.filter((block): block is EmittedLeaf => block !== undefined);
  return kept.length === 0 ? [] : [{ type: 'section', title, blocks: kept }];
}

/** A list of these rows, or none when there are none. */
const list = (items: readonly ListItem[]): EmittedLeaf | undefined =>
  items.length === 0 ? undefined : { type: 'list', items };

/** A row naming a value, `{ title: label, text: value }`, or none when the value is empty. */
const labelled = (label: string, value: string): ListItem[] =>
  value === '' ? [] : [{ title: label, text: value }];

/** Words joined with " · ", the empty ones left out. */
const joined = (...parts: string[]) => parts.filter((part) => part !== '').join(' · ');

const each = (values: readonly string[]): ListItem[] => values.map((title) => ({ title }));

/** The sites a button carries the logo of, by host (a subdomain of one counts as it). */
const BRANDS: Readonly<Record<string, LinkBrand>> = {
  'linkedin.com': 'linkedin',
  'github.com': 'github',
  'x.com': 'x',
  'twitter.com': 'x',
  'huggingface.co': 'huggingface',
};

/** A label within `LABEL_LENGTH`: whole, or its first characters and "…". */
function short(label: string): string {
  const points = [...label];
  return points.length <= LABEL_LENGTH ? label : `${points.slice(0, LABEL_LENGTH - 1).join('')}…`;
}

const decoded = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

interface Address {
  /** The url, `https://` always: an `http://` one upgraded. */
  url: string;
  brand: LinkBrand;
  /** The path's parts, decoded, the empty ones left out. */
  parts: string[];
  /** The address without its scheme and "www.", a query, a fragment or a trailing slash. */
  site: string;
}

/** A link's address as a button reads it, or none when it is not an http(s) address with a host. */
function addressOf(url: string): Address | undefined {
  const upgraded = url.trim().replace(/^https?:\/\//iu, 'https://');
  if (!upgraded.startsWith('https://') || !URL.canParse(upgraded)) return undefined;
  const parsed = new URL(upgraded);
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
  if (host === '') return undefined;
  const known = Object.keys(BRANDS).find((site) => host === site || host.endsWith(`.${site}`));
  const parts = parsed.pathname
    .split('/')
    .filter((part) => part !== '')
    .map(decoded);
  return {
    url: upgraded,
    brand: known === undefined ? 'site' : BRANDS[known]!,
    parts,
    site: [host, ...parts].join('/'),
  };
}

/** The username a profile's address names: linkedin.com/in/{id}; github.com, x.com, twitter.com, huggingface.co/{user}. */
function usernameOf(address: Address): string | undefined {
  const [first, second] = address.parts;
  if (address.brand === 'linkedin') return first === 'in' ? second : undefined;
  return address.brand === 'site' ? undefined : first;
}

/**
 * A Contact link as a button (the owner's item 12): the site's logo by its host, and the username
 * the address names; any other site, or a known one whose address names no user, by its address
 * without "https://" and "www.", within 40 characters.
 */
export function profileButton(url: string): LinksBlock['items'][number] | undefined {
  const address = addressOf(url);
  if (address === undefined) return undefined;
  const label = usernameOf(address) ?? address.site;
  return { label: short(label), url: address.url, brand: address.brand };
}

/** A project's link as a button: by its host, labelled by the path after it ("jane/ledger"). */
export function projectButton(url: string): LinksBlock['items'][number] | undefined {
  const address = addressOf(url);
  if (address === undefined) return undefined;
  const label = address.parts.length === 0 ? address.site : address.parts.join('/');
  return { label: short(label), url: address.url, brand: address.brand };
}

/**
 * `links` blocks of these buttons, the unusable ones left out: one block a platform's eight
 * buttons (`BLOCK_LIMITS.linksItems`), as many blocks as it takes, so no link the resume kept is
 * left off the page.
 */
function links(buttons: readonly (LinksBlock['items'][number] | undefined)[]): EmittedLeaf[] {
  const items = buttons.filter((button) => button !== undefined);
  const size = BLOCK_LIMITS.linksItems;
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => ({
    type: 'links' as const,
    items: items.slice(index * size, (index + 1) * size),
  }));
}

/**
 * The job's reading as people see it: Must-haves, Nice to have, Responsibilities, then Details —
 * Location, Type, Years, Education, Pay, each a row of its label and value.
 */
export function postingBlocks(posting: Posting): EmittedBlock[] {
  const years = posting.minimumYears;
  return [
    ...section('Must-haves', list(each(posting.mustHaves))),
    ...section('Nice to have', list(each(posting.niceToHaves))),
    ...section('Responsibilities', list(each(posting.responsibilities))),
    ...section(
      'Details',
      list([
        ...labelled(CONTACT_WORDS.location, posting.location),
        ...labelled('Type', posting.employmentType),
        ...labelled(
          'Years',
          years === null ? '' : `${years} ${years === 1 ? 'year' : 'years'} or more`,
        ),
        ...labelled('Education', posting.education),
        ...labelled('Pay', posting.pay),
      ]),
    ),
  ];
}

const KIND_WORDS = { must_have: 'Must-have', nice_to_have: 'Nice to have' } as const;

/**
 * A candidate as people see them: one group, "Candidate details", of Contact, Experience,
 * Education, Projects, Certifications, Skills, Languages, then Why this score — each must-have met
 * or missing, each nice-to-have met, and each flag a person should check. v4: Contact is a row
 * per value, its label above it (Name, Email, Phone, Location), then the resume's links as buttons;
 * a project's link is a button too. The exact words are not shown (README, v4).
 */
export function candidateBlocks(resume: Resume, scoring: Scoring, now: Date): EmittedBlock[] {
  const met = (kind: 'must_have' | 'nice_to_have'): ListItem[] =>
    scoring.matches
      .filter((match) => match.kind === kind)
      .map((match) => ({
        title: match.requirement,
        subtitle: `${KIND_WORDS[kind]} · met`,
        ...(match.evidence === '' ? {} : { text: match.evidence }),
      }));
  const sections = [
    ...section(
      'Contact',
      list([
        ...labelled(CONTACT_WORDS.name, resume.name),
        ...labelled(CONTACT_WORDS.email, resume.email),
        ...labelled(CONTACT_WORDS.phone, resume.phone),
        ...labelled(CONTACT_WORDS.location, resume.location),
      ]),
      ...links(resume.links.map((link) => profileButton(link.url))),
    ),
    ...section(
      'Experience',
      list(
        resume.experience.map((role) => ({
          title: joined(role.title, role.company),
          subtitle: periodLine(role, now),
          ...(role.highlights.length === 0 ? {} : { text: role.highlights.join('\n') }),
        })),
      ),
    ),
    ...section(
      'Education',
      list(
        resume.education.map((school) => ({
          title: joined(
            [school.degree, school.field].filter((part) => part !== '').join(' '),
            school.school,
          ),
          ...(school.year === '' ? {} : { subtitle: school.year }),
        })),
      ),
    ),
    ...section(
      'Projects',
      list(
        resume.projects.map((project) => ({
          title: project.name === '' ? 'Project' : project.name,
          ...(project.description === '' ? {} : { text: project.description }),
        })),
      ),
      ...links(
        resume.projects
          .filter((project) => project.url !== '')
          .map((project) => projectButton(project.url)),
      ),
    ),
    ...section(
      'Certifications',
      list(
        resume.certifications.map((certificate) => {
          const issued = joined(certificate.issuer, certificate.year);
          return { title: certificate.name, ...(issued === '' ? {} : { subtitle: issued }) };
        }),
      ),
    ),
    ...section('Skills', list(each(resume.skills))),
    ...section('Languages', list(each(resume.languages))),
    ...section(
      'Why this score',
      list([
        ...met('must_have'),
        ...scoring.gaps
          .filter((gap) => gap.kind === 'must_have')
          .map((gap) => ({ title: gap.requirement, subtitle: 'Must-have · missing' })),
        ...met('nice_to_have'),
        ...scoring.flags.map((flag) => ({ title: flag, subtitle: 'To check' })),
      ]),
    ),
  ];
  return sections.length === 0 ? [] : [{ type: 'group', title: CANDIDATE_GROUP, sections }];
}
