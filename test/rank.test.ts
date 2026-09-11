import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFormula } from '../src/cellmap/parse.ts';
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

// ── SUMPRODUCT (측정된 한 모양) · COUNTA ─────────────────────────────────────

test('SUMPRODUCT(--ISNUMBER(범위),--(범위<>"OECD")): part3!p214!I11 = 38', () => {
  assertMatches('part3', 'p214', 'I11', 38);
});

test('COUNTA + 문자 연결: part3!p214!A46', () => {
  assertMatches('part3', 'p214', 'A46', '■ 책자 수록 13개국 (2025년 내림차순)');
});

test('SUMPRODUCT 의 다른 모양은 unsupported 로 남는다 — 배열 엔진을 만들지 않았다', () => {
  const e = parseFormula('=SUMPRODUCT($A$6:$A$43,$G$6:$G$43)', { extmap: {}, headers });
  assert.equal(e.op, 'unsupported');
  assert.match((e as { reason: string }).reason, /SUMPRODUCT/);
  const e2 = parseFormula('=SUMPRODUCT(--ISNUMBER($G$6:$G$43))', { extmap: {}, headers });
  assert.equal(e2.op, 'unsupported');
});

// ── INDEX · MATCH · N + 범위 대상 COUNTIFS ───────────────────────────────────

test('순위 계산: part3!p214!I8 = 9 (INDEX·MATCH·범위 COUNTIFS)', () => {
  assertMatches('part3', 'p214', 'I8', 9);
});

test('순위 계산 + "<>OECD" 부정 조건: part3!p215!I8 = 30', () => {
  assertMatches('part3', 'p215', 'I8', 30);
});

test('순위 계산 뺄셈형 + ">0": part3!p230!I8 = 4', () => {
  assertMatches('part3', 'p230', 'I8', 4);
});

// presentation 판정을 지키는 경계 — 이것이 깨지면 관문의 presentation 3,364 가 무너진다.
// 실측: presentation 3,364건의 INDEX/MATCH 범위는 **전부 시트 한정**(3,246건)이고,
// 이 단위가 푸는 순위 계산 28건은 **전부 한정 없음**이다. 그 선으로 가른다.
test('다른 시트를 가리키는 INDEX/MATCH 는 여전히 unsupported 이고 이유에 함수 이름이 남는다', () => {
  const e = parseFormula("=INDEX('p214'!$B$48:$B$60,MATCH($A48,'p214'!$A$48:$A$60,0))",
    { extmap: {}, headers });
  assert.equal(e.op, 'unsupported');
  // compare.ts 의 presentation 판정이 이유에서 INDEX/MATCH/RANK 를 찾는다 — 이름이 남아야 한다
  assert.match((e as { reason: string }).reason, /INDEX/);
  const e2 = parseFormula('=INDEX(_정렬기준!$A$3:$A$41,MATCH(ROW()-5,_정렬기준!$CA$3:$CA$41,0))',
    { extmap: {}, headers });
  assert.equal(e2.op, 'unsupported');
  assert.match((e2 as { reason: string }).reason, /INDEX/);
});

test('MATCH 의 세 번째 인자가 0 이 아니면 unsupported 다', () => {
  const e = parseFormula('=MATCH($A6,$A$6:$A$43,1)', { extmap: {}, headers });
  assert.equal(e.op, 'unsupported');
  assert.match((e as { reason: string }).reason, /세 번째 인자/);
});

// ── 범위 함수의 의미 (합성 격자) ─────────────────────────────────────────────

const grid: Grid = { A1: 10, A2: 20, A3: 'OECD', A4: null, B1: 'x', B2: 'y', B3: 'z' };
const ctx = () => ({ db: realDb, grids: { p1: grid }, sheet: 'p1' });
const R = (r1: number, r2: number, c = 1) => ({ r1, c1: c, r2, c2: c });

test('INDEX 는 1-based 이고 범위를 넘으면 #REF!(null) 다', () => {
  const c = ctx();
  const idx = (n: number): Expr => ({ op: 'index', range: R(1, 3), n: { op: 'const', v: n } });
  assert.equal(execute(idx(1), c), 10);
  assert.equal(execute(idx(3), c), 'OECD');
  assert.equal(execute(idx(4), c), null);
  assert.equal(execute(idx(0), c), null);
});

test('MATCH 는 1-based 이고 못 찾으면 #N/A(null) 다 · 대소문자 무시', () => {
  const c = ctx();
  const m = (v: string | number): Expr =>
    ({ op: 'match', needle: typeof v === 'number' ? { op: 'const', v } : { op: 'str', v }, range: R(1, 3) });
  assert.equal(execute(m(20), c), 2);
  assert.equal(execute(m('oecd'), c), 3);
  assert.equal(execute(m('없음'), c), null);
});

test('N(x) — 수치면 그대로, 아니면 0', () => {
  const c = ctx();
  assert.equal(execute({ op: 'n', inner: { op: 'const', v: 5 } }, c), 5);
  assert.equal(execute({ op: 'n', inner: { op: 'str', v: 'OECD' } }, c), 0);
  assert.equal(execute({ op: 'n', inner: { op: 'cell', ref: 'A4' } }, c), 0);   // 빈 칸
});

test('범위 COUNTIFS: 조건을 위치마다 맞춰 센다 · "<>" 는 빈 칸에도 맞는다', () => {
  const c = ctx();
  const rc = (crit: string, r1 = 1, r2 = 4): Expr =>
    ({ op: 'rangecount', preds: [{ kind: 'crit', range: R(r1, r2), crit: { op: 'str', v: crit } }] });
  assert.equal(execute(rc('>10'), c), 1);            // 20
  assert.equal(execute(rc('>=10'), c), 2);           // 10 · 20
  assert.equal(execute(rc('OECD'), c), 1);
  assert.equal(execute(rc('<>OECD'), c), 3);         // 10 · 20 · 빈 칸
});

test('범위 COUNTIFS: 두 조건을 동시에 만족하는 칸만 센다', () => {
  const c = ctx();
  const e: Expr = { op: 'rangecount', preds: [
    { kind: 'crit', range: R(1, 3), crit: { op: 'str', v: '>=10' } },
    { kind: 'crit', range: R(1, 3, 2), crit: { op: 'str', v: '<>z' } },
  ] };
  assert.equal(execute(e, c), 2);                    // A1/B1 · A2/B2
});

test('범위 크기가 다르면 던진다 — 조용히 짧은 쪽에 맞추지 않는다', () => {
  const e: Expr = { op: 'rangecount', preds: [
    { kind: 'crit', range: R(1, 3), crit: { op: 'str', v: '>0' } },
    { kind: 'crit', range: R(1, 4, 2), crit: { op: 'str', v: '<>z' } },
  ] };
  assert.throws(() => execute(e, ctx()), /범위 크기가 다르다/);
});

test('동적 조건 ">"&값 이 실행 시 만들어진다', () => {
  const c = ctx();
  const e: Expr = { op: 'rangecount', preds: [{ kind: 'crit', range: R(1, 3),
    crit: { op: 'concat', args: [{ op: 'str', v: '>' }, { op: 'const', v: 10 }] } }] };
  assert.equal(execute(e, c), 1);
});

// ── AVERAGEIFS ───────────────────────────────────────────────────────────────

test('AVERAGEIFS (oecd_obs): part1_2!p33!B8', () => {
  assertMatches('part1_2', 'p33', 'B8', 0.31931199441228414);
});

test('AVERAGEIFS + "<>OECD": part1_2!p34!K32', () => {
  assertMatches('part1_2', 'p34', 'K32', 13.313554738170001);
});

test('AVERAGEIFS 는 합÷개수가 아니다 — 맞는 행이 없으면 #DIV/0!(null) 이고 IFERROR 가 받는다', () => {
  const c = ctx();
  const q = { src: 'oecd' as const, table: 'LP', value: 'value',
    where: { TIME_PERIOD: { kind: 'lit' as const, value: '1900' } } };
  const e: Expr = { op: 'averageifs', q };
  assert.equal(execute(e, c), null);
  assert.equal(execute({ op: 'iferror', inner: e, fallback: { op: 'str', v: '-' } }, c), '-');
  // 같은 조건의 SUMIFS 는 0 이다 — 둘을 구별한다
  assert.equal(execute({ op: 'sumifs', q }, c), 0);
});
