import type { RunSection, RunSectionEntry } from '@autom8x/automation-sdk';

import type { Posting, Resume } from './reading.js';
import type { Scoring } from './scoring.js';
import { periodLine } from './years.js';

/**
 * What a person opens (the spec's §7): the rows of a candidate's run page, and of a job's "What
 * AI read". Each section in the spec's order, and a section with nothing in it left out; the SDK
 * bounds every row before it is sent (`boundedSections`).
 */

const section = (title: string, entries: RunSectionEntry[]): RunSection[] =>
  entries.length === 0 ? [] : [{ title, entries }];

/** A value with what it is beneath it, or nothing when the value is empty. */
const labelled = (title: string, subtitle: string): RunSectionEntry[] =>
  title === '' ? [] : [{ title, subtitle }];

/** Words joined with " · ", the empty ones left out. */
const joined = (...parts: string[]) => parts.filter((part) => part !== '').join(' · ');

const each = (values: readonly string[]): RunSectionEntry[] => values.map((title) => ({ title }));

/**
 * The job's reading as people see it: Must-haves, Nice to have, Responsibilities, then Details —
 * location, type, years, education, pay.
 */
export function postingSections(posting: Posting): RunSection[] {
  const years = posting.minimumYears;
  return [
    ...section('Must-haves', each(posting.mustHaves)),
    ...section('Nice to have', each(posting.niceToHaves)),
    ...section('Responsibilities', each(posting.responsibilities)),
    ...section('Details', [
      ...labelled(posting.location, 'Location'),
      ...labelled(posting.employmentType, 'Type'),
      ...labelled(
        years === null ? '' : `${years} ${years === 1 ? 'year' : 'years'} or more`,
        'Years',
      ),
      ...labelled(posting.education, 'Education'),
      ...labelled(posting.pay, 'Pay'),
    ]),
  ];
}

const KIND_WORDS = { must_have: 'Must-have', nice_to_have: 'Nice to have' } as const;

/**
 * A candidate as people see them: Contact, Experience, Education, Projects, Certifications,
 * Skills, Languages, then Why this score — each must-have met or missing, each nice-to-have met,
 * and each flag a person should check.
 */
export function candidateSections(resume: Resume, scoring: Scoring, now: Date): RunSection[] {
  const met = (kind: 'must_have' | 'nice_to_have') =>
    scoring.matches
      .filter((match) => match.kind === kind)
      .map((match) => ({
        title: match.requirement,
        subtitle: `${KIND_WORDS[kind]} · met`,
        ...(match.evidence === '' ? {} : { text: match.evidence }),
      }));
  return [
    ...section('Contact', [
      ...labelled(resume.email, 'Email'),
      ...labelled(resume.phone, 'Phone'),
      ...labelled(resume.location, 'Location'),
      ...resume.links.map((link) => ({
        title: link.label === '' ? link.url : link.label,
        subtitle: 'Link',
        url: link.url,
      })),
    ]),
    ...section(
      'Experience',
      resume.experience.map((role) => ({
        title: joined(role.title, role.company),
        subtitle: periodLine(role, now),
        ...(role.highlights.length === 0 ? {} : { text: role.highlights.join('\n') }),
      })),
    ),
    ...section(
      'Education',
      resume.education.map((school) => ({
        title: joined(
          [school.degree, school.field].filter((part) => part !== '').join(' '),
          school.school,
        ),
        ...(school.year === '' ? {} : { subtitle: school.year }),
      })),
    ),
    ...section(
      'Projects',
      resume.projects.map((project) => ({
        title: project.name === '' ? 'Project' : project.name,
        ...(project.description === '' ? {} : { text: project.description }),
        ...(project.url === '' ? {} : { url: project.url }),
      })),
    ),
    ...section(
      'Certifications',
      resume.certifications.map((certificate) => {
        const issued = joined(certificate.issuer, certificate.year);
        return { title: certificate.name, ...(issued === '' ? {} : { subtitle: issued }) };
      }),
    ),
    ...section('Skills', each(resume.skills)),
    ...section('Languages', each(resume.languages)),
    ...section('Why this score', [
      ...met('must_have'),
      ...scoring.gaps
        .filter((gap) => gap.kind === 'must_have')
        .map((gap) => ({ title: gap.requirement, subtitle: 'Must-have · missing' })),
      ...met('nice_to_have'),
      ...scoring.flags.map((flag) => ({ title: flag, subtitle: 'To check' })),
    ]),
  ];
}
