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

const ctx = { extmap: { '1': 'KOSIS_원데이터.xlsx', '2': '별도데이터.xlsx' }, headers };

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

// Task 9 단위 3 — IF 형태 세 갈래. 세 예시 모두 실측 수식이다(지어낸 게 아니다).

// FAMILY 1 (1,076건, 59%): 서식 셀 — part3!p214!O6 실측 수식과 같은 모양
test('FAMILY 1: IF(ISNUMBER(G8),TEXT(G8,"0.0"),"-") 는 if/isnumber/text 트리가 된다', () => {
  const e = parseFormula('=IF(ISNUMBER(G8),TEXT(G8,"0.0"),"-")', ctx);
  assert.deepEqual(e, {
    op: 'if',
    cond: { op: 'isnumber', inner: { op: 'cell', ref: 'G8' } },
    then: { op: 'text', inner: { op: 'cell', ref: 'G8' }, decimals: 1, group: false },
    else: { op: 'str', v: '-' },
  });
});

// FAMILY 1 실측: part3!p214!O6 은 "#,##0" 형식을 쓴다 — 소수 0 자리에 천단위 구분자
// (단위 8 에서 정정: 구분자를 세지 않으면 & 로 이어붙인 지면 문구가 "4205천원" 이 된다)
test('FAMILY 1 실측: part3!p214!O6 — TEXT(G6,"#,##0") 은 소수 0 자리 + 천단위 구분자다', () => {
  const e = parseFormula('=IF(ISNUMBER(G6),TEXT(G6,"#,##0"),"-")', ctx);
  assert.equal(e.op, 'if');
  const thenE = (e as { then: any }).then;
  assert.deepEqual(thenE, { op: 'text', inner: { op: 'cell', ref: 'G6' }, decimals: 0, group: true });
});

test('FAMILY 1: 못 알아보는 TEXT 형식은 형식 문자열을 이유로 남기고 unsupported 다', () => {
  const e = parseFormula('=IF(ISNUMBER(G8),TEXT(G8,"0.0%"),"-")', ctx);
  assert.equal(e.op, 'unsupported');
  assert.match((e as { reason: string }).reason, /0\.0%/);
});

// FAMILY 2 (약 468건): p239 노동생산성 실측 수식 — OECD 행은 평균, 나라 행은 ÷1000.
// 안쪽 IF(SUMIFS(...)=0,"-",SUMIFS(...)/1000) 은 기존 zeroDash 경로를 그대로 탄다.
test('FAMILY 2: $A6="OECD" 조건의 두 갈래 — part3!p239!B6 실측 수식', () => {
  // part3.json 시트 p239 셀 B6 의 실측 수식 그대로 (지어낸 게 아니다)
  const e = parseFormula(
    '=IF($A6="OECD",SUMIFS([2]p239_240!$C:$C,[2]p239_240!$A:$A,B$5)/COUNTIFS([2]p239_240!$A:$A,B$5,[2]p239_240!$C:$C,">0")/1000,' +
    'IF(SUMIFS([2]p239_240!$C:$C,[2]p239_240!$A:$A,B$5,[2]p239_240!$B:$B,$A6)=0,"-",SUMIFS([2]p239_240!$C:$C,[2]p239_240!$A:$A,B$5,[2]p239_240!$B:$B,$A6)/1000))',
    ctx);
  assert.equal(e.op, 'if');
  const cond = (e as { cond: any }).cond;
  assert.deepEqual(cond, { op: 'cmp', rel: 'eq', a: { op: 'cell', ref: 'A6' }, b: { op: 'str', v: 'OECD' } });
  // 참(OECD) 갈래는 평균(÷ COUNTIFS)을 ÷1000 한다
  const thenE = (e as { then: any }).then;
  assert.equal(thenE.op, 'div');
  assert.equal(thenE.a.op, 'div');
  assert.equal(thenE.a.a.op, 'sumifs');
  assert.equal(thenE.a.b.op, 'countifs');
  // 거짓(나라) 갈래는 기존 zeroDash 경로다
  const elseE = (e as { else: any }).else;
  assert.equal(elseE.op, 'zeroDash');
  assert.equal(elseE.inner.op, 'div');
  assert.equal(elseE.inner.a.op, 'sumifs');
});

// FAMILY 3 (54건): 2020 산업분류 개편 경계 규칙 — part1_6!p101!D23 실측 수식 그대로.
test('FAMILY 3: AND(B$21<2020,C$21>=2020) 경계 규칙과 IFERROR 가 실제 트리가 된다', () => {
  const e = parseFormula('=IF(AND(B$21<2020,C$21>=2020),"…",IFERROR((C23-B23)/B23%,"-"))', ctx);
  assert.equal(e.op, 'if');
  const cond = (e as { cond: any }).cond;
  assert.deepEqual(cond, {
    op: 'and',
    args: [
      { op: 'cmp', rel: 'lt', a: { op: 'cell', ref: 'B21' }, b: { op: 'const', v: 2020 } },
      { op: 'cmp', rel: 'gte', a: { op: 'cell', ref: 'C21' }, b: { op: 'const', v: 2020 } },
    ],
  });
  assert.deepEqual((e as { then: any }).then, { op: 'str', v: '…' });
  const elseE = (e as { else: any }).else;
  assert.equal(elseE.op, 'iferror');
  assert.deepEqual(elseE.fallback, { op: 'str', v: '-' });
  assert.equal(elseE.inner.op, 'div');
});

// Task 9 단위 8: 이어붙이기 & — 지면의 연도 씨앗셀 모양
test('& 는 concat 이 되고 산술보다 늦게, 비교보다 먼저 묶인다', () => {
  assert.deepEqual(parseFormula('=(_시계열!$B$1-3)&"년"', ctx), {
    op: 'concat',
    args: [
      { op: 'sub', a: { op: 'cell', sheet: '_시계열', ref: 'B1' }, b: { op: 'const', v: 3 } },
      { op: 'str', v: '년' },
    ],
  });
  // 셋 이상은 평평하게 모인다
  const e = parseFormula('=A1&"년 "&B1&"개월"', ctx);
  assert.equal(e.op, 'concat');
  assert.equal((e as { args: unknown[] }).args.length, 4);
  // 비교보다 먼저 묶인다: (A1&"년") = "2025년"
  const c = parseFormula('=A1&"년"="2025년"', ctx);
  assert.equal(c.op, 'cmp');
  assert.equal((c as { a: { op: string } }).a.op, 'concat');
});
