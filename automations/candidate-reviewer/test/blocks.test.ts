import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boundedBlocks, type EmittedBlock } from '@autom8x/automation-sdk';

import {
  CANDIDATE_GROUP,
  candidateBlocks,
  postingBlocks,
  profileButton,
  projectButton,
} from '../src/blocks.js';
import { postingOf, resumeOf } from '../src/reading.js';
import { scoringOf } from '../src/scoring.js';
import { NOW, postingAnswer, resumeAnswer, scoreAnswer } from './fixtures.js';

/**
 * v4's blocks (the owner's items 11–13 on build 37, 2026-11-05): a candidate as one group of
 * sections, Contact a row per value under its label then its links as logo buttons named by the
 * username, a project's link a button named by its path; a job's four sections, Details the same
 * layout; nothing the SDK would change on the way out.
 */

const candidate = (overrides = {}) =>
  candidateBlocks(resumeOf(resumeAnswer(overrides)).resume, scoringOf(scoreAnswer(70), 5, []), NOW);

test('a candidate is one group, "Candidate details", its sections in order; no top-level metric or badge', () => {
  const blocks = candidate();
  assert.equal(blocks.length, 1);
  const [group] = blocks;
  assert.equal(group?.type, 'group');
  assert.equal(CANDIDATE_GROUP, 'Candidate details');
  assert.ok(group?.type === 'group' && group.title === CANDIDATE_GROUP);
  assert.deepEqual(
    group.sections.map((section) => section.title),
    [
      'Contact',
      'Experience',
      'Education',
      'Projects',
      'Certifications',
      'Skills',
      'Languages',
      'Why this score',
    ],
  );
  assert.ok(blocks.every((block) => block.type !== 'metric' && block.type !== 'badge'));
  // What the SDK sends is what was built: nothing cut, nothing left out.
  assert.deepEqual(boundedBlocks(blocks), blocks);
});

test('a section with nothing in it is left out; a Contact with no value but a link keeps its links alone', () => {
  const [group] = candidate({
    name: '',
    email: '',
    phone: '',
    location: '',
    links: [{ url: 'https://github.com/example', label: 'GitHub' }],
    experience: [],
    education: [],
    projects: [],
    certifications: [],
    skills: [],
    languages: [],
  });
  assert.ok(group?.type === 'group');
  assert.deepEqual(
    group.sections.map((section) => [section.title, section.blocks.map((block) => block.type)]),
    [
      ['Contact', ['links']],
      ['Why this score', ['list']],
    ],
  );
});

test('Contact: each value a row, its label the title and the value the text; an empty value left out', () => {
  const [group] = candidate({ phone: '', links: [] });
  assert.ok(group?.type === 'group');
  assert.deepEqual(group.sections[0], {
    type: 'section',
    title: 'Contact',
    blocks: [
      {
        type: 'list',
        items: [
          { title: 'Name', text: 'Jane Doe' },
          { title: 'Email', text: 'jane.doe@example.com' },
          { title: 'Location', text: 'Austin, TX' },
        ],
      },
    ],
  });
});

test('a profile button: the logo by its host, the username its address names, http made https', () => {
  const cases: [string, string, string, string][] = [
    [
      'http://www.linkedin.com/in/jane-doe/',
      'jane-doe',
      'https://www.linkedin.com/in/jane-doe/',
      'linkedin',
    ],
    ['https://uk.linkedin.com/in/jane', 'jane', 'https://uk.linkedin.com/in/jane', 'linkedin'],
    [
      'https://github.com/AkulAggarwal2',
      'AkulAggarwal2',
      'https://github.com/AkulAggarwal2',
      'github',
    ],
    ['HTTP://x.com/jane_doe?s=21', 'jane_doe', 'https://x.com/jane_doe?s=21', 'x'],
    ['https://twitter.com/janedoe', 'janedoe', 'https://twitter.com/janedoe', 'x'],
    ['https://huggingface.co/jane', 'jane', 'https://huggingface.co/jane', 'huggingface'],
  ];
  for (const [url, label, https, brand] of cases) {
    assert.deepEqual(profileButton(url), { label, url: https, brand }, url);
  }
});

test('another site, or a named one whose address names no user: the address without scheme and www., at most 40', () => {
  assert.deepEqual(profileButton('http://www.janedoe.example.com/'), {
    label: 'janedoe.example.com',
    url: 'https://www.janedoe.example.com/',
    brand: 'site',
  });
  assert.deepEqual(profileButton('https://www.linkedin.com/company/acme'), {
    label: 'linkedin.com/company/acme',
    url: 'https://www.linkedin.com/company/acme',
    brand: 'linkedin',
  });
  assert.equal(profileButton('https://github.com/')?.label, 'github.com');
  const long = profileButton(`https://example.com/${'a'.repeat(60)}`);
  // At most 40 characters: the address's first 39 and "…" (the platform's word is 40).
  assert.equal(long?.label, `example.com/${'a'.repeat(27)}…`);
  assert.equal(long?.label.length, 40);
  assert.equal(profileButton('mailto:jane@example.com'), undefined);
  assert.equal(profileButton('https://'), undefined);
});

test('a label is measured as the platform measures it, in UTF-16 units: an emoji counts two, never split', () => {
  // 40 characters but 42 units: cut to the characters within 39 units and "…", not sent whole.
  const forty = profileButton(`https://example.com/${'a'.repeat(26)}🚀🚀`);
  assert.equal(forty?.label, `example.com/${'a'.repeat(26)}…`);
  // An emoji that would straddle the 39th unit is left out whole, no half of it sent.
  const rockets = profileButton(`https://example.com/${'🚀'.repeat(30)}`);
  assert.equal(rockets?.label, `example.com/${'🚀'.repeat(13)}…`);
  for (const button of [forty!, rockets!]) {
    assert.ok(button.label.length <= 40, button.label);
    // The SDK's bound leaves it as built: its "…" stays the last thing shown.
    const blocks: EmittedBlock[] = [{ type: 'links', items: [button] }];
    assert.deepEqual(boundedBlocks(blocks), blocks);
  }
});

test('a project link: a button by its host, named by the path after it', () => {
  assert.deepEqual(projectButton('http://github.com/AkulAggarwal2/repo'), {
    label: 'AkulAggarwal2/repo',
    url: 'https://github.com/AkulAggarwal2/repo',
    brand: 'github',
  });
  assert.equal(projectButton('https://ledger.example.com/')?.label, 'ledger.example.com');
  const [group] = candidate({
    projects: [
      { name: 'Ledger', description: 'A ledger.', url: 'https://github.com/jane/ledger' },
      { name: 'Notes', description: '', url: '' },
    ],
  });
  assert.ok(group?.type === 'group');
  assert.deepEqual(group.sections.find((section) => section.title === 'Projects')?.blocks, [
    {
      type: 'list',
      items: [{ title: 'Ledger', text: 'A ledger.' }, { title: 'Notes' }],
    },
    {
      type: 'links',
      items: [{ label: 'jane/ledger', url: 'https://github.com/jane/ledger', brand: 'github' }],
    },
  ]);
});

test("a job's blocks: Must-haves, Nice to have, Responsibilities, then Details as label and value rows", () => {
  const blocks: EmittedBlock[] = postingBlocks(postingOf(postingAnswer()).posting);
  assert.deepEqual(
    blocks.map((block) => [block.type, 'title' in block ? block.title : '']),
    [
      ['section', 'Must-haves'],
      ['section', 'Nice to have'],
      ['section', 'Responsibilities'],
      ['section', 'Details'],
    ],
  );
  assert.deepEqual(blocks.at(-1), {
    type: 'section',
    title: 'Details',
    blocks: [
      {
        type: 'list',
        items: [
          { title: 'Location', text: 'Austin, TX (hybrid)' },
          { title: 'Type', text: 'Full-time' },
          { title: 'Years', text: '5 years or more' },
          { title: 'Education', text: "Bachelor's degree in accounting" },
          { title: 'Pay', text: '$85,000–$100,000 a year' },
        ],
      },
    ],
  });
  assert.deepEqual(boundedBlocks(blocks), blocks);
});
