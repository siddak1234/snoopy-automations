import {
  RUN_SECTION_LIMITS,
  isRunSectionUrl,
  truncateText,
  type JsonObject,
} from '@autom8x/automation-sdk';

import { linkLabel } from './words.js';

/**
 * The two readings, cleaned from the model's answers
 * (`automations/candidate-reviewer/prompts/extract-posting.v1.json`,
 * `automations/candidate-reviewer/prompts/extract-resume.v1.json`): every text one trimmed line
 * within a bound, every list
 * without its empty entries, every number finite or null. The platform holds an answer to its
 * prompt's schema before handing it over; this keeps what the flow sends on — the job's reading
 * held to `items.outputSchema`, the sections a person reads — inside what it can show.
 */

/** The job's reading: the item's `reading`, which every candidate's run is sent. */
export interface Posting {
  title: string;
  department: string;
  location: string;
  employmentType: string;
  summary: string;
  mustHaves: string[];
  niceToHaves: string[];
  responsibilities: string[];
  minimumYears: number | null;
  education: string;
  certifications: string[];
  skills: string[];
  pay: string;
  uncertainFields: string[];
}

export interface Role {
  title: string;
  company: string;
  start: string;
  end: string;
  current: boolean;
  highlights: string[];
}

/** The resume's reading, and what the model said the file is. */
export interface Resume {
  name: string;
  email: string;
  phone: string;
  location: string;
  /** The links the model read, then those only the file links to (`withFileLinks`). */
  links: { url: string; label: string }[];
  summary: string;
  experience: Role[];
  education: { degree: string; field: string; school: string; year: string }[];
  projects: { name: string; description: string; url: string }[];
  certifications: { name: string; issuer: string; year: string }[];
  skills: string[];
  languages: string[];
  uncertainFields: string[];
  /**
   * Text the resume prints that tries to direct its reader — to give a score, to call it a match,
   * to ignore the rules — as the model copied it, never followed: a candidate controls every word
   * of a resume, hidden ones included. The score never judges it (`steps/candidate.ts`) and flags
   * it (`scoring.ts`).
   */
  directions: string[];
}

export type ResumeDocument = 'resume' | 'not_a_resume' | 'unreadable';

/** The most a line is kept to, and the most entries a list is. */
const LINE = 600;
const SHORT = 200;
const LIST = 60;
/**
 * The most links a resume keeps: what Contact shows beside the email, phone and location
 * (`candidateSections`), so the platform's 40 rows a section never cut one.
 */
const LINKS = RUN_SECTION_LIMITS.entries - 3;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A text as one trimmed line, cut whole at `maximum`; empty for anything that is not text. */
export function line(value: unknown, maximum = LINE): string {
  return typeof value === 'string'
    ? truncateText(value.replace(/\s+/gu, ' ').trim(), maximum).trimEnd()
    : '';
}

/** A list of lines, empty ones left out, at most `LIST`. */
export function lines(value: unknown, maximum = LINE): string[] {
  return (Array.isArray(value) ? value : [])
    .map((each) => line(each, maximum))
    .filter((each) => each !== '')
    .slice(0, LIST);
}

/** A list of objects, each cleaned by `clean` and kept when `keep` says. */
function objects<T>(
  value: unknown,
  clean: (item: Record<string, unknown>) => T,
  keep: (item: T) => boolean,
): T[] {
  return (Array.isArray(value) ? value : [])
    .map((each) => clean(record(each)))
    .filter(keep)
    .slice(0, LIST);
}

const anyText = (item: object) => Object.values(item).some((value) => value !== '');

/** The job's reading from `extract-posting`'s answer, and whether the model could read it. */
export function postingOf(answer: JsonObject): { readable: boolean; posting: Posting } {
  const years = answer.minimumYears;
  const posting: Posting = {
    title: line(answer.title, SHORT),
    department: line(answer.department, SHORT),
    location: line(answer.location, SHORT),
    employmentType: line(answer.employmentType, SHORT),
    summary: line(answer.summary, SHORT),
    mustHaves: lines(answer.mustHaves),
    niceToHaves: lines(answer.niceToHaves),
    responsibilities: lines(answer.responsibilities),
    minimumYears:
      typeof years === 'number' && Number.isFinite(years) && years >= 0 && years <= 60
        ? years
        : null,
    education: line(answer.education),
    certifications: lines(answer.certifications),
    skills: lines(answer.skills),
    pay: line(answer.pay, SHORT),
    uncertainFields: lines(answer.uncertainFields, 40),
  };
  // Nothing a candidate could be held to: as unreadable as a blank page, whatever the model said.
  const nothing =
    posting.title === '' &&
    posting.mustHaves.length === 0 &&
    posting.niceToHaves.length === 0 &&
    posting.responsibilities.length === 0 &&
    posting.skills.length === 0;
  return { readable: answer.readable === true && !nothing, posting };
}

/** The resume's reading from `extract-resume`'s answer, and what the file is. */
export function resumeOf(answer: JsonObject): { document: ResumeDocument; resume: Resume } {
  const resume: Resume = {
    name: line(answer.name, 80),
    email: line(answer.email, SHORT),
    phone: line(answer.phone, 80),
    location: line(answer.location, SHORT),
    links: objects(
      answer.links,
      (link) => ({ url: linkUrl(link.url), label: line(link.label, 80) }),
      (link) => link.url !== '',
    ),
    summary: line(answer.summary, SHORT),
    experience: objects(
      answer.experience,
      (role) => ({
        title: line(role.title, SHORT),
        company: line(role.company, SHORT),
        start: line(role.start, 20),
        end: line(role.end, 20),
        current: role.current === true,
        highlights: lines(role.highlights),
      }),
      (role) => role.title !== '' || role.company !== '',
    ),
    education: objects(
      answer.education,
      (school) => ({
        degree: line(school.degree, SHORT),
        field: line(school.field, SHORT),
        school: line(school.school, SHORT),
        year: line(school.year, 20),
      }),
      anyText,
    ),
    projects: objects(
      answer.projects,
      (project) => ({
        name: line(project.name, SHORT),
        description: line(project.description),
        url: linkUrl(project.url),
      }),
      (project) => project.name !== '' || project.description !== '',
    ),
    certifications: objects(
      answer.certifications,
      (certificate) => ({
        name: line(certificate.name, SHORT),
        issuer: line(certificate.issuer, SHORT),
        year: line(certificate.year, 20),
      }),
      (certificate) => certificate.name !== '',
    ),
    skills: lines(answer.skills, SHORT),
    languages: lines(answer.languages, SHORT),
    directions: lines(answer.directions, SHORT),
    uncertainFields: lines(answer.uncertainFields, 40),
  };
  const read =
    resume.name !== '' ||
    resume.experience.length > 0 ||
    resume.education.length > 0 ||
    resume.skills.length > 0 ||
    resume.projects.length > 0 ||
    resume.certifications.length > 0;
  // A resume of which nothing was read is unreadable, whatever the model called it.
  const document: ResumeDocument =
    answer.document === 'not_a_resume'
      ? 'not_a_resume'
      : answer.document === 'resume' && read
        ? 'resume'
        : 'unreadable';
  return { document, resume };
}

/**
 * A web address as a link a person can open: as printed when it starts `http://` or `https://`,
 * with `https://` before a bare address (`linkedin.com/in/jane`), and empty for anything else —
 * a `mailto:`, a `javascript:` — so the run sends only a link the platform keeps.
 */
export function linkUrl(value: unknown): string {
  const text = line(value, 2048).replace(/\s/gu, '');
  if (/^https?:\/\//iu.test(text)) return text;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/iu.test(text)) return `https://${text}`;
  return '';
}

/**
 * The addresses a resume's file links to (`pdf.ts`, `docx.ts`) as links a person can open: each
 * through `linkUrl`, so http and https alone — a `mailto:`, a `javascript:` dropped — and one the
 * platform keeps (`isRunSectionUrl`); one longer than it keeps is left out, never cut to another
 * address; each once, the first seen first, at most `LINKS`.
 */
export function fileLinks(targets: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.length > RUN_SECTION_LIMITS.urlLength) continue;
    const url = linkUrl(target);
    if (url === '' || !isRunSectionUrl(url) || seen.has(sameAddress(url))) continue;
    seen.add(sameAddress(url));
    kept.push(url);
    if (kept.length === LINKS) break;
  }
  return kept;
}

/**
 * The resume's links (the spec's §4): the model's, as it read them, then each address the file
 * links to that the model did not read, named by its site (`linkLabel`); at most `LINKS`. A link
 * already there keeps the model's label. They stay contact details: `scored` never sends them.
 */
export function withFileLinks(links: Resume['links'], targets: readonly string[]): Resume['links'] {
  const read = new Set(links.map((link) => sameAddress(link.url)));
  const added = fileLinks(targets)
    .filter((url) => !read.has(sameAddress(url)))
    .map((url) => ({ url, label: linkLabel(url) }));
  return [...links, ...added].slice(0, LINKS);
}

/**
 * An address as two are compared: `http` and `https` alike, the host in lower case and without a
 * leading `www.`, a trailing slash dropped — a printed `linkedin.com/in/jane` (read as
 * `https://linkedin.com/in/jane`) and a link to `http://www.linkedin.com/in/jane/` are one.
 */
function sameAddress(url: string): string {
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/iu.exec(url);
  if (parts === null) return url;
  const [, scheme = '', host = '', rest = ''] = parts;
  const kind = scheme.toLowerCase().replace(/^https:/u, 'http:');
  return `${kind}${host.toLowerCase().replace(/^www\./u, '')}${rest.replace(/\/$/u, '')}`;
}
