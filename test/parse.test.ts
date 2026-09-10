import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormula, colName, srcOf } from '../src/cellmap/parse.ts';
import type { Headers } from '../src/types.ts';

const headers: Headers = {
  kosis: {
    DT_1DA7012S: ['C1_OBJ_NM', 'C2_NM', 'DT', 'C2', 'C1', 'ITM_ID', 'ITM_NM', 'PRD_DE', 'C1_NM', 'UNIT_NM', 'C2_OBJ_NM'],
  },
  oecd: { LFS: ['A', 'CTRY', 'SEX', 'AGE', 'ITM', 'PRD_DE', 'DT'] },
  etc: { p239_240: ['PRD_DE', 'CTRY', 'DT'] },
  panel: {},
};

const ctx = { extmap: { '1': 'KOSIS_원데이터.xlsx' }, headers };

test('srcOf: 파일명을 원천 키로 옮긴다', () => {
  assert.equal(srcOf('KOSIS_원데이터.xlsx'), 'kosis');
  assert.equal(srcOf('OECD_원데이터.xlsx'), 'oecd');
  assert.equal(srcOf('별도데이터.xlsx'), 'etc');
  assert.equal(srcOf('2026년 발간 예정 책자_패널데이터_한고원_20260728_f.xlsx'), 'panel');
});

test('colName: 열 문자를 헤더 이름으로 옮긴다', () => {
  assert.equal(colName('kosis', 'DT_1DA7012S', '$C:$C', headers), 'DT');
  assert.equal(colName('kosis', 'DT_1DA7012S', '$H:$H', headers), 'PRD_DE');
  assert.equal(colName('kosis', 'DT_1DA7012S', '$I:$I', headers), 'C1_NM');
  assert.equal(colName('kosis', 'DT_1DA7012S', '$B:$B', headers), 'C2_NM');
});

test('단일 SUMIFS 를 질의로 옮긴다', () => {
  const e = parseFormula(
    '=SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$H:$H,TEXT(C$6,"0"),' +
    '[1]DT_1DA7012S!$I:$I,"계",[1]DT_1DA7012S!$G:$G,"취업자")', ctx);
  assert.equal(e.op, 'sumifs');
  const q = (e as { q: any }).q;
  assert.equal(q.src, 'kosis');
  assert.equal(q.table, 'DT_1DA7012S');
  assert.equal(q.value, 'DT');
  assert.deepEqual(q.where.PRD_DE, { kind: 'year', ref: 'C6' });
  assert.deepEqual(q.where.C1_NM, { kind: 'lit', value: '계' });
  assert.deepEqual(q.where.ITM_NM, { kind: 'lit', value: '취업자' });
});

test('셀 참조 조건은 cell 로 남긴다', () => {
  const e = parseFormula(
    '=SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$B:$B,E$8,[1]DT_1DA7012S!$G:$G,$A14)', ctx);
  const q = (e as { q: any }).q;
  assert.deepEqual(q.where.C2_NM, { kind: 'cell', ref: 'E8' });
  assert.deepEqual(q.where.ITM_NM, { kind: 'cell', ref: 'A14' });
});

test('SUMIFS + SUMIFS 는 add 가 된다', () => {
  const e = parseFormula(
    '=SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$G:$G,"30 - 39세")' +
    '+SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$G:$G,"40 - 49세")', ctx);
  assert.equal(e.op, 'add');
  assert.equal((e as { args: any[] }).args.length, 2);
  assert.equal((e as { args: any[] }).args[0].op, 'sumifs');
});

test('A/(B+C)% — % 는 앞의 괄호에 붙는다 (엑셀 후위 연산자, / 보다 우선)', () => {
  // 엑셀에서 =10/50% 는 10/0.5 = 20 이다. 따라서 M8/(X+Y)% 는 M8/((X+Y)/100) 이고
  // 그것이 곧 백분율(M8*100/(X+Y))이다. pct 가 div 를 감싸는 게 아니라 분모를 감싼다.
  const e = parseFormula(
    '=M8/(SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$G:$G,"30 - 39세")' +
    '+SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$G:$G,"40 - 49세"))%', ctx);
  assert.equal(e.op, 'div');
  assert.deepEqual((e as { a: any }).a, { op: 'cell', ref: 'M8' });
  const b = (e as { b: any }).b;
  assert.equal(b.op, 'pct');
  assert.equal(b.inner.op, 'add');
});

test('단독 SUMIFS 뒤의 % 도 그 SUMIFS 에 붙는다', () => {
  const e = parseFormula(
    '=SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$G:$G,"고용률")%', ctx);
  assert.equal(e.op, 'pct');
  assert.equal((e as { inner: any }).inner.op, 'sumifs');
});

test('IF(SUMIFS(...)=0,"-",SUMIFS(...)) 는 zeroDash 가 된다', () => {
  const e = parseFormula(
    '=IF(SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$G:$G,"취업자")=0,"-",' +
    'SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$G:$G,"취업자"))', ctx);
  assert.equal(e.op, 'zeroDash');
  assert.equal((e as { inner: any }).inner.op, 'sumifs');
});

test('COUNTIFS 는 countifs 가 된다', () => {
  const e = parseFormula(
    '=COUNTIFS([1]DT_1DA7012S!$G:$G,"취업자",[1]DT_1DA7012S!$C:$C,">0")', ctx);
  assert.equal(e.op, 'countifs');
  assert.deepEqual((e as { q: any }).q.where.DT, { kind: 'lit', value: '>0' });
});

// FIX ROUND 1: TEXT(C$6,"0") 은 그 셀에서 연도를 읽어야 하므로 ref 를 함께 남긴다.
// TEXT() 인자가 단일 같은시트 셀 참조가 아닌 형태(실측 8,195건 중 45건)는 무엇을
// 읽어야 할지 알 수 없어 unsupported 로 남긴다 — 추측하지 않는다.
test('FIX ROUND 1: TEXT(셀,"0") 조건은 그 셀을 ref 로 지닌 year 가 된다', () => {
  const e = parseFormula(
    '=SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$H:$H,TEXT($C$6,"0"))', ctx);
  const q = (e as { q: any }).q;
  assert.deepEqual(q.where.PRD_DE, { kind: 'year', ref: 'C6' });
});

test('FIX ROUND 1: TEXT() 인자가 셀 하나가 아니면 unsupported 로 남긴다', () => {
  const e = parseFormula(
    '=SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$H:$H,TEXT(C6+1,"0"))', ctx);
  assert.equal(e.op, 'unsupported');
  assert.match((e as { reason: string }).reason, /TEXT/);
});

test('못 다루는 형태는 unsupported 로 이유를 남긴다', () => {
  const e = parseFormula('=INDEX(_정렬기준!$A$3:$A$41,MATCH(ROW()-6+1,_정렬기준!$D$3:$D$41,0))', ctx);
  assert.equal(e.op, 'unsupported');
  assert.match((e as { reason: string }).reason, /INDEX|MATCH/);
});

// RULING 8: 셀 참조는 시트를 함께 지닌다. parseAtom 은 ext===null 인 ref 를
// 무엇이든(같은 시트·다른 booklet 페이지·보조시트) cell 로 받아야 한다.
// 아래 세 식은 모두 실측 수식이다 (지어낸 게 아니다).

test('RULING 8: 같은 시트 참조는 sheet 없이 cell 로 남는다 — part1_1!p16 C4 실측 수식', () => {
  // data/formulas/part1_1.json 의 시트 p16, 셀 C4 = "=B4"
  const e = parseFormula('=B4', ctx);
  assert.deepEqual(e, { op: 'cell', ref: 'B4' });
});

test("RULING 8: 다른 booklet 페이지 참조는 sheet 를 지닌다 — part1_4(2)!p69/70/71 A5 실측 수식", () => {
  // data/formulas/part1_4(2).json 의 시트 p69·p70·p71, 셀 A5 = "='p68'!$F$5"
  const e = parseFormula("='p68'!$F$5", ctx);
  assert.deepEqual(e, { op: 'cell', sheet: 'p68', ref: 'F5' });
});

test('RULING 8: 보조시트 참조도 sheet 를 지닌다 — part1_1!p8 H29 실측 수식', () => {
  // data/formulas/part1_1.json 의 시트 p8, 셀 H29 = "=_시계열!B1"
  const e = parseFormula('=_시계열!B1', ctx);
  assert.deepEqual(e, { op: 'cell', sheet: '_시계열', ref: 'B1' });
});
