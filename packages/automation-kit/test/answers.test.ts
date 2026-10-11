import assert from 'node:assert/strict';
import { test } from 'node:test';

import { entityOf, faultOf, nameValueOf, queryRowsOf } from '../src/quickbooks/answers.js';
import { FAULT_MARKER, faultAnswer } from '../src/testing/quickbooks-company.js';

test('a Fault is read at the top or inside QueryResponse, by its numeric code alone', () => {
  assert.equal(faultOf({ CompanyInfo: {} }), undefined);
  assert.equal(faultOf(null), undefined);
  assert.equal(faultOf([faultAnswer('1')]), undefined);
  assert.deepEqual(faultOf(faultAnswer('6000')), { code: '6000' });
  assert.deepEqual(faultOf({ QueryResponse: { Fault: { Error: [{ code: '4001' }] } } }), {
    code: '4001',
  });
  assert.deepEqual(faultOf({ Fault: { Error: [{ code: 2010 }] } }), { code: '2010' });
  // A Fault whose code is not a number is still a Fault; its text is never repeated.
  for (const code of [FAULT_MARKER, '12a', '', 1.5, undefined]) {
    assert.deepEqual(faultOf({ Fault: { Error: [{ code, Message: FAULT_MARKER }] } }), {
      code: undefined,
    });
  }
  assert.deepEqual(faultOf({ Fault: { Error: [] } }), { code: undefined });
  assert.deepEqual(faultOf({ Fault: {} }), { code: undefined });
});

test("a read's entity is an object or nothing", () => {
  assert.deepEqual(entityOf({ CompanyInfo: { CompanyName: 'A' }, time: 't' }, 'CompanyInfo'), {
    CompanyName: 'A',
  });
  assert.equal(entityOf({ CompanyInfo: [] }, 'CompanyInfo'), undefined);
  assert.equal(entityOf({ CompanyInfo: 'A' }, 'CompanyInfo'), undefined);
  assert.equal(entityOf({}, 'CompanyInfo'), undefined);
  assert.equal(entityOf('{"CompanyInfo":{}}', 'CompanyInfo'), undefined);
});

test("a query's rows: none when the array is absent, nothing when there is no QueryResponse", () => {
  const rows = [{ Id: '1' }, { Id: '2' }];
  assert.deepEqual(queryRowsOf({ QueryResponse: { Account: rows } }, 'Account'), rows);
  assert.deepEqual(queryRowsOf({ QueryResponse: {} }, 'Account'), []);
  assert.deepEqual(queryRowsOf({ QueryResponse: { Account: 'x' } }, 'Account'), []);
  assert.deepEqual(
    queryRowsOf({ QueryResponse: { Account: [{ Id: '1' }, 'x', null, []] } }, 'Account'),
    [{ Id: '1' }],
  );
  assert.equal(queryRowsOf({ Account: rows }, 'Account'), undefined);
  assert.equal(
    queryRowsOf({ error: 'the provider returned a response that is not JSON' }, 'Account'),
    undefined,
  );
});

test('a NameValue entry is read by its name, as a string', () => {
  const list = [
    { Name: 'WarnDuplicateCheckNumber', Value: 'true' },
    { Name: 'WarnDuplicateBillNumber', Value: 'false' },
    { Name: 'Number', Value: 3 },
  ];
  assert.equal(nameValueOf(list, 'WarnDuplicateBillNumber'), 'false');
  assert.equal(nameValueOf(list, 'Missing'), undefined);
  assert.equal(nameValueOf(list, 'Number'), undefined);
  assert.equal(
    nameValueOf({ Name: 'WarnDuplicateBillNumber', Value: 'true' }, 'WarnDuplicateBillNumber'),
    undefined,
  );
});
