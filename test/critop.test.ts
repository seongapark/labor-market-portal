import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/query/execute.ts';
import { openDb, loadJsonl, loadGridJsonl } from '../src/db/load.ts';
import type { Expr, Grid } from '../src/types.ts';

// ── 전체 리뷰 F2 ────────────────────────────────────────────────────────────
// 엑셀 조건의 연산자를 **긴 것부터 정확히 끊어** 읽는지, 그리고 세 조건 경로
// (critSql=long 테이블 · gridCritSql=격자 · matchCrit=지면 범위)가 **같은 연산자 집합**을
// 읽는지 고정한다.
//
// 고치기 전 critSql 의 정규식은 `/^(<=|>=|<>|<|>)\s*(.+)$/` 였다. 우변이 빈 `"<>"` 에서
// `(.+)` 가 한 글자를 요구해 백트래킹이 일어나 **연산자 `<` · 우변 `'>'`** 로 갈렸다.
// 살아 있는 칸 `part1_2!p34!K33` 이 맞고 있던 이유는 `oecd_obs.value` 가 REAL 이고
// SQLite 가 숫자를 문자보다 앞에 정렬해 `value < '>'` 가 우연히 `value IS NOT NULL` 과
// 같아졌기 때문이다 — **TEXT 조건 열(모든 KOSIS 열)에서는 같은 조건이 조용히 0 을 낸다.**
// 같은 정규식은 `=` 접두 조건도 못 읽어 `'=계'` 를 리터럴 `'=계'` 로 찾았다(0행).

/** long 테이블(obs). 조건 열 c1_nm 은 **TEXT** 다 — 실패가 드러나는 자리다. */
function longDb() {
  const db = openDb(':memory:');
  loadJsonl(db, 'kosis', 'T1', [
    { PRD_DE: '2025', C1_NM: '계', DT: 10 },
    { PRD_DE: '2025', C1_NM: '남자', DT: 5 },
    { PRD_DE: '2025', C1_NM: 'OECD', DT: 7 },
    { PRD_DE: '2025', DT: 3 },                 // 조건 열이 빈 행 (NULL)
  ].map((x) => JSON.stringify(x)));
  return db;
}

/** 격자(grid). 3열이 「행 우주」를 주는 긍정 조건이다(COUNTIFS 가 전부 부정형이면 던진다). */
function gridDb() {
  const db = openDb(':memory:');
  loadGridJsonl(db, 'etc', 'S', [
    { r: 1, c: 1, v: '계' }, { r: 1, c: 2, v: 10 }, { r: 1, c: 3, v: '2025년' },
    { r: 2, c: 1, v: '남자' }, { r: 2, c: 2, v: 5 }, { r: 2, c: 3, v: '2025년' },
    { r: 3, c: 1, v: 'OECD' }, { r: 3, c: 2, v: 7 }, { r: 3, c: 3, v: '2025년' },
    /* 4행의 1열은 없다(빈 칸) */ { r: 4, c: 2, v: 3 }, { r: 4, c: 3, v: '2025년' },
  ].map((x) => JSON.stringify(x)));
  return db;
}

/** 지면 범위(matchCrit) — A 열이 라벨, B 열이 수치, A4 가 빈 칸이다. */
const pageGrid: Grid = {
  A1: '계', A2: '남자', A3: 'OECD', A4: null,
  B1: 10, B2: 5, B3: 7, B4: 3,
};

const lDb = longDb(), gDb = gridDb();

/** long 경로: 조건 열 하나로 세는 COUNTIFS */
function longCount(col: 'C1_NM' | 'DT', crit: string): number | string | null {
  const e: Expr = { op: 'countifs', q: { src: 'kosis', table: 'T1', value: 'DT',
    where: { PRD_DE: { kind: 'lit', value: '2025' }, [col]: { kind: 'lit', value: crit } } } };
  return execute(e, { db: lDb, grids: {}, sheet: 'p1' });
}

/** 격자 경로: 3열('2025년')로 행 우주를 주고 대상 열에 조건을 건다 */
function gridCount(col: 1 | 2, crit: string): number | string | null {
  const e: Expr = { op: 'countifs', q: { kind: 'grid', src: 'etc', sheet: 'S', valueCol: null,
    crits: [{ col: 3, crit: { kind: 'lit', value: '2025년' } },
            { col, crit: { kind: 'lit', value: crit } }] } };
  return execute(e, { db: gDb, grids: {}, sheet: 'p1' });
}

/** 지면 범위 경로: 위치를 맞춰 세는 범위 COUNTIFS(matchCrit) */
function rangeCount(col: 'A' | 'B', crit: string): number | string | null {
  const c1 = col === 'A' ? 1 : 2;
  const e: Expr = { op: 'rangecount', preds: [
    { kind: 'crit', range: { r1: 1, r2: 4, c1, c2: c1 }, crit: { op: 'str', v: crit } }] };
  return execute(e, { db: lDb, grids: { p1: pageGrid }, sheet: 'p1' });
}

test('F2: 우변이 빈 "<>" 는 「빈 칸이 아닌 것」이다 — TEXT 조건 열에서도', () => {
  // 라벨 4칸 중 빈 칸 하나를 뺀 3칸. 고치기 전 long 경로는 `c1_nm < '>'` 가 되어
  // 한글 라벨이 전부 '>' 보다 커서 **0** 을 냈다(조용한 0).
  assert.equal(longCount('C1_NM', '<>'), 3);
  // 격자·지면 범위 경로는 반대로 **빈 칸까지** 맞혔다(엑셀 반대) — 4 가 나왔다.
  assert.equal(gridCount(1, '<>'), 3);
  assert.equal(rangeCount('A', '<>'), 3);
});

test('F2: "=값" 접두 조건을 세 경로가 모두 읽는다', () => {
  // 고치기 전 long 경로는 리터럴 `'=계'` 를 찾아 0행이었다.
  assert.equal(longCount('C1_NM', '=계'), 1);
  assert.equal(gridCount(1, '=계'), 1);
  assert.equal(rangeCount('A', '=계'), 1);
  // 대소문자는 구별하지 않는다(RULING 13) — `=` 를 붙여도 같다
  assert.equal(longCount('C1_NM', '=oecd'), 1);
  assert.equal(gridCount(1, '=oecd'), 1);
  assert.equal(rangeCount('A', '=oecd'), 1);
});

test('F2: 세 경로가 같은 연산자 집합을 읽는다 — 수치 조건은 값까지 같다', () => {
  // 10 · 5 · 7 · 3 네 칸에 대한 기대값. `=`·`<>`·`>=`·`<=`·`>`·`<` 여섯 개를
  // **긴 것부터** 끊어 읽어야 나오는 수다. 한 경로만 어긋나면 이 표가 빨강이 된다.
  const want: [string, number][] = [
    ['>6', 2], ['> 6', 2], ['>=7', 2], ['<=5', 2], ['<5', 1],
    ['=5', 1], ['5', 1], ['<>5', 3], ['<>', 4],
  ];
  for (const [crit, n] of want) {
    assert.equal(longCount('DT', crit), n, `long ${crit}`);
    assert.equal(gridCount(2, crit), n, `grid ${crit}`);
    assert.equal(rangeCount('B', crit), n, `range ${crit}`);
  }
});

// 세 경로의 **남은 차이**를 시험으로 고정한다 — 의미를 통일하지 못한 한 지점이다.
// 엑셀의 `"<>값"` 은 **빈 칸도 맞힌다**(빈 칸은 그 값이 아니므로). 격자·지면 범위는
// 그렇게 동작하지만, long 테이블에서는 `col != '값'` 이 NULL 행을 떨어뜨린다.
// 실측 노출 0건이라 고치지 않았다: 이 조건을 쓰는 칸은 `<>OECD` 2건뿐이고 그 열
// (oecd_obs.REF_AREA)에는 NULL 이 없다(직접 확인). 없는 일반성을 만들지 않는다.
test('F2: "<>값" 의 빈 칸 처리는 경로마다 다르다 (기록된 차이)', () => {
  assert.equal(longCount('C1_NM', '<>OECD'), 2);    // NULL 행이 빠진다
  assert.equal(gridCount(1, '<>OECD'), 3);          // 빈 칸도 든다 (엑셀)
  assert.equal(rangeCount('A', '<>OECD'), 3);       // 빈 칸도 든다 (엑셀)
  // 짝 조건 `"="`(우변이 빈 것) = 「빈 칸인 것」. 빈 칸을 **셀 수 있는** 경로는 지면
  // 범위뿐이다 — long 테이블과 격자에는 빈 칸의 행이 아예 없다(적재 때 버렸고,
  // KOSIS 조건 열에 빈 문자열이 없다는 것은 RULING 18 에서 실측으로 확인했다).
  assert.equal(rangeCount('A', '='), 1);
  assert.equal(longCount('C1_NM', '='), 0);
  assert.equal(gridCount(1, '='), 0);
});
