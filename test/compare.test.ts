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

// FIX ROUND 1 — 브리프의 다섯 테스트는 전부 시트 하나(p1)만 쓴다. verifyPart 가
// RULING 8 을 어기고 grids: oracle[sheet] (지금 시트 하나) 로 되돌아가도 아무 것도
// 실패하지 않는다 — 그 퇴행을 실제로 잡는 테스트가 없었다. 이 테스트는 다른 시트를
// 가리키는 실측 수식 모양('p2'!$F$5)을 넣어 그 퇴행에서 실패하게 만든다: grids 가
// p1 하나뿐이면 p2!F5 는 null 이 되어 기대값 1234.5 와 어긋나 mismatch 가 난다.
test('verifyPart: RULING 8 — 다른 시트를 참조하는 수식은 파트 전체 격자(grids)에서 읽는다', () => {
  const db = openDb(':memory:');
  const headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
  const formulas = {
    extmap: {},
    sheets: { p1: { A1: "='p2'!$F$5" } },
  };
  const oracle = { p1: { A1: 1234.5 }, p2: { F5: 1234.5 } };
  const res = verifyPart('partX', formulas, oracle, db, headers, '2025');
  assert.equal(res.length, 1);
  assert.equal(res[0].verdict, 'match');
  assert.equal(res[0].got, 1234.5);
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

// FIX ROUND 1: 보조시트는 대조 지면(res 의 sheet)으로는 절대 나오지 않지만, 다른 지면이
// 참조하는 대상으로는 여전히 값을 낸다 — grids 에는 남아 있어야 한다는 것을 함께 고정한다.
test('verifyPart: 보조시트(_) 는 대조하지 않지만 참조 대상으로는 쓰인다', () => {
  const db = openDb(':memory:');
  const headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
  const formulas = {
    extmap: {},
    sheets: {
      _시계열: { B1: '=C1-1' },
      p1: { A1: '=_시계열!B1' },
    },
  };
  const oracle = { _시계열: { B1: 2024 }, p1: { A1: 2024 } };
  const res = verifyPart('partX', formulas, oracle, db, headers, '2025');
  // 보조시트 자신은 대조 지면이 아니다 — CellResult 를 내지 않는다
  assert.equal(res.filter((r) => r.sheet === '_시계열').length, 0);
  assert.equal(res.length, 1);
  // 하지만 참조 대상으로는 쓰인다 — p1!A1 이 _시계열!B1 을 읽어 match 다
  assert.equal(res[0].sheet, 'p1');
  assert.equal(res[0].verdict, 'match');
  assert.equal(res[0].got, 2024);
});
