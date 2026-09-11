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

// Task 9 단위 4 (CHANGE 1): 양쪽이 모두 숫자로 읽히면 숫자로 비교한다 — 냉동
// 오라클의 차트 데이터레이블 열이 "84.0"(TEXT 결과 문자열)이 아니라 84(Excel COM 이
// 강제 변환한 숫자)로 얼어 있는 65건이 이 원인이었다. 브리프가 못박은 가드 케이스 전부.
test('sameValue: CHANGE 1 — 양쪽이 숫자로 읽히면 문자열/숫자 표현 차이를 같다고 본다', () => {
  assert.equal(sameValue('-', 0), false);
  assert.equal(sameValue('…', 0), false);
  assert.equal(sameValue(null, 5), false);
  assert.equal(sameValue('계', 0), false);
  assert.equal(sameValue('-', '-'), true);
  assert.equal(sameValue(84, '84.0'), true);
  assert.equal(sameValue(8.5, '8.5'), true);
  assert.equal(sameValue(1000, 1000.01), false);
  assert.equal(sameValue(0, 1e-12), true);
  assert.equal(sameValue('…', '…'), true);
});

// 빈 문자열·공백만 있는 문자열은 숫자로 치지 않는다 — Number('') 가 0 이 되어
// sameValue('', 0) 을 참으로 오판하는 것을 막는다.
test('sameValue: 빈/공백 문자열은 숫자가 아니다', () => {
  assert.equal(sameValue('', 0), false);
  assert.equal(sameValue('   ', 0), false);
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
  // INDEX/MATCH/RANK 가 아닌 함수를 써야 한다 — 그 셋은 이제 외부참조가 없으면
  // presentation 으로 갈라진다(아래 별도 테스트). 여기서는 그 분류와 무관한
  // "그냥 못 다루는 함수"를 확인한다.
  const formulas = { extmap: {},
    sheets: { p1: { A1: '=VLOOKUP(A2,B1:C10,2,0)' } } };
  const res = verifyPart('partX', formulas, { p1: { A1: 5 } }, db, headers, '2025');
  assert.equal(res[0].verdict, 'unsupported');
  assert.ok(res[0].reason && res[0].reason.length > 0);
});

// TASK 9 단위 2 — presentation 판정: OECD 부록의 INDEX/MATCH/RANK 정렬 수식은
// 원천 통합문서를 참조하지 않으면 데이터 대조가 아니라 표현(presentation)이다.
test('verifyPart: INDEX 가 실패하고 외부참조가 없으면 presentation', () => {
  const db = openDb(':memory:');
  const headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
  // 같은시트 범위(RANK 류)와 보조시트(_정렬기준) 참조 둘 다 "외부참조 없음"에 해당한다.
  const formulas = { extmap: {},
    sheets: { p1: { A1: '=INDEX(_정렬기준!$A$3:$A$41,MATCH(ROW(),_정렬기준!$D$3:$D$41,0))' } } };
  const res = verifyPart('partX', formulas, { p1: { A1: 5 } }, db, headers, '2025');
  assert.equal(res[0].verdict, 'presentation');
  assert.ok(res[0].reason && res[0].reason.length > 0);
  assert.equal(res[0].got, null);
  assert.equal(res[0].expected, 5);
});

// 이 테스트가 없으면 분류기가 "외부참조가 있는지"를 실제로 확인하지 않고도
// 통과할 수 있다 — INDEX 를 쓰면 무조건 presentation 으로 삼키는 회귀를 잡는다.
test('verifyPart: INDEX 가 실패해도 외부통합문서 참조가 있으면 unsupported (presentation 아님)', () => {
  const db = openDb(':memory:');
  const headers: Headers = { kosis: { T: ['ITM_NM', 'DT'] }, oecd: {}, etc: {}, panel: {} };
  const formulas = { extmap: { '1': 'KOSIS_원데이터.xlsx' },
    sheets: { p1: { A1: '=INDEX([1]T!$A:$A,1)' } } };
  const res = verifyPart('partX', formulas, { p1: { A1: 5 } }, db, headers, '2025');
  assert.equal(res[0].verdict, 'unsupported');
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

// Task 9 단위 8: TEXT(x,"#,##0") 의 결과 "211,983" 과, 그것을 숫자로 강제 변환해 담은
// 오라클 211983 은 같은 값이다. 구분자 모양이 정확할 때만 벗긴다.
test('sameValue: 천단위 구분자가 찍힌 숫자 문자열을 숫자로 읽는다', () => {
  assert.equal(sameValue('211,983', 211983), true);
  assert.equal(sameValue(1234.5, '1,234.5'), true);
  assert.equal(sameValue('1,2', 12), false);
  assert.equal(sameValue('12,34', 1234), false);
  assert.equal(sameValue('4,205천원', 4205), false);
});
