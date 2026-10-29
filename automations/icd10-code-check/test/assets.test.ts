import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  formatted,
  layoutFrom,
  readOrderFile,
  tabularNotes,
  unzip,
  withDot,
} from '../scripts/order-file.js';
import { inFamily } from '../src/families.js';
import { DOCUMENTATION, line } from './order-lines.js';

/**
 * `automations/icd10-code-check/scripts/build-assets.ts`'s reading of the official files, on made-up ones: the layout read from
 * the documentation and every refusal, the tabular notes, the ZIP reader and the JSON it writes.
 */

const layout = layoutFrom(DOCUMENTATION);

test("the layout is the documentation's own table", () => {
  assert.deepEqual(layout, {
    order: { position: 1, length: 5 },
    code: { position: 7, length: 7 },
    flag: { position: 15, length: 1 },
    short: { position: 17, length: 60 },
    long: { position: 78 },
    blanks: [
      { position: 6, length: 1 },
      { position: 14, length: 1 },
      { position: 16, length: 1 },
      { position: 77, length: 1 },
    ],
    maxLine: 400,
  });
  assert.throws(() => layoutFrom('no table here'), /no "Position Length Contents" table/u);
  assert.throws(
    () => layoutFrom(DOCUMENTATION.replace('1 if the code is valid', 'one marks')),
    /which flag/u,
  );
  assert.throws(
    () => layoutFrom(DOCUMENTATION.replace('never longer than 400', 'short')),
    /longest line/u,
  );
});

test('an order file is refused at its first line off the layout, by number', () => {
  const ok = [
    line(1, 'N18', '0', 'CKD'),
    line(2, 'N1831', '1', 'Chronic kidney disease, stage 3a'),
  ];
  assert.deepEqual(readOrderFile(`${ok.join('\r\n')}\r\n`, layout, 'f'), {
    'N18.31': 'Chronic kidney disease, stage 3a',
  });
  const refusals: [string, RegExp][] = [
    [line(2, 'N1831', '1', 'x').replace('00002', '0000x'), /line 2 .*order number/u],
    [line(1, 'N1831', '1', 'x'), /order numbers out of order/u],
    [line(2, 'N1831', '1', 'x').replace(/^(.{5})./u, '$1X'), /a blank/u],
    [line(2, 'n1831', '1', 'x'), /code/u],
    [`${line(2, 'N1831', '1', 'x')}${'y'.repeat(400)}`, /longer than 400/u],
    [line(2, 'N1831', '1', ' '), /description/u],
  ];
  for (const [bad, reason] of refusals)
    assert.throws(() => readOrderFile(`${ok[0]}\n${bad}`, layout, 'f'), reason);
  assert.throws(() => readOrderFile('', layout, 'f'), /holds no line/u);
});

test('the tabular notes: code first and use additional, a heading before its items, only the families kept', () => {
  const xml = `<chapter><name>14</name><section><diag><name>N18</name><desc>CKD</desc>
    <codeFirst><note>any associated:</note><note>diabetic chronic kidney disease (E08.22, E11.22)</note></codeFirst>
    <useAdditionalCode><note>code to identify kidney transplant status (Z94.0)</note></useAdditionalCode>
    <excludes1><note>not this (Q61.-)</note></excludes1>
    <diag><name>N18.6</name><desc>ESRD</desc><useAdditionalCode><note>code to identify dialysis status (Z99.2)</note></useAdditionalCode></diag>
    </diag><diag><name>J45</name><useAdditionalCode><note>code to identify exposure (Z77.22)</note></useAdditionalCode></diag></section></chapter>`;
  assert.deepEqual(
    tabularNotes(xml, (code) => inFamily(code, ['N00-N29'])),
    {
      N18: [
        {
          kind: 'Code first',
          note: 'any associated: diabetic chronic kidney disease (E08.22, E11.22)',
        },
        { kind: 'Use additional', note: 'code to identify kidney transplant status (Z94.0)' },
      ],
      'N18.6': [{ kind: 'Use additional', note: 'code to identify dialysis status (Z99.2)' }],
    },
  );
});

test('a ZIP is read on Node alone, deflated and stored; anything else refused', () => {
  const entry = (name: string, body: Buffer, method: 0 | 8) => ({
    name: Buffer.from(name),
    body,
    data: method === 8 ? deflateRawSync(body) : body,
    method,
  });
  const files = [
    entry('Code Descriptions/a.txt', Buffer.from('hello hello hello'), 8),
    entry('b.txt', Buffer.from('plain'), 0),
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.method, 8);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt16LE(f.name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.method, 10);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt16LE(f.name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, f.name, f.data);
    centrals.push(central, f.name);
    offset += 30 + f.name.length + f.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(offset, 16);
  const read = unzip(Buffer.concat([...locals, directory, end]));
  assert.equal(read.get('Code Descriptions/a.txt')?.toString(), 'hello hello hello');
  assert.equal(read.get('b.txt')?.toString(), 'plain');
  assert.throws(() => unzip(Buffer.from('not a zip')), /no central directory/u);
});

test('a code takes its dot after the category; the JSON is written as the formatter writes it', () => {
  assert.equal(withDot('N1831'), 'N18.31');
  assert.equal(withDot('I10'), 'I10');
  assert.equal(
    formatted({ a: [{ b: ['x', 'y'] }] }),
    '{\n  "a": [\n    {\n      "b": ["x", "y"]\n    }\n  ]\n}\n',
  );
});
