import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFormula, colLetters } from '../src/cellmap/parse.ts';
import { execute } from '../src/query/execute.ts';
import { makeAnchorCtx, ANCHOR_SEAT } from '../src/query/anchor.ts';
import { sameValue } from '../src/verify/compare.ts';
import type { Expr, Grid, Headers } from '../src/types.ts';

const headers = JSON.parse(readFileSync(join('data', 'raw', 'headers.json'), 'utf8')) as Headers;
const realDb = new DatabaseSync(join('data', 'obs.sqlite'), { readOnly: true });

type FormulaDump = { extmap: Record<string, string>; sheets: Record<string, Record<string, string>> };
type OracleDump = Record<string, Record<string, string | number>>;
const cache = new Map<string, { dump: FormulaDump; oracle: OracleDump }>();
function load(part: string) {
  let c = cache.get(part);
  if (!c) {
    c = {
      dump: JSON.parse(readFileSync(join('data', 'formulas', `${part}.json`), 'utf8')) as FormulaDump,
      oracle: JSON.parse(readFileSync(join('data', 'oracle', `${part}.json`), 'utf8')) as OracleDump,
    };
    cache.set(part, c);
  }
  return c;
}
function cell(part: string, sheet: string, ref: string) {
  const { dump, oracle } = load(part);
  const formula = dump.sheets[sheet]?.[ref];
  assert.ok(formula, `${part}!${sheet}!${ref} 에 수식이 없다`);
  const e = parseFormula(formula, { extmap: dump.extmap, headers });
  const anchor = makeAnchorCtx(dump.sheets, 2025, oracle[ANCHOR_SEAT.sheet]?.[ANCHOR_SEAT.ref]);
  const got = execute(e, { db: realDb, grids: oracle as Record<string, Grid>, sheet, anchor });
  return { e, got, want: oracle[sheet][ref], formula };
}
function assertMatches(part: string, sheet: string, ref: string, want?: string | number) {
  const r = cell(part, sheet, ref);
  if (want !== undefined) assert.equal(r.want, want, `확정본이 바뀌었다: ${part}!${sheet}!${ref}`);
  assert.ok(sameValue(r.want, r.got),
    `${part}!${sheet}!${ref} ${r.formula}\n  확정본 ${JSON.stringify(r.want)} / 계산 ${JSON.stringify(r.got)}`);
  return r;
}

// ── 범위 순회의 바닥: 열 번호 → 열 문자 ──────────────────────────────────────

test('열 번호 → 열 문자: 1→A · 3→C · 16→P · 27→AA · 102→CX', () => {
  assert.equal(colLetters(1), 'A');
  assert.equal(colLetters(3), 'C');
  assert.equal(colLetters(16), 'P');
  assert.equal(colLetters(26), 'Z');
  assert.equal(colLetters(27), 'AA');
  assert.equal(colLetters(102), 'CX');     // MAX(B6:CX6) 의 그 열
});

// ── SUM · MAX ────────────────────────────────────────────────────────────────

test('SUM + 후위 % (÷100): part1_1!p10!B30', () => {
  assertMatches('part1_1', 'p10', 'B30', 50.583711763969326);
});

test('SUM 행 범위: part1_3!p57!H8 = 2666.6', () => {
  assertMatches('part1_3', 'p57', 'H8', 2666.6);
});

test('SUM 을 뺀다: part1_9!p139!H24 = 2570832', () => {
  assertMatches('part1_9', 'p139', 'H24', 2570832);
});

test('SUM 에 단일 셀이 온다: part1_4(1)!p66!F20 = 502568', () => {
  assertMatches('part1_4(1)', 'p66', 'F20', 502568);
});

test('SUM 절대참조 범위 + %: part1_2!p24!D6', () => {
  assertMatches('part1_2', 'p24', 'D6', 1.5697259419115457);
});

test('MAX 102칸 범위(2자리 열 문자 CX): part1_1!p11!J10 = 47258378', () => {
  const r = assertMatches('part1_1', 'p11', 'J10', 47258378);
  assert.deepEqual((r.e as { args: unknown[] }).args,
    [{ range: { r1: 6, c1: 2, r2: 6, c2: 102 } }]);   // B6:CX6 이 제대로 펼쳐졌는가
});

// ── 지면 안에서 찾는 VLOOKUP (단위 6 이 남긴 182건) ──────────────────────────

test('지면 내부 VLOOKUP: part1_5!p83!G24', () => {
  assertMatches('part1_5', 'p83', 'G24', '2025직종_경영·행정·사무직');
});

test('지면 내부 VLOOKUP + 나눗셈: part1_5!p83!I24', () => {
  assertMatches('part1_5', 'p83', 'I24');
});

test('내부 VLOOKUP 이 다른 시트를 읽는다: part1_7!p122_123!B6 = 202215', () => {
  assertMatches('part1_7', 'p122_123', 'B6', 202215);
});

test('내부 VLOOKUP 같은 시트 범위: part1_7!p122_123!D6 = 12889', () => {
  assertMatches('part1_7', 'p122_123', 'D6', 12889);
});

test('내부 VLOOKUP 이 문자를 낸다: part1_9!p142!H33 = "울산광역시"', () => {
  assertMatches('part1_9', 'p142', 'H33', '울산광역시');
});

// ── 문자 함수: LEN · FIND · RIGHT ────────────────────────────────────────────

test('RIGHT + LEN + FIND: part1_5!p80!B30 = "경영·행정·사무직"', () => {
  assertMatches('part1_5', 'p80', 'B30', '경영·행정·사무직');
});

// ── QUOTIENT · MOD · ROUND ───────────────────────────────────────────────────

test('QUOTIENT·MOD·ROUND + 문자 연결: part2_2장년비정규직!p184!B14 = "15년 7개월"', () => {
  assertMatches('part2_2장년비정규직', 'p184', 'B14', '15년 7개월');
});

// ── 범위 의미 (합성 격자) ────────────────────────────────────────────────────

const grid: Grid = {
  A1: 1, A2: '문자', A3: null, A4: 2.5, A5: '', A6: 10,
  B1: 'x', B2: 'y',
};
const ctx = () => ({ db: realDb, grids: { p1: grid }, sheet: 'p1' });
const agg = (fn: 'sum' | 'max' | 'counta', r1: number, r2: number): Expr =>
  ({ op: 'agg', fn, args: [{ range: { r1, c1: 1, r2, c2: 1 } }] });

test('SUM 은 빈 칸과 문자 칸을 무시한다', () => {
  assert.equal(execute(agg('sum', 1, 6), ctx()), 13.5);        // 1 + 2.5 + 10
  assert.equal(execute(agg('sum', 2, 3), ctx()), 0);           // 문자·빈 칸만 → 0
});

test('MAX 는 수치만 보고, 전부 비면 0 이다', () => {
  assert.equal(execute(agg('max', 1, 6), ctx()), 10);
  assert.equal(execute(agg('max', 2, 3), ctx()), 0);
});

test('COUNTA 는 비어 있지 않은 칸을 센다 (빈 문자열은 세지 않는다)', () => {
  // A1 1 · A2 '문자' · A3 null · A4 2.5 · A5 '' · A6 10 → 4
  assert.equal(execute(agg('counta', 1, 6), ctx()), 4);
  assert.equal(execute(agg('counta', 3, 3), ctx()), 0);
});

test('FIND 가 못 찾으면 #VALUE!(null) 이 전파된다', () => {
  const c = ctx();
  const find = (needle: string, inside: string): Expr =>
    ({ op: 'find', needle: { op: 'str', v: needle }, inside: { op: 'str', v: inside } });
  assert.equal(execute(find('_', 'a_b'), c), 2);              // 1-based
  assert.equal(execute(find('_', 'abc'), c), null);           // #VALUE!
  // 오류가 산술로 흐르면 그대로 오류다 (0 으로 뭉개지 않는다)
  assert.equal(execute({ op: 'sub', a: { op: 'const', v: 3 }, b: find('_', 'abc') }, c), null);
  assert.equal(execute({ op: 'iferror', inner: find('_', 'abc'), fallback: { op: 'str', v: '-' } }, c), '-');
});

test('LEN · QUOTIENT · MOD · ROUND', () => {
  const c = ctx();
  assert.equal(execute({ op: 'len', inner: { op: 'str', v: '가나다' } }, c), 3);
  assert.equal(execute({ op: 'quotient', a: { op: 'const', v: 187 }, b: { op: 'const', v: 12 } }, c), 15);
  assert.equal(execute({ op: 'mod', a: { op: 'const', v: 187 }, b: { op: 'const', v: 12 } }, c), 7);
  assert.equal(execute({ op: 'round', inner: { op: 'const', v: 6.5 }, digits: { op: 'const', v: 0 } }, c), 7);
  assert.equal(execute({ op: 'round', inner: { op: 'const', v: -6.5 }, digits: { op: 'const', v: 0 } }, c), -7);
  assert.equal(execute({ op: 'round', inner: { op: 'const', v: 1.2345 }, digits: { op: 'const', v: 2 } }, c), 1.23);
  // 0 으로 나누기는 오류다
  assert.equal(execute({ op: 'mod', a: { op: 'const', v: 1 }, b: { op: 'const', v: 0 } }, c), null);
  assert.equal(execute({ op: 'quotient', a: { op: 'const', v: 1 }, b: { op: 'const', v: 0 } }, c), null);
});

test('범위가 터무니없이 크면 던진다 — 조용히 돌지 않는다', () => {
  const e: Expr = { op: 'agg', fn: 'sum', args: [{ range: { r1: 1, c1: 1, r2: 100000, c2: 100 } }] };
  assert.throws(() => execute(e, ctx()), /범위가 너무 크다/);
});
