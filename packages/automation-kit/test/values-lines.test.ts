import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LINE_MAXIMUM,
  NAME_ROOM,
  capitalised,
  fitLine,
  fitReasonLine,
} from '../src/values/lines.js';

const name = (text: string) => ({ name: text });

test('a line that fits is the pieces as they are', () => {
  assert.equal(
    fitLine([name('Acme Supplies'), ', INV-1001, $1,250.00']),
    'Acme Supplies, INV-1001, $1,250.00',
  );
  assert.equal(LINE_MAXIMUM, 200);
});

test("a long name is shortened with '…' and the amount stays whole", () => {
  const line = fitLine([name('A'.repeat(500)), ', INV-1001, $1,250.00']);
  assert.equal(line.length, 200);
  assert.ok(line.endsWith('…, INV-1001, $1,250.00'));
});

test('two names share the room, the longer one cut first', () => {
  const line = fitLine(
    [
      'Approve to record this expense and that the company owes ',
      name('J'.repeat(300)),
      ' ',
      name('$45.20'),
    ],
    100,
  );
  assert.equal(line.length, 100);
  assert.ok(line.endsWith(' $45.20'), 'the short name kept whole');
  const both = fitLine([name('A'.repeat(150)), ' paid ', name('B'.repeat(150)), ', $612.40']);
  assert.equal(both.length, 200);
  const [payer, seller] = both.slice(0, -', $612.40'.length).split(' paid ');
  assert.ok(payer!.endsWith('…') && seller!.endsWith('…'));
  assert.ok(Math.abs(payer!.length - seller!.length) <= 1, 'cut to the same length');
});

test('fixed words alone over the bound are cut last, never past it', () => {
  const line = fitLine(['x'.repeat(250), name('Acme')]);
  assert.equal(line.length, 200);
});

test('the decided reason line: the phrases first, the first letter capital, then the ending', () => {
  assert.equal(
    fitReasonLine(
      ['over the $500 limit', 'new vendor'],
      [name('Acme Supplies'), ', INV-1001, $1,250.00'],
    ),
    'Over the $500 limit; new vendor: Acme Supplies, INV-1001, $1,250.00',
  );
  assert.equal(
    fitReasonLine(
      ['Paid personally', 'over the $500 limit'],
      [name('Jane Doe'), ' paid ', name('Office Depot'), ', $612.40'],
    ),
    'Paid personally; over the $500 limit: Jane Doe paid Office Depot, $612.40',
  );
  assert.equal(fitReasonLine([], [name('Acme'), ', $5.00']), 'Acme, $5.00');
  assert.equal(capitalised('new vendor'), 'New vendor');
  assert.equal(capitalised(''), '');
});

test("phrases that leave the names under twelve characters each give way to '+N more'", () => {
  const phrases = Array.from({ length: 12 }, (_, index) => `reason number ${index + 1} is long`);
  const line = fitReasonLine(phrases, [name('Acme Supplies'), ', INV-1001, $1,250.00']);
  assert.ok(line.length <= 200, String(line.length));
  assert.match(line, /; \+\d+ more: /u);
  assert.ok(line.endsWith(', INV-1001, $1,250.00'));
  const kept = line.slice(line.indexOf(': ') + 2, -', INV-1001, $1,250.00'.length);
  assert.ok(kept.length >= Math.min('Acme Supplies'.length, NAME_ROOM), kept);
  // A 500-character name: every phrase that fits stays, the name alone is cut.
  const long = fitReasonLine(
    ['over the $500 limit', 'new vendor'],
    [name('N'.repeat(500)), ', INV-1001, $1,250.00'],
  );
  assert.equal(long.length, 200);
  assert.ok(long.startsWith('Over the $500 limit; new vendor: NNN'));
  assert.ok(long.endsWith('…, INV-1001, $1,250.00'));
});

test('one phrase too long for any room is still kept, and the names cut to fit', () => {
  const line = fitReasonLine(['x'.repeat(190)], [name('Acme Supplies'), ', $5.00']);
  assert.ok(line.length <= 200);
  assert.ok(line.endsWith(', $5.00'));
});
