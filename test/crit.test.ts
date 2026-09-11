import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFormula } from '../src/cellmap/parse.ts';
import { execute } from '../src/query/execute.ts';
import { makeAnchorCtx, ANCHOR_SEAT } from '../src/query/anchor.ts';
import { openDb, loadJsonl } from '../src/db/load.ts';
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

// ── 갈래 1 (RULING 18): 빈 조건 셀은 그 SUMIFS 항을 0 으로 만든다 ────────────

test('빈 조건 셀: part1_9!p139!B24 = 9299548 (둘째 항이 0)', () => {
  assertMatches('part1_9', 'p139', 'B24', 9299548);
});

test('빈 조건 셀: part1_9!p141!I35 = -18730', () => {
  assertMatches('part1_9', 'p141', 'I35', -18730);
});

test('빈 조건 셀: part2_1청년여성!p167!D5 = 2094.1', () => {
  assertMatches('part2_1청년여성', 'p167', 'D5', 2094.1);
});

test('빈 조건 셀 + 나눗셈: part2_1청년여성!p167!D9', () => {
  assertMatches('part2_1청년여성', 'p167', 'D9', 41.927281463981096);
});

test('빈 조건 셀 하나만 쓰는 SUMIFS 는 0 이다: part1_7!p112!H14 = 0', () => {
  const r = assertMatches('part1_7', 'p112', 'H14', 0);
  assert.equal(r.got, 0);
  assert.notEqual(r.got, null);
});

function obsFixture() {
  const db = openDb(':memory:');
  loadJsonl(db, 'kosis', 'T', [
    JSON.stringify({ PRD_DE: '2025', C1_NM: '계', C2_NM: '0 - 4세', DT: 10 }),
    JSON.stringify({ PRD_DE: '2025', C1_NM: '계', C2_NM: '5 - 9세', DT: 20 }),
  ]);
  return db;
}
const T = (crit: Expr | null, ref = 'Z99'): Expr => ({
  op: 'sumifs',
  q: { src: 'kosis', table: 'T', value: 'DT',
       where: { C2_NM: crit === null ? { kind: 'cell', ref } : { kind: 'expr', e: crit } } },
});

test('빈 조건은 문자 열에서 아무것도 맞히지 않는다 — 합이 0 이고 null 이 아니다', () => {
  const db = obsFixture();
  const ctx = { db, grids: { p1: { A1: '0 - 4세' } as Grid }, sheet: 'p1' };
  // 있는 조건은 맞힌다
  assert.equal(execute(T(null, 'A1'), ctx), 10);
  // 격자에 없는 칸(=빈 조건)은 아무것도 맞히지 않는다
  const v = execute(T(null, 'Z99'), ctx);
  assert.equal(v, 0);
  assert.notEqual(v, null);
});

// ── RULING 10 회귀: 연도 조건은 못 풀면 **계속 던진다** ──────────────────────

test('RULING 10: 앵커로도 격자로도 못 푸는 연도 조건은 던진다 (조용한 예비값 금지)', () => {
  const db = obsFixture();
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', e: { op: 'cell', ref: 'Z99' } } } } };
  assert.throws(() => execute(e, { db, grids: { p1: {} }, sheet: 'p1' }), /연도 조건/);
  // 빈 조건으로 조용히 0 이 되지도, 기준연도로 대체되지도 않는다
  const anchor = makeAnchorCtx({ _시계열: { B1: "='[1]0_수집현황'!$A$1" } }, 2025);
  assert.throws(() => execute(e, { db, grids: { p1: {} }, sheet: 'p1', anchor }), /연도 조건/);
});

test('RULING 10: 앵커로 풀리는 연도 조건은 앵커 값을 쓴다', () => {
  const db = obsFixture();
  const anchor = makeAnchorCtx({ _시계열: { B1: "='[1]0_수집현황'!$A$1" } }, 2025);
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', e: { op: 'cell', sheet: '_시계열', ref: 'B1' } } } } };
  assert.equal(execute(e, { db, grids: { p1: {} }, sheet: 'p1', anchor }), 30);
});

// ── 갈래 3: TEXT 조건이 앵커 표현식이다 ──────────────────────────────────────

test('TEXT(_시계열!$B$1-1,"0") 조건: part1_1!p18!B6 = -44692', () => {
  assertMatches('part1_1', 'p18', 'B6', -44692);
});

test('TEXT(_시계열!$B$1,"0") 조건: part1_1!p18!C6 = -26769', () => {
  assertMatches('part1_1', 'p18', 'C6', -26769);
});

test('연도 조건은 정수 문자열이 된다 — 앵커에서 계산해도 모양이 같다', () => {
  const db = obsFixture();
  const anchor = makeAnchorCtx({ _시계열: { B1: "='[1]0_수집현황'!$A$1" } }, 2025);
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year',
      e: { op: 'sub', a: { op: 'cell', sheet: '_시계열', ref: 'B1' }, b: { op: 'const', v: 0 } } } } } };
  assert.equal(execute(e, { db, grids: { p1: {} }, sheet: 'p1', anchor }), 30);   // "2025" 로 맞는다
});

test('TEXT 조건의 형식이 "0" 이 아니면 unsupported 로 남는다', () => {
  const e = parseFormula('=SUMIFS([1]T!$B:$B,[1]T!$F:$F,TEXT(B$6,"0.0"))',
    { extmap: { '1': 'KOSIS_원데이터.xlsx' },
      headers: { kosis: { T: ['ITM_NM', 'DT', 'C1_NM', 'C2_NM', 'C3_NM', 'PRD_DE'] }, oecd: {}, etc: {}, panel: {} } });
  assert.equal(e.op, 'unsupported');
  assert.match((e as { reason: string }).reason, /TEXT/);
});

// ── 갈래 2: SUBSTITUTE 와일드카드 이스케이프 → 원본 값으로 맞힌다 ────────────

test('SUBSTITUTE 이스케이프 조건: part1_3!p49!B10 = 19464.2 (A10 에 * 와 ~ 가 있다)', () => {
  const { oracle } = load('part1_3');
  assert.equal(oracle['p49'].A10, '* 사회간접자본 및 기타서비스업(D~U)');
  assertMatches('part1_3', 'p49', 'B10', 19464.2);
});

test('SUBSTITUTE 이스케이프 조건 + 뺄셈: part1_3!p50!J32 = 21059.8', () => {
  assertMatches('part1_3', 'p50', 'J32', 21059.8);
});

test('조건의 ~ 이스케이프를 되돌려 문자 그대로 맞힌다 (단위 6 의 규칙을 조건에도)', () => {
  const db = openDb(':memory:');
  loadJsonl(db, 'kosis', 'T', [
    JSON.stringify({ PRD_DE: '2025', C2_NM: '* 광공업(BC)', DT: 7 }),
    JSON.stringify({ PRD_DE: '2025', C2_NM: 'X 광공업(BC)', DT: 5 }),
  ]);
  const ctx = { db, grids: { p1: { A9: '* 광공업(BC)' } as Grid }, sheet: 'p1' };
  // SUBSTITUTE 자체는 정직하게 '~* 광공업(BC)' 를 만들고, 조건 경로가 되돌린다
  const sub: Expr = { op: 'substitute',
    inner: { op: 'substitute', inner: { op: 'cell', ref: 'A9' },
             find: { op: 'str', v: '~' }, replace: { op: 'str', v: '~~' } },
    find: { op: 'str', v: '*' }, replace: { op: 'str', v: '~*' } };
  assert.equal(execute(sub, ctx), '~* 광공업(BC)');
  assert.equal(execute(T(sub), ctx), 7);     // 와일드카드가 아니라 문자 그대로 맞는다
});

// ── 갈래 4: 문자 연결 조건 ───────────────────────────────────────────────────

test('문자 연결 조건 $B$6&"08": part1_6!p104 참고박스!D11 = 3205', () => {
  assertMatches('part1_6', 'p104 참고박스', 'D11', 3205);
});

test('문자 연결 조건은 문자로 맞힌다 (prd_de 는 TEXT 열이다)', () => {
  const db = openDb(':memory:');
  loadJsonl(db, 'kosis', 'T', [JSON.stringify({ PRD_DE: '202508', C2_NM: 'x', DT: 3 })]);
  const ctx = { db, grids: { p1: { B6: 2025 } as Grid }, sheet: 'p1' };
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'expr',
      e: { op: 'concat', args: [{ op: 'cell', ref: 'B6' }, { op: 'str', v: '08' }] } } } } };
  assert.equal(execute(e, ctx), 3);
});

// 실측 2건: TEXT($A8,"@") — "@" 는 엑셀의 텍스트 서식(값을 문자로 그대로)이고 연도
// 조건이 아니다. A8 에는 이스케이프되지 않은 `~` 가 들어 있다("…어업(01~03)") —
// 엑셀은 와일드카드가 아닌 `~` 를 문자로 보고, literalNeedle 도 그대로 둔다.
test('TEXT(셀,"@") 조건은 문자 조건이다: part1_3!p49!B8 = 1513.1', () => {
  const { oracle } = load('part1_3');
  assert.equal(oracle['p49'].A8, 'A 농업 임업 및 어업(01~03)');
  assertMatches('part1_3', 'p49', 'B8', 1513.1);
  assertMatches('part1_3', 'p49', 'B9', 4322.1);
});
