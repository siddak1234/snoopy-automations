import { isObject, readJsonCompletion, type JsonObject, type Step } from '@autom8x/automation-sdk';

import { fileFromState, fileIdOf, fileLine, fileState, readFile } from '../file.js';
import { EXTRACT_RESUME, MODELS, SCORE_CANDIDATE, readDocument } from '../prompts.js';
import { postingOf, resumeOf, type Posting, type Resume } from '../reading.js';
import { scoringOf, summaryLine, type Scoring } from '../scoring.js';
import { candidateSections } from '../sections.js';
import { FAILURES, bandOf, plural, stops } from '../words.js';
import { yearsOfExperience } from '../years.js';

/**
 * A candidate's run (the spec's §2 and §6, `pipeline`): the resume received, read by the model,
 * checked to be a resume that could be read, scored against the job's reading — text only, with
 * the years of experience worked out here — and saved as the run's title, score, summary and
 * sections, which the platform ranks on the job's page. Each step's line counts what it found and
 * never quotes the resume.
 */

/** The key a candidate's run input carries the resume under: the manifest's `trigger.input`. */
export const RESUME_FILE_KEY = 'resumeFile';

/** What `save` leaves for the result: the run's title, score, summary and sections. */
export interface Candidate {
  title: string;
  score: number;
  summary: string;
  sections: JsonObject[];
}

/** The steps, on a clock: a current role runs to `now`. */
export function candidateSteps(now: () => Date): Readonly<Record<string, Step>> {
  const receive: Step = async ({ request, platform }) => {
    // The job's reading every candidate is scored against; the platform starts a run only on a
    // job that is ready, so a missing one ends the run before anything is spent.
    if (!isObject(request.item?.reading)) return stops(FAILURES.jobNotRead);
    const id = fileIdOf(request.input, RESUME_FILE_KEY);
    const read = id === undefined ? undefined : await readFile(platform, id);
    if (read === undefined) return stops(FAILURES.resumeUnreadable);
    return {
      outcome: 'ok',
      summary: `Resume received: ${fileLine(read)}`,
      state: { file: fileState(read) },
    };
  };

  const readResume: Step = async ({ state, platform }) => {
    const file = fileFromState(state.file);
    if (file === undefined) return stops(FAILURES.resumeUnreadable);
    const answer = await readDocument(platform, EXTRACT_RESUME, file);
    if (answer === undefined) return stops(FAILURES.resumeUnreadable);
    const { document, resume } = resumeOf(answer);
    return {
      outcome: 'ok',
      summary: `Resume read: ${[
        plural(resume.experience.length, 'role', 'roles'),
        plural(resume.education.length, 'qualification', 'qualifications'),
        plural(resume.skills.length, 'skill', 'skills'),
      ].join(', ')}`,
      state: { document, resume: resume as unknown as JsonObject },
    };
  };

  const checkResume: Step = ({ state }) => {
    if (state.document === 'not_a_resume') return Promise.resolve(stops(FAILURES.notAResume));
    if (state.document !== 'resume') return Promise.resolve(stops(FAILURES.resumeUnreadable));
    return Promise.resolve({ outcome: 'ok', summary: 'It is a resume, and it could be read' });
  };

  const score: Step = async ({ request, state, platform }) => {
    const posting = postingOf(request.item?.reading ?? {}).posting;
    const resume = state.resume as unknown as Resume;
    const years = yearsOfExperience(resume.experience, now());
    // Text only, and not the candidate's name or contact details: nothing the score should follow.
    const { name: _name, email: _email, phone: _phone, links: _links, ...shown } = resume;
    const completion = await platform.callModel(
      SCORE_CANDIDATE,
      {
        posting: posting as unknown as JsonObject,
        resume: shown as unknown as JsonObject,
        yearsOfExperience: years,
      },
      MODELS,
    );
    const scoring = scoringOf(readJsonCompletion(completion), years);
    return {
      outcome: 'ok',
      summary: `Scored ${scoring.score}: ${bandOf(scoring.score)}`,
      state: { ...state, yearsOfExperience: years, scoring: scoring as unknown as JsonObject },
    };
  };

  const save: Step = ({ request, state }) => {
    const resume = state.resume as unknown as Resume;
    const scoring = state.scoring as unknown as Scoring;
    const posting: Posting = postingOf(request.item?.reading ?? {}).posting;
    const candidate: Candidate = {
      title: resume.name === '' ? 'Unnamed candidate' : resume.name,
      score: scoring.score,
      summary: summaryLine(scoring, posting),
      sections: candidateSections(resume, scoring, now()) as unknown as JsonObject[],
    };
    return Promise.resolve({
      outcome: 'ok',
      summary: `Candidate saved: ${candidate.summary}`,
      state: { ...state, candidate: candidate as unknown as JsonObject },
    });
  };

  return {
    receive,
    'read-resume': readResume,
    'check-resume': checkResume,
    score,
    save,
  };
}
