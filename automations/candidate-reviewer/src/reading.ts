import { truncateText, type JsonObject } from '@autom8x/automation-sdk';

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
  links: { url: string; label: string }[];
  summary: string;
  experience: Role[];
  education: { degree: string; field: string; school: string; year: string }[];
  projects: { name: string; description: string; url: string }[];
  certifications: { name: string; issuer: string; year: string }[];
  skills: string[];
  languages: string[];
  uncertainFields: string[];
}

export type ResumeDocument = 'resume' | 'not_a_resume' | 'unreadable';

/** The most a line is kept to, and the most entries a list is. */
const LINE = 600;
const SHORT = 200;
const LIST = 60;

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
