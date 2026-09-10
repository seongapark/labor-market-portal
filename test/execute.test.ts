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
    where: { PRD_DE: { kind: 'year', ref: 'C6' }, ITM_NM: { kind: 'lit', value: '취업자' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), 190);   // 120 + 70
});

test('sumifs: cell 조건은 격자에서 값을 읽는다', () => {
  const db = fixture();
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', ref: 'C6' }, ITM_NM: { kind: 'cell', ref: 'A14' },
             C1_NM: { kind: 'lit', value: '계' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), 120);
});

test('countifs: 개수를 센다', () => {
  const db = fixture();
  const e: Expr = { op: 'countifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'lit', value: '2025' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), 3);
});

test('countifs: ">0" 같은 비교 조건을 다룬다', () => {
  const db = fixture();
  const e: Expr = { op: 'countifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'lit', value: '2025' }, DT: { kind: 'lit', value: '>60' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), 2);   // 120, 70
});

test('add · div · pct 를 계산한다 — % 는 분모에 붙는다', () => {
  const db = fixture();
  const one = (itm: string): Expr => ({ op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', ref: 'C6' }, ITM_NM: { kind: 'lit', value: itm },
             C1_NM: { kind: 'lit', value: '계' } } } });
  // 엑셀 =M8/(취업자+실업자)% → 60 / ((120+5)/100) = 48. 이것이 백분율이다.
  // RULING 1: % 는 ÷100 이다 (×100 이 아니다) — 이 기대값을 바꾸면 안 된다.
  const e: Expr = { op: 'div', a: { op: 'cell', ref: 'M8' },
    b: { op: 'pct', inner: { op: 'add', args: [one('취업자'), one('실업자')] } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), 48);
});

test('pct 단독은 ÷100 이다', () => {
  const db = fixture();
  assert.equal(execute({ op: 'pct', inner: { op: 'const', v: 50 } },
    { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), 0.5);
});

test('zeroDash: 0 이면 문자열 "-" 를 낸다', () => {
  const db = fixture();
  const e: Expr = { op: 'zeroDash', inner: { op: 'sumifs',
    q: { src: 'kosis', table: 'T', value: 'DT',
         where: { ITM_NM: { kind: 'lit', value: '없는항목' } } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), '-');
});

test('zeroDash: 0 이 아니면 값을 낸다', () => {
  const db = fixture();
  const e: Expr = { op: 'zeroDash', inner: { op: 'sumifs',
    q: { src: 'kosis', table: 'T', value: 'DT',
         where: { PRD_DE: { kind: 'year', ref: 'C6' }, ITM_NM: { kind: 'lit', value: '실업자' } } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), 5);
});

test('unsupported 는 null 이다', () => {
  const db = fixture();
  assert.equal(execute({ op: 'unsupported', reason: 'x', formula: 'y' },
    { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), null);
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
  assert.equal(execute(e, { db, grids: {}, sheet: 'p1', year: '2025' }), 20);
});

test('cell: sheet 를 명시하면 다른 시트의 격자에서 읽는다', () => {
  const db = fixture();
  const other: Grid = { F5: 777 };
  const e: Expr = { op: 'cell', sheet: 'p68', ref: 'F5' };
  assert.equal(execute(e, { db, grids: { p1: grid, p68: other }, sheet: 'p1', year: '2025' }), 777);
});

test('cell: sheet 가 없으면 지금 시트(ctx.sheet)의 격자에서 읽는다', () => {
  const db = fixture();
  const e: Expr = { op: 'cell', ref: 'A14' };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), '취업자');
});

test('cell: 시트가 없으면 던지지 않고 null 이다', () => {
  const db = fixture();
  const e: Expr = { op: 'cell', sheet: '없는시트', ref: 'A1' };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), null);
});

test('cell: 셀이 없으면 던지지 않고 null 이다', () => {
  const db = fixture();
  const e: Expr = { op: 'cell', ref: 'Z99' };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), null);
});

// FIX ROUND 1 — 이 테스트가 있었으면 p42 스팟체크의 결함(모든 연도 열이 ctx.year 하나로
// 뭉개져 68/90 이 불일치)을 미리 잡았을 것이다: 같은 시트 안에서 연도 조건이 가리키는
// 셀이 다르면(B6=2024, C6=2025) 서로 다른 해의 값을 내야 하고, 같은 ctx.year 로도 똑같이
// 유지되어야 한다.
test('FIX ROUND 1: 연도 조건은 자신이 가리키는 셀에서 읽는다 — 열마다 다른 연도가 다른 값을 낸다', () => {
  const db = fixture();
  const sumOf = (yearRef: string): Expr => ({ op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', ref: yearRef }, ITM_NM: { kind: 'lit', value: '취업자' },
             C1_NM: { kind: 'lit', value: '계' } } } });
  const ctx = { db, grids: { p1: grid }, sheet: 'p1', year: '2025' };
  assert.equal(execute(sumOf('B6'), ctx), 100);   // B6 → 2024 의 취업자 계
  assert.equal(execute(sumOf('C6'), ctx), 120);   // C6 → 2025 의 취업자 계 (같은 ctx.year 아래에서도 다르다)
});

// RULING 10: gridCell 은 "키가 없다"와 "값이 명시적으로 null 이다"를 구별하지 못한다 —
// 예비값으로 ctx.year 를 돌려주면 빈 칸·병합된 연도머리글이 조용히 기준연도의 답을 받고
// 대조에서 드러나지 않는다. 이제는 던진다 (이전엔 ctx.year 로 대체했다 — FIX ROUND 1).
test('RULING 10: 연도 조건 셀이 격자에 없으면 대체하지 않고 던진다', () => {
  const db = fixture();
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', ref: 'Z99' }, ITM_NM: { kind: 'lit', value: '실업자' } } } };
  assert.throws(
    () => execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }),
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
  assert.equal(execute(e, { db, grids: {}, sheet: 'p1', year: '2025' }), 205720);
});

// 회귀 확인: COLLATE NOCASE 는 ASCII A~Z 만 접는다 — 한글 기준값에는 영향이 없어야
// 하고, 애초에 대소문자 구별이 무의미한 한글에서 매칭이 깨지지 않아야 한다.
test('sumifs: KOSIS 형 한글 기준은 COLLATE NOCASE 를 붙여도 그대로 매칭된다', () => {
  const db = fixture();
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'lit', value: '2025' }, ITM_NM: { kind: 'lit', value: '취업자' },
             C1_NM: { kind: 'lit', value: '계' } } } };
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), 120);
});

test('sumifs: etc 소스는 long 테이블이 없어 src 를 담아 던진다', () => {
  const db = fixture();
  const e: Expr = { op: 'sumifs', q: { src: 'etc', table: 'S1', value: 'V',
    where: {} } };
  assert.throws(
    () => execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /etc/);
      return true;
    }
  );
});
