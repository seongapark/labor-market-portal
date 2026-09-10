import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameValue, verifyPart } from '../src/verify/compare.ts';
import { openDb, loadJsonl } from '../src/db/load.ts';
import type { Headers } from '../src/types.ts';

test('sameValue: 상대오차 1e-9 까지 같다고 본다', () => {
  assert.equal(sameValue(1000, 1000 + 1e-7), true);
  assert.equal(sameValue(1000, 1000.01), false);
  assert.equal(sameValue(0, 0), true);
  assert.equal(sameValue(0, 1e-12), true);
  assert.equal(sameValue('-', '-'), true);
  assert.equal(sameValue('-', 0), false);
  assert.equal(sameValue(null, 5), false);
});

test('verifyPart: 맞는 셀은 match, 틀린 셀은 mismatch', () => {
  const db = openDb(':memory:');
  loadJsonl(db, 'kosis', 'T', [
    JSON.stringify({ PRD_DE: '2025', ITM_NM: '취업자', C1_NM: '계', DT: 120 }),
  ]);
  const headers: Headers = { kosis: { T: ['ITM_NM', 'DT', 'C1_NM', 'PRD_DE'] }, oecd: {}, etc: {}, panel: {} };
  const formulas = {
    extmap: { '1': 'KOSIS_원데이터.xlsx' },
    sheets: {
      p1: {
        B7: '=SUMIFS([1]T!$B:$B,[1]T!$D:$D,TEXT(C$6,"0"),[1]T!$A:$A,"취업자",[1]T!$C:$C,"계")',
        B8: '=SUMIFS([1]T!$B:$B,[1]T!$D:$D,TEXT(C$6,"0"),[1]T!$A:$A,"취업자",[1]T!$C:$C,"계")',
      },
    },
  };
  const oracle = { p1: { C6: 2025, B7: 120, B8: 999 } };
  const res = verifyPart('partX', formulas, oracle, db, headers, '2025');
  const by = Object.fromEntries(res.map((r) => [r.ref, r]));
  assert.equal(by.B7.verdict, 'match');
  assert.equal(by.B8.verdict, 'mismatch');
  assert.equal(by.B8.expected, 999);
  assert.equal(by.B8.got, 120);
});

test('verifyPart: 확정본에 값이 없는 좌표는 no-oracle', () => {
  const db = openDb(':memory:');
  const headers: Headers = { kosis: { T: ['ITM_NM', 'DT'] }, oecd: {}, etc: {}, panel: {} };
  const formulas = { extmap: { '1': 'KOSIS_원데이터.xlsx' },
    sheets: { p1: { Z99: '=SUMIFS([1]T!$B:$B,[1]T!$A:$A,"x")' } } };
  const res = verifyPart('partX', formulas, { p1: {} }, db, headers, '2025');
  assert.equal(res[0].verdict, 'no-oracle');
});

test('verifyPart: 파싱 못한 수식은 unsupported 로 이유가 남는다', () => {
  const db = openDb(':memory:');
  const headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
  const formulas = { extmap: {},
    sheets: { p1: { A1: '=INDEX(_정렬기준!$A$3:$A$41,MATCH(ROW(),_정렬기준!$D$3:$D$41,0))' } } };
  const res = verifyPart('partX', formulas, { p1: { A1: 5 } }, db, headers, '2025');
  assert.equal(res[0].verdict, 'unsupported');
  assert.ok(res[0].reason && res[0].reason.length > 0);
});

test('verifyPart: 보조시트(_) 는 대조하지 않는다', () => {
  const db = openDb(':memory:');
  const headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
  const formulas = { extmap: {}, sheets: { _시계열: { B1: '=C1-1' } } };
  const res = verifyPart('partX', formulas, { _시계열: { B1: 2024 } }, db, headers, '2025');
  assert.equal(res.length, 0);
});
