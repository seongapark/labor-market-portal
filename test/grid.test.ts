import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFormula, colNumber, wholeColumn } from '../src/cellmap/parse.ts';
import { execute } from '../src/query/execute.ts';
import { makeAnchorCtx, ANCHOR_SEAT } from '../src/query/anchor.ts';
import { openDb, loadGridJsonl } from '../src/db/load.ts';
import type { Expr, Grid, Headers } from '../src/types.ts';

const headers = JSON.parse(readFileSync(join('data', 'raw', 'headers.json'), 'utf8')) as Headers;

/** 실제 데이터는 읽기전용으로만 연다 — 214MB 를 건드리지 않는다 */
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

/** verifyPart 와 같은 경로로 한 칸만 계산한다 (관문과 같은 컨텍스트) */
function cell(part: string, sheet: string, ref: string) {
  const { dump, oracle } = load(part);
  const formula = dump.sheets[sheet]?.[ref];
  assert.ok(formula, `${part}!${sheet}!${ref} 에 수식이 없다`);
  const e = parseFormula(formula, { extmap: dump.extmap, headers });
  const anchor = makeAnchorCtx(dump.sheets, 2025, oracle[ANCHOR_SEAT.sheet]?.[ANCHOR_SEAT.ref]);
  const got = execute(e, { db: realDb, grids: oracle as Record<string, Grid>, sheet, anchor });
  return { e, got, want: oracle[sheet][ref], formula };
}

// ── 7. 열 문자 → 열 번호 (grid.c 는 1-based) ─────────────────────────────────

test('열 문자 → 열 번호: A→1 · C→3 · P→16 · AA→27', () => {
  assert.equal(colNumber('A'), 1);
  assert.equal(colNumber('C'), 3);
  assert.equal(colNumber('P'), 16);
  assert.equal(colNumber('AA'), 27);
  assert.equal(colNumber('AB'), 28);
});

test('열 전체 참조만 열 번호로 옮긴다 — 부분 범위는 던진다', () => {
  assert.equal(wholeColumn('$B:$B'), 2);
  assert.equal(wholeColumn('C:C'), 3);
  assert.equal(wholeColumn('$P:$P'), 16);
  // 부분 범위를 조용히 첫 열로 뭉개면 행 범위를 무시한 틀린 답이 나온다 — 던져야 한다
  assert.throws(() => wholeColumn('$A$9:$E$25'), /열 전체/);
  assert.throws(() => wholeColumn('$B$2'), /열 전체/);
  assert.throws(() => wholeColumn('$A:$C'), /열 전체/);
});

// ── 1~4. 실제 좌표가 확정본과 같다 ────────────────────────────────────────────

test('단일 조건 SUMIFS: part1_4(1)!p64!B5 = 2620695', () => {
  const r = cell('part1_4(1)', 'p64', 'B5');
  assert.equal(r.want, 2620695);
  assert.equal(r.got, r.want);
});

test('두 조건 + NUMBERVALUE: part1_5!p78,79!B16 = 46804', () => {
  const r = cell('part1_5', 'p78,79', 'B16');
  assert.equal(r.want, 46804);
  assert.equal(r.got, r.want);
});

test('지면 셀을 조건으로(시트 한정 참조): part1_7!p116_117!C30 = 877', () => {
  const r = cell('part1_7', 'p116_117', 'C30');
  assert.equal(r.want, 877);
  assert.equal(r.got, r.want);
});

test('COUNTIFS + ">0" + 나눗셈: part3!p239!B23(OECD 평균) 과 B6(나라) 이 확정본과 같다', () => {
  // A23 = "OECD" → SUMIFS/COUNTIFS(">0")/1000 갈래
  const avg = cell('part3', 'p239', 'B23');
  assert.equal(avg.want, 102.00335805555555);
  assert.equal(avg.got, avg.want);
  // A6 = "아일랜드" → 나라 갈래 (SUMIFS/1000)
  const one = cell('part3', 'p239', 'B6');
  assert.equal(one.want, 193.4032);
  assert.equal(one.got, one.want);
});

test('COUNTIFS + "<>" 조건: part3!p240!B50 이 확정본과 같다', () => {
  const r = cell('part3', 'p240', 'B50');
  assert.equal(r.want, 160.8187);
  assert.equal(r.got, r.want);
});

// ── 5~6. 엑셀 의미 ───────────────────────────────────────────────────────────

function fixture() {
  const db = openDb(':memory:');
  // (r, c, v) — 1행은 머리글처럼 생긴 텍스트, 2~4행이 자료다.
  loadGridJsonl(db, 'etc', 'S', [
    { r: 1, c: 1, v: '구분' }, { r: 1, c: 2, v: '값' },
    { r: 2, c: 1, v: 'POP' }, { r: 2, c: 2, v: 10 }, { r: 2, c: 3, v: '2025년' },
    { r: 3, c: 1, v: 'pop' }, { r: 3, c: 2, v: 5 }, { r: 3, c: 3, v: '2025년' },
    { r: 4, c: 1, v: 'ETC' }, { r: 4, c: 2, v: 7 }, { r: 4, c: 3, v: '2025년' },
    { r: 5, c: 1, v: '빈값행' }, { r: 5, c: 3, v: '2025년' },   // 값 칸(2열)이 없다
  ].map((x) => JSON.stringify(x)));
  return db;
}

const gq = (crit: string, agg: 'sumifs' | 'countifs' = 'sumifs'): Expr => ({
  op: agg,
  q: { kind: 'grid', src: 'etc', sheet: 'S', valueCol: agg === 'sumifs' ? 2 : null,
       crits: [{ col: 1, crit: { kind: 'lit', value: crit } }] },
});

test('RULING 13: 문자 조건은 대소문자를 구분하지 않는다', () => {
  const db = fixture();
  const ctx = { db, grids: {}, sheet: 'p1' };
  // POP(10) + pop(5) = 15 — 조건의 대소문자를 어떻게 써도 같다
  assert.equal(execute(gq('pop'), ctx), 15);
  assert.equal(execute(gq('POP'), ctx), 15);
  assert.equal(execute(gq('Pop'), ctx), 15);
  assert.equal(execute(gq('pop', 'countifs'), ctx), 2);
});

test('맞는 행이 없으면 SUMIFS 는 0 이다 (null 아니다)', () => {
  const db = fixture();
  const ctx = { db, grids: {}, sheet: 'p1' };
  const v = execute(gq('없는값'), ctx);
  assert.equal(v, 0);
  assert.notEqual(v, null);
  assert.equal(execute(gq('없는값', 'countifs'), ctx), 0);
});

test('값 칸이 비어 있으면 더하지 않는다 · 문자 칸은 무시한다', () => {
  const db = fixture();
  const ctx = { db, grids: {}, sheet: 'p1' };
  assert.equal(execute(gq('빈값행'), ctx), 0);       // 값 칸이 없다 → 0
  assert.equal(execute(gq('구분'), ctx), 0);          // 값 칸이 문자('값') → 더하지 않는다
});

test('비교 조건: ">" "<=" "<>" 를 열 번호로 옮긴다', () => {
  const db = fixture();
  const ctx = { db, grids: {}, sheet: 'p1' };
  const byValue = (crit: string, agg: 'sumifs' | 'countifs' = 'sumifs'): Expr => ({
    op: agg,
    q: { kind: 'grid', src: 'etc', sheet: 'S', valueCol: agg === 'sumifs' ? 2 : null,
         crits: [{ col: 2, crit: { kind: 'lit', value: crit } }] },
  });
  assert.equal(execute(byValue('>6'), ctx), 17);            // 10 + 7
  assert.equal(execute(byValue('>6', 'countifs'), ctx), 2);
  assert.equal(execute(byValue('<=5', 'countifs'), ctx), 1);
});

test('"<>" 는 빈 칸에도 맞는다 (엑셀 의미) — 긍정 조건과 함께 쓸 때', () => {
  const db = fixture();
  const ctx = { db, grids: {}, sheet: 'p1' };
  // 3열이 '2025년' 인 행은 2~5행. 그 중 2열이 10 이 아닌 행: 3행(5) · 4행(7) · 5행(빈 칸).
  const both = (agg: 'sumifs' | 'countifs'): Expr => ({
    op: agg,
    q: { kind: 'grid', src: 'etc', sheet: 'S', valueCol: agg === 'sumifs' ? 2 : null,
         crits: [
           { col: 3, crit: { kind: 'lit', value: '2025년' } },
           { col: 2, crit: { kind: 'lit', value: '<>10' } },
         ] },
  });
  assert.equal(execute(both('countifs'), ctx), 3);   // 빈 칸도 "10 이 아니다"에 든다
  assert.equal(execute(both('sumifs'), ctx), 12);    // 5 + 7 (빈 칸은 0)
});

test('COUNTIFS 조건이 전부 부정형이면 던진다 — 셀 우주를 모른다', () => {
  const db = fixture();
  const e: Expr = { op: 'countifs',
    q: { kind: 'grid', src: 'etc', sheet: 'S', valueCol: null,
         crits: [{ col: 1, crit: { kind: 'lit', value: '<>pop' } }] } };
  assert.throws(() => execute(e, { db, grids: {}, sheet: 'p1' }), /부정형|우주/);
});

// ── 0으로 나누기는 기존 오류 전파 경로를 탄다 (단위 4) ────────────────────────

test('COUNTIFS 가 0 이면 나눗셈이 오류가 되고 IFERROR 가 받는다 — 조용히 0 이 되지 않는다', () => {
  const db = fixture();
  const ctx = { db, grids: {}, sheet: 'p1' };
  const zero: Expr = { op: 'countifs',
    q: { kind: 'grid', src: 'etc', sheet: 'S', valueCol: null,
         crits: [{ col: 1, crit: { kind: 'lit', value: '없는값' } }] } };
  const div: Expr = { op: 'div', a: { op: 'const', v: 100 }, b: zero };
  assert.equal(execute(div, ctx), null);                                  // #DIV/0!
  assert.equal(execute({ op: 'iferror', inner: div, fallback: { op: 'str', v: '-' } }, ctx), '-');
});

// ── 파싱: 별도데이터 범위는 열 번호 질의가 된다 ───────────────────────────────

test('parseFormula: 별도데이터 SUMIFS 는 열 번호 격자 질의가 된다', () => {
  const { dump } = load('part1_4(1)');
  const e = parseFormula(dump.sheets['p64']['B5'], { extmap: dump.extmap, headers });
  assert.equal(e.op, 'sumifs');
  assert.deepEqual((e as { q: unknown }).q, {
    kind: 'grid', src: 'etc', sheet: 'p64', valueCol: 2,
    crits: [{ col: 1, crit: { kind: 'cell', ref: 'B4' } }],
  });
});

test('parseFormula: 시트 한정 조건 참조는 Crit 에 시트가 실린다', () => {
  const { dump } = load('part1_7');
  const e = parseFormula(dump.sheets['p116_117']['C30'], { extmap: dump.extmap, headers });
  assert.deepEqual((e as { q: unknown }).q, {
    kind: 'grid', src: 'etc', sheet: 'p116_117', valueCol: 3,
    crits: [
      { col: 16, crit: { kind: 'cell', sheet: 'p116_117', ref: 'B30' } },
      { col: 1, crit: { kind: 'cell', ref: 'A30' } },
    ],
  });
});
