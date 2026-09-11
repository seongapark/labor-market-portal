import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, loadJsonl, loadOecdJsonl } from '../src/db/load.ts';
import { execute } from '../src/query/execute.ts';
import type { Expr, Grid } from '../src/types.ts';

function fixture() {
  const db = openDb(':memory:');
  loadJsonl(db, 'kosis', 'T', [
    JSON.stringify({ PRD_DE: '2024', ITM_NM: '취업자', C1_NM: '계', C2_NM: '계', DT: 100 }),
    JSON.stringify({ PRD_DE: '2025', ITM_NM: '취업자', C1_NM: '계', C2_NM: '계', DT: 120 }),
    JSON.stringify({ PRD_DE: '2025', ITM_NM: '취업자', C1_NM: '남자', C2_NM: '계', DT: 70 }),
    JSON.stringify({ PRD_DE: '2025', ITM_NM: '실업자', C1_NM: '계', C2_NM: '계', DT: 5 }),
  ]);
  return db;
}

const grid: Grid = { A14: '취업자', B6: 2024, C6: 2025, M8: 60 };

// RULING 8: ExecCtx 는 { db, grids, sheet, year } 다 — brief 가 쓴 { db, grid, year } 가 아니다.
// 값에 대한 기대는 그대로 두고 컨텍스트 모양만 옮긴다.

test('sumifs: 조건에 맞는 dt 를 합한다', () => {
  const db = fixture();
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', e: { op: 'cell', ref: 'C6' } }, ITM_NM: { kind: 'lit', value: '취업자' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), 190);   // 120 + 70
});

test('sumifs: cell 조건은 격자에서 값을 읽는다', () => {
  const db = fixture();
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', e: { op: 'cell', ref: 'C6' } }, ITM_NM: { kind: 'cell', ref: 'A14' },
             C1_NM: { kind: 'lit', value: '계' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), 120);
});

test('countifs: 개수를 센다', () => {
  const db = fixture();
  const e: Expr = { op: 'countifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'lit', value: '2025' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), 3);
});

test('countifs: ">0" 같은 비교 조건을 다룬다', () => {
  const db = fixture();
  const e: Expr = { op: 'countifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'lit', value: '2025' }, DT: { kind: 'lit', value: '>60' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), 2);   // 120, 70
});

test('add · div · pct 를 계산한다 — % 는 분모에 붙는다', () => {
  const db = fixture();
  const one = (itm: string): Expr => ({ op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', e: { op: 'cell', ref: 'C6' } }, ITM_NM: { kind: 'lit', value: itm },
             C1_NM: { kind: 'lit', value: '계' } } } });
  // 엑셀 =M8/(취업자+실업자)% → 60 / ((120+5)/100) = 48. 이것이 백분율이다.
  // RULING 1: % 는 ÷100 이다 (×100 이 아니다) — 이 기대값을 바꾸면 안 된다.
  const e: Expr = { op: 'div', a: { op: 'cell', ref: 'M8' },
    b: { op: 'pct', inner: { op: 'add', args: [one('취업자'), one('실업자')] } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), 48);
});

test('pct 단독은 ÷100 이다', () => {
  const db = fixture();
  assert.equal(execute({ op: 'pct', inner: { op: 'const', v: 50 } },
    { db, grids: { p1: grid }, sheet: 'p1' }), 0.5);
});

test('zeroDash: 0 이면 문자열 "-" 를 낸다', () => {
  const db = fixture();
  const e: Expr = { op: 'zeroDash', inner: { op: 'sumifs',
    q: { src: 'kosis', table: 'T', value: 'DT',
         where: { ITM_NM: { kind: 'lit', value: '없는항목' } } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), '-');
});

test('zeroDash: 0 이 아니면 값을 낸다', () => {
  const db = fixture();
  const e: Expr = { op: 'zeroDash', inner: { op: 'sumifs',
    q: { src: 'kosis', table: 'T', value: 'DT',
         where: { PRD_DE: { kind: 'year', e: { op: 'cell', ref: 'C6' } }, ITM_NM: { kind: 'lit', value: '실업자' } } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), 5);
});

test('unsupported 는 null 이다', () => {
  const db = fixture();
  assert.equal(execute({ op: 'unsupported', reason: 'x', formula: 'y' },
    { db, grids: { p1: grid }, sheet: 'p1' }), null);
});

// --- 브리프 이후 추가한 테스트 ---

test('sumifs: OECD 는 oecd_obs 를 조회하고 모든 식별자를 큰따옴표로 인용한다', () => {
  const db = openDb(':memory:');
  loadOecdJsonl(db, 'LFS', [
    JSON.stringify({ REF_AREA: 'KOR', 국가명: '한국', TIME_PERIOD: '2024', value: 10 }),
    JSON.stringify({ REF_AREA: 'KOR', 국가명: '한국', TIME_PERIOD: '2025', value: 20 }),
    JSON.stringify({ REF_AREA: 'JPN', 국가명: '일본', TIME_PERIOD: '2025', value: 999 }),
  ]);
  const e: Expr = { op: 'sumifs', q: { src: 'oecd', table: 'LFS', value: 'value',
    where: { 국가명: { kind: 'lit', value: '한국' }, TIME_PERIOD: { kind: 'lit', value: '2025' } } } };
  // 인용을 빼면 "국가명" 은 파싱 자체가 안 되고 value 는 예약어와 부딪혀 던진다 — 이 테스트가 그걸 증명한다.
  assert.equal(execute(e, { db, grids: {}, sheet: 'p1' }), 20);
});

test('cell: sheet 를 명시하면 다른 시트의 격자에서 읽는다', () => {
  const db = fixture();
  const other: Grid = { F5: 777 };
  const e: Expr = { op: 'cell', sheet: 'p68', ref: 'F5' };
  assert.equal(execute(e, { db, grids: { p1: grid, p68: other }, sheet: 'p1' }), 777);
});

test('cell: sheet 가 없으면 지금 시트(ctx.sheet)의 격자에서 읽는다', () => {
  const db = fixture();
  const e: Expr = { op: 'cell', ref: 'A14' };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), '취업자');
});

test('cell: 시트가 없으면 던지지 않고 null 이다', () => {
  const db = fixture();
  const e: Expr = { op: 'cell', sheet: '없는시트', ref: 'A1' };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), null);
});

test('cell: 셀이 없으면 던지지 않고 null 이다', () => {
  const db = fixture();
  const e: Expr = { op: 'cell', ref: 'Z99' };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), null);
});

// FIX ROUND 1 — 이 테스트가 있었으면 p42 스팟체크의 결함(모든 연도 열이 ctx.year 하나로
// 뭉개져 68/90 이 불일치)을 미리 잡았을 것이다: 같은 시트 안에서 연도 조건이 가리키는
// 셀이 다르면(B6=2024, C6=2025) 서로 다른 해의 값을 내야 하고, 같은 ctx.year 로도 똑같이
// 유지되어야 한다.
test('FIX ROUND 1: 연도 조건은 자신이 가리키는 셀에서 읽는다 — 열마다 다른 연도가 다른 값을 낸다', () => {
  const db = fixture();
  const sumOf = (yearRef: string): Expr => ({ op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', e: { op: 'cell', ref: yearRef } }, ITM_NM: { kind: 'lit', value: '취업자' },
             C1_NM: { kind: 'lit', value: '계' } } } });
  const ctx = { db, grids: { p1: grid }, sheet: 'p1' };
  assert.equal(execute(sumOf('B6'), ctx), 100);   // B6 → 2024 의 취업자 계
  assert.equal(execute(sumOf('C6'), ctx), 120);   // C6 → 2025 의 취업자 계 (같은 ctx.year 아래에서도 다르다)
});

// RULING 10: gridCell 은 "키가 없다"와 "값이 명시적으로 null 이다"를 구별하지 못한다 —
// 예비값으로 ctx.year 를 돌려주면 빈 칸·병합된 연도머리글이 조용히 기준연도의 답을 받고
// 대조에서 드러나지 않는다. 이제는 던진다 (이전엔 ctx.year 로 대체했다 — FIX ROUND 1).
test('RULING 10: 연도 조건 셀이 격자에 없으면 대체하지 않고 던진다', () => {
  const db = fixture();
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', e: { op: 'cell', ref: 'Z99' } }, ITM_NM: { kind: 'lit', value: '실업자' } } } };
  assert.throws(
    () => execute(e, { db, grids: { p1: grid }, sheet: 'p1' }),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /연도 조건 셀이 격자에 없다/);
      assert.match(msg, /p1!Z99/);
      return true;
    }
  );
});

// FIX(대조 9-1): 엑셀 SUMIFS 텍스트 기준 비교는 대소문자를 구별하지 않는다.
// p214!C3 헬퍼셀은 'pop' 소문자인데 OECD API 는 'POP' 대문자로 돌려준다 — 엑셀은
// 같다고 보고 합산하지만 대소문자 구별 SQL '=' 는 0 을 낸다(→ '-'). COLLATE NOCASE 로 고쳤다.
test('sumifs: OECD 텍스트 기준은 대소문자를 구별하지 않는다 (소문자 기준이 대문자 저장값과 합산된다)', () => {
  const db = openDb(':memory:');
  loadOecdJsonl(db, 'LFS', [
    JSON.stringify({ REF_AREA: 'KOR', 국가명: '한국', LABOUR_FORCE_STATUS: 'POP', TIME_PERIOD: '2025', value: 205720 }),
    JSON.stringify({ REF_AREA: 'KOR', 국가명: '한국', LABOUR_FORCE_STATUS: 'LF', TIME_PERIOD: '2025', value: 999 }),
  ]);
  const e: Expr = { op: 'sumifs', q: { src: 'oecd', table: 'LFS', value: 'value',
    where: { LABOUR_FORCE_STATUS: { kind: 'lit', value: 'pop' }, TIME_PERIOD: { kind: 'lit', value: '2025' } } } };
  assert.equal(execute(e, { db, grids: {}, sheet: 'p1' }), 205720);
});

// 회귀 확인: COLLATE NOCASE 는 ASCII A~Z 만 접는다 — 한글 기준값에는 영향이 없어야
// 하고, 애초에 대소문자 구별이 무의미한 한글에서 매칭이 깨지지 않아야 한다.
test('sumifs: KOSIS 형 한글 기준은 COLLATE NOCASE 를 붙여도 그대로 매칭된다', () => {
  const db = fixture();
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'lit', value: '2025' }, ITM_NM: { kind: 'lit', value: '취업자' },
             C1_NM: { kind: 'lit', value: '계' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), 120);
});

// --- Task 9 단위 3: IF 형태 세 갈래 (parse.test.ts 와 같은 실측 수식) ---

import { parseFormula } from '../src/cellmap/parse.ts';
import type { Headers } from '../src/types.ts';

const if3Headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
const if3Ctx = { extmap: {}, headers: if3Headers };

test('FAMILY 1: IF(ISNUMBER(G8),TEXT(G8,"0.0"),"-") — 셀이 숫자면 반올림한 문자열을 낸다', () => {
  const db = fixture();
  const e = parseFormula('=IF(ISNUMBER(G8),TEXT(G8,"0.0"),"-")', if3Ctx);
  const grids: Record<string, Grid> = { p1: { G8: 8.46 } };
  assert.equal(execute(e, { db, grids, sheet: 'p1' }), '8.5');
});

test('FAMILY 1: G8 이 문자열이면 ISNUMBER 가 거짓이라 "-" 를 낸다', () => {
  const db = fixture();
  const e = parseFormula('=IF(ISNUMBER(G8),TEXT(G8,"0.0"),"-")', if3Ctx);
  const grids: Record<string, Grid> = { p1: { G8: '해당없음' } };
  assert.equal(execute(e, { db, grids, sheet: 'p1' }), '-');
});

test('FAMILY 1: G8 셀이 아예 없으면(null) "-" 를 낸다', () => {
  const db = fixture();
  const e = parseFormula('=IF(ISNUMBER(G8),TEXT(G8,"0.0"),"-")', if3Ctx);
  const grids: Record<string, Grid> = { p1: {} };
  assert.equal(execute(e, { db, grids, sheet: 'p1' }), '-');
});

test('FAMILY 2: $A6="OECD" 이면 평균(÷COUNTIFS) 갈래, 나라 행이면 ÷1000 갈래를 탄다 — 한 fixture 로 양쪽 다 확인', () => {
  // part3.json 시트 p239 셀 B6 의 실측 수식 그대로. obs 테이블은 kosis 전용이라(RULING 7)
  // src 를 kosis 로 두되 표 이름은 실측대로 p239_240 을 쓴다.
  // 열 이름은 dbCol(execute.ts) 이 아는 KOSIS 체계를 써야 실행이 된다 — 나라는 C1_NM 이다.
  const db = openDb(':memory:');
  loadJsonl(db, 'kosis', 'p239_240', [
    JSON.stringify({ PRD_DE: '2023', C1_NM: '한국', DT: 40 }),
    JSON.stringify({ PRD_DE: '2023', C1_NM: '일본', DT: 60 }),
  ]);
  const headers: Headers = { kosis: { p239_240: ['PRD_DE', 'C1_NM', 'DT'] }, oecd: {}, etc: {}, panel: {} };
  const ctx = { extmap: { '1': 'KOSIS_원데이터.xlsx' }, headers };
  const formula = '=IF($A6="OECD",SUMIFS([1]p239_240!$C:$C,[1]p239_240!$A:$A,B$5)/COUNTIFS([1]p239_240!$A:$A,B$5,[1]p239_240!$C:$C,">0")/1000,' +
    'IF(SUMIFS([1]p239_240!$C:$C,[1]p239_240!$A:$A,B$5,[1]p239_240!$B:$B,$A6)=0,"-",SUMIFS([1]p239_240!$C:$C,[1]p239_240!$A:$A,B$5,[1]p239_240!$B:$B,$A6)/1000))';
  const e = parseFormula(formula, ctx);
  assert.equal(e.op, 'if');

  const oecdRow: Grid = { A6: 'OECD', B5: '2023' };
  const oecdResult = execute(e, { db, grids: { p1: oecdRow }, sheet: 'p1' });
  // OECD 행: 평균 = (40+60)/2 = 50, ÷1000 = 0.05
  assert.equal(oecdResult, 0.05);

  const countryRow: Grid = { A6: '한국', B5: '2023' };
  const countryResult = execute(e, { db, grids: { p1: countryRow }, sheet: 'p1' });
  // 나라 행: 40 ÷ 1000 = 0.04 — OECD 행과 다른 값이어야 두 갈래가 실제로 갈린 것이 증명된다
  assert.equal(countryResult, 0.04);
  assert.notEqual(oecdResult, countryResult);
});

test('FAMILY 3: B21=2019·C21=2020 이면 2020 개편 경계라 "…" 를 낸다', () => {
  const db = fixture();
  const e = parseFormula('=IF(AND(B$21<2020,C$21>=2020),"…",IFERROR((C23-B23)/B23%,"-"))', if3Ctx);
  const grid: Grid = { B21: 2019, C21: 2020, B23: 62734, C23: 59024 };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), '…');
});

test('FAMILY 3: B21=2020·C21=2021 이면 경계를 지나 실제 증감률을 계산한다 — 기준연도가 넘어가면 규칙이 스스로 풀린다', () => {
  const db = fixture();
  const e = parseFormula('=IF(AND(B$21<2020,C$21>=2020),"…",IFERROR((C23-B23)/B23%,"-"))', if3Ctx);
  const grid: Grid = { B21: 2020, C21: 2021, B23: 100, C23: 110 };
  // (110-100)/100% = 10/(100/100) = 10
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), 10);
});

test('FAMILY 3: IFERROR — B23=0 이면 분모 0 이라 "-" 로 떨어진다', () => {
  const db = fixture();
  const e = parseFormula('=IF(AND(B$21<2020,C$21>=2020),"…",IFERROR((C23-B23)/B23%,"-"))', if3Ctx);
  const grid: Grid = { B21: 2020, C21: 2021, B23: 0, C23: 10 };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), '-');
});

// 회귀: zeroDash(IF(X=0,"-",X)) 는 일반 if 경로를 새로 얹어도 여전히 zeroDash 로
// 파싱되고 같은 값을 낸다 — 위의 두 'zeroDash: ...' 테스트가 이미 이 경로를 검사하고
// 있으므로, 여기서는 파서가 여전히 zeroDash 를 골라내는지만 한 번 더 확인한다.
test('회귀: IF(X=0,"-",X) 는 일반 if 가 아니라 여전히 zeroDash 로 파싱된다', () => {
  const e = parseFormula(
    '=IF(SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$G:$G,"취업자")=0,"-",' +
    'SUMIFS([1]DT_1DA7012S!$C:$C,[1]DT_1DA7012S!$G:$G,"취업자"))',
    { extmap: { '1': 'KOSIS_원데이터.xlsx' },
      headers: { kosis: { DT_1DA7012S:
        ['C1_OBJ_NM', 'C2_NM', 'DT', 'C2', 'C1', 'ITM_ID', 'ITM_NM'] }, oecd: {}, etc: {}, panel: {} } });
  assert.equal(e.op, 'zeroDash');
});

// --- Task 9 단위 4 ---

// CHANGE 2: NUMBERVALUE — 실측(part1_5!p82!C7 등, "69.3%"*100 → 69.3). 예전에는 껍데기만
// 벗겨 문자열이 num() 을 거쳐 0 이 됐다. 이제 진짜로 파싱한다: '%' 는 ÷100.
test('CHANGE 2: NUMBERVALUE(x)*100 — 퍼센트 문자열을 숫자로 읽는다', () => {
  const db = fixture();
  const headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
  const ctx = { extmap: {}, headers };
  const e = parseFormula('=_xlfn.NUMBERVALUE(B7)*100', ctx);
  const grids: Record<string, Grid> = { p1: { B7: '69.3%' } };
  assert.equal(execute(e, { db, grids, sheet: 'p1' }), 69.3);
});

test('CHANGE 2: NUMBERVALUE — 천단위 구분자를 지운다', () => {
  const db = fixture();
  const headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
  const ctx = { extmap: {}, headers };
  const e = parseFormula('=NUMBERVALUE(B7)', ctx);
  const grids: Record<string, Grid> = { p1: { B7: '1,234' } };
  assert.equal(execute(e, { db, grids, sheet: 'p1' }), 1234);
});

test('CHANGE 2: NUMBERVALUE — 못 읽는 문자열은 0 이 아니라 오류(null)다', () => {
  const db = fixture();
  const headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
  const ctx = { extmap: {}, headers };
  const e = parseFormula('=NUMBERVALUE(B7)', ctx);
  const grids: Record<string, Grid> = { p1: { B7: '해당없음' } };
  assert.equal(execute(e, { db, grids, sheet: 'p1' }), null);
});

// CHANGE 3: 산술은 텍스트 피연산자를 0 으로 조용히 바꾸지 않고 오류(null)를 내고,
// IFERROR 가 그걸 잡는다. 실측(part1_6!p87!B11): A10="실질임금"(라벨)이면 -100 이 아니라 "-".
test('CHANGE 3: IFERROR(B10*100/A10-100,"-") — A10 이 텍스트면 -100 이 아니라 "-"', () => {
  const db = fixture();
  const headers: Headers = { kosis: {}, oecd: {}, etc: {}, panel: {} };
  const ctx = { extmap: {}, headers };
  const e = parseFormula('=IFERROR(B10*100/A10-100,"-")', ctx);
  const grids: Record<string, Grid> = { p1: { B10: 62734, A10: '실질임금' } };
  assert.equal(execute(e, { db, grids, sheet: 'p1' }), '-');
});

// CHANGE 3 이 없으면 이 테스트가 -100 을 낸다 — num('실질임금') → 0 → div 가 #DIV/0!
// 대신 조용히 0 이 되고 그 뒤 -100 으로 굳어버린다. 일반화된 고침(numOrErr)이 add/sub/
// mul/div/pct 전부에서 텍스트 피연산자를 오류로 propagate 하는지 IFERROR 없이 직접 확인한다.
test('CHANGE 3: 산술 전반 — 텍스트 피연산자는 add/sub/mul/div 어디서든 오류(null)로 번진다', () => {
  const db = fixture();
  const grids: Record<string, Grid> = { p1: { A10: '실질임금' } };
  const ctx = { db, grids, sheet: 'p1' };
  const cell: Expr = { op: 'cell', ref: 'A10' };
  assert.equal(execute({ op: 'mul', a: cell, b: { op: 'const', v: 100 } }, ctx), null);
  assert.equal(execute({ op: 'div', a: { op: 'const', v: 100 }, b: cell }, ctx), null);
  assert.equal(execute({ op: 'sub', a: cell, b: { op: 'const', v: 1 } }, ctx), null);
  assert.equal(execute({ op: 'add', args: [cell, { op: 'const', v: 1 }] }, ctx), null);
  assert.equal(execute({ op: 'pct', inner: cell }, ctx), null);
});

// zeroDash 는 numOrErr 이 아니라 그대로 num() 을 쓴다 — SUM 이 정당하게 0 을 내는
// 5,754건이 여전히 '-' 로 나와야지 CHANGE 3 로 인해 오류로 새면 안 된다(회귀 확인).
test('회귀: CHANGE 3 이후에도 zeroDash 는 SUM=0 을 그대로 "-" 로 낸다', () => {
  const db = fixture();
  const e: Expr = { op: 'zeroDash', inner: { op: 'sumifs',
    q: { src: 'kosis', table: 'T', value: 'DT',
         where: { ITM_NM: { kind: 'lit', value: '없는항목' } } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), '-');
});

// CHANGE 4: TEXT 는 엑셀처럼 유효자릿수 15 로 먼저 줄이고 나서 반올림한다. 실측
// (part3!p223!O31): 21.049999999999997 은 한 번에 반올림하면 21.0(틀림) — 15 유효자릿수로
// 줄이면 정확히 21.05 가 되고, 그제서야 사사오입해 21.1(오라클과 일치)이 나온다.
// 단일 단계 반올림 구현이면 이 테스트는 실패한다(그 구현은 '21.0' 을 낸다).
test('CHANGE 4: TEXT(x,"0.0") — 15 유효자릿수로 줄인 뒤 반올림한다', () => {
  const e: Expr = { op: 'text', inner: { op: 'const', v: 21.049999999999997 }, decimals: 1 };
  const db = fixture();
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1' }), '21.1');
});

test('sumifs: etc 소스는 long 테이블이 없어 src 를 담아 던진다', () => {
  const db = fixture();
  const e: Expr = { op: 'sumifs', q: { src: 'etc', table: 'S1', value: 'V',
    where: {} } };
  assert.throws(
    () => execute(e, { db, grids: { p1: grid }, sheet: 'p1' }),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /etc/);
      return true;
    }
  );
});

// Task 9 단위 8: & 는 엑셀 일반 서식으로 숫자를 문자로 바꾼다 — 2025 는 "2025" 다
test('concat: 숫자와 문자를 이어붙이면 문자열이다', () => {
  const db = null as never;
  const c = { db, grids: { p1: { B5: 2021, C5: 21.049999999999997 } }, sheet: 'p1' };
  assert.equal(execute({ op: 'concat', args: [{ op: 'cell', ref: 'B5' }, { op: 'str', v: '년' }] }, c), '2021년');
  assert.equal(execute({ op: 'concat', args: [{ op: 'cell', ref: 'C5' }, { op: 'str', v: '%' }] }, c), '21.05%');
  // 오류(null)인 하위식은 그대로 오류로 흘러간다
  assert.equal(execute({ op: 'concat',
    args: [{ op: 'div', a: { op: 'const', v: 1 }, b: { op: 'const', v: 0 } }, { op: 'str', v: '년' }] }, c), null);
});

// Task 9 단위 8: "#,##0" 은 천단위 구분자를 찍는다 — & 로 이어붙인 지면 문구가 그것을 쓴다
test('text: 형식에 콤마가 있으면 천단위 구분자를 찍는다', () => {
  const db = null as never;
  const c = { db, grids: { p1: { B11: 4205, C12: 25839, D1: -1234567.44 } }, sheet: 'p1' };
  assert.equal(execute({ op: 'text', inner: { op: 'cell', ref: 'B11' }, decimals: 0, group: true }, c), '4,205');
  assert.equal(execute({ op: 'text', inner: { op: 'cell', ref: 'D1' }, decimals: 1, group: true }, c), '-1,234,567.4');
  // 콤마가 없는 형식은 그대로다
  assert.equal(execute({ op: 'text', inner: { op: 'cell', ref: 'C12' }, decimals: 0 }, c), '25839');
  assert.equal(execute({ op: 'concat', args: [
    { op: 'str', v: '월평균 ' },
    { op: 'text', inner: { op: 'cell', ref: 'B11' }, decimals: 0, group: true },
    { op: 'str', v: '천원' }] }, c), '월평균 4,205천원');
});

// ── 전체 리뷰 F5 — 반올림 규칙이 한 곳이다 ──────────────────────────────────
// `textFixed`(TEXT)와 `case 'round'`(ROUND)가 같은 규칙을 주장하면서 `toPrecision(15)`
// 단계를 스케일링의 **반대편**에 두고 있었다. TEXT 는 「먼저 15자리로 줄이고 스케일」,
// ROUND 는 「스케일하고 15자리로 줄임」. 엑셀은 후자다(스케일된 십진표현을 반올림한다).
// 전수 비교로 나온 반례가 1.005@2 — TEXT 경로 "1.00" · ROUND 경로 1.01 · 엑셀 1.01.
test('F5: TEXT 와 ROUND 가 같은 사사오입을 쓴다 — 엑셀 값으로 고정', () => {
  const c = { db: null as never, grids: {}, sheet: 'p1' };
  const text = (v: number, d: number) =>
    execute({ op: 'text', inner: { op: 'const', v }, decimals: d }, c);
  const round = (v: number, d: number) =>
    execute({ op: 'round', inner: { op: 'const', v }, digits: { op: 'const', v: d } }, c);
  // 엑셀: ROUND(1.005,2)=1.01 · TEXT(1.005,"0.00")="1.01"
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(text(1.005, 2), '1.01');
  assert.equal(round(-1.005, 2), -1.01);
  assert.equal(text(-1.005, 2), '-1.01');
  // 엑셀: ROUND(2.675,2)=2.68 (부동소수 그대로면 2.67 이 된다)
  assert.equal(round(2.675, 2), 2.68);
  assert.equal(text(2.675, 2), '2.68');
  // 15자리 축약이 없으면 21.0 이 나오는 실측 값(part3!p223!O31) — 두 경로 모두 21.1
  assert.equal(round(21.049999999999997, 1), 21.1);
  assert.equal(text(21.049999999999997, 1), '21.1');
  // 두 경로가 자릿수 0~3 에서 같은 값을 낸다
  for (const v of [1.005, 2.675, 0.5, 1.5, -2.5, 21.049999999999997, 1234.5678, -0.0049]) {
    for (const d of [0, 1, 2, 3]) {
      assert.equal(text(v, d), (round(v, d) as number).toFixed(d), `${v} @${d}`);
    }
  }
});
