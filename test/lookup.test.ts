import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFormula } from '../src/cellmap/parse.ts';
import { execute } from '../src/query/execute.ts';
import { makeAnchorCtx, ANCHOR_SEAT } from '../src/query/anchor.ts';
import { openDb, loadGridJsonl } from '../src/db/load.ts';
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

/** verifyPart 와 같은 경로로 한 칸만 계산한다 */
function cell(part: string, sheet: string, ref: string) {
  const { dump, oracle } = load(part);
  const formula = dump.sheets[sheet]?.[ref];
  assert.ok(formula, `${part}!${sheet}!${ref} 에 수식이 없다`);
  const e = parseFormula(formula, { extmap: dump.extmap, headers });
  const anchor = makeAnchorCtx(dump.sheets, 2025, oracle[ANCHOR_SEAT.sheet]?.[ANCHOR_SEAT.ref]);
  const got = execute(e, { db: realDb, grids: oracle as Record<string, Grid>, sheet, anchor });
  return { e, got, want: oracle[sheet][ref], formula };
}

/** 확정본과 같은지 — 관문과 같은 판정기(sameValue)를 쓴다 */
function assertMatches(part: string, sheet: string, ref: string, want?: string | number) {
  const r = cell(part, sheet, ref);
  if (want !== undefined) assert.equal(r.want, want, `확정본이 바뀌었다: ${part}!${sheet}!${ref}`);
  assert.ok(sameValue(r.want, r.got),
    `${part}!${sheet}!${ref} ${r.formula}\n  확정본 ${JSON.stringify(r.want)} / 계산 ${JSON.stringify(r.got)}`);
  return r;
}

// ── 갈래 A: 격자의 셀 하나를 좌표로 읽는다 ───────────────────────────────────

test('직접 셀: part1_2!p35!A31 = [2]p35!J5 → "서울특별시"', () => {
  assertMatches('part1_2', 'p35', 'A31', '서울특별시');
});

test('격자 셀들로 산술: part1_2!p35!C31 (% 포함)', () => {
  assertMatches('part1_2', 'p35', 'C31', 0.4973864883248717);
});

test('NUMBERVALUE + 격자: part1_5!p83!D24 → "32,646" 이 32646 이 된다', () => {
  assertMatches('part1_5', 'p83', 'D24', 32646);
});

test('패널 격자도 같은 경로로 읽는다: part2_1청년여성!p161!C11', () => {
  assertMatches('part2_1청년여성', 'p161', 'C11', '대기업');
});

// 실측(28건 전수 확인): =[1]청년패널!A11:B11 은 범위지만 값 하나가 기대된다.
// 확정본과 맞는 규칙은 **범위의 첫 칸**이고, 그 칸이 비어 있으면 **0** 이다(엑셀에서
// 빈 칸 참조는 0 이다). 28건 전부 이 규칙으로 확정본과 같았다 — 추측이 아니다.
test('암시적 교차: part2_1청년여성!p161!A11 — 첫 칸이 비면 0 이다', () => {
  const r = assertMatches('part2_1청년여성', 'p161', 'A11', 0);
  assert.equal(r.got, 0);
  // 그 칸이 격자에 아예 없다는 것을 함께 고정한다 (0 이 "빈 칸" 에서 왔다는 증거)
  const row = realDb.prepare('SELECT COUNT(*) n FROM grid WHERE src=? AND sheet=? AND r=? AND c=?')
    .get('panel', '청년패널', 11, 1) as { n: number };
  assert.equal(row.n, 0);
});

test('격자가 없는 원천(kosis·oecd)의 좌표 참조는 사유를 바꿔 남긴다', () => {
  const e = parseFormula("=[1]DT_1DA7012S!$A$5", { extmap: { '1': 'KOSIS_원데이터.xlsx' }, headers });
  assert.equal(e.op, 'unsupported');
  assert.match((e as { reason: string }).reason, /격자가 없는 원천/);
});

test('앵커 한 칸을 그대로 읽는 지면 셀: part1_4(1)!p67!B1 = 2025', () => {
  assertMatches('part1_4(1)', 'p67', 'B1', 2025);
});

// ── 갈래 B: 외부 사각범위 조회 ───────────────────────────────────────────────

test('VLOOKUP + 셀 참조 열인덱스: part1_8!p128!C6 = 15449228', () => {
  assertMatches('part1_8', 'p128', 'C6', 15449228);
});

test('VLOOKUP 열 전체 범위: part1_5!p83!H24 = "경영행정"', () => {
  assertMatches('part1_5', 'p83', 'H24', '경영행정');
});

test('HLOOKUP + SUBSTITUTE(~ 이스케이프): part1_8!p129!C6 = 3000421', () => {
  assertMatches('part1_8', 'p129', 'C6', 3000421);
});

// 실측: '5~9인' 처럼 ~ 가 든 값은 SUBSTITUTE 가 '5~~9인' 으로 만든다. 엑셀은 조회에서
// ~~ 를 문자 ~ 로 읽으므로 격자의 '5~9인' 과 맞는다. 우리는 와일드카드를 쓰지 않으니
// 조회 직전에 이스케이프를 되돌린다 — 그 두 갈래를 같은 시트에서 함께 고정한다.
test('HLOOKUP: ~ 가 든 찾을값도 확정본과 같다 (part1_8!p129 의 다른 행)', () => {
  const { dump, oracle } = load('part1_8');
  let checked = 0;
  for (const [ref, formula] of Object.entries(dump.sheets['p129'])) {
    if (!formula.includes('HLOOKUP')) continue;
    const m = /SUBSTITUTE\(\$(B\d+)/.exec(formula);
    if (!m) continue;
    const needle = oracle['p129'][m[1]];
    if (typeof needle !== 'string' || !needle.includes('~')) continue;
    assertMatches('part1_8', 'p129', ref);
    checked++;
  }
  assert.ok(checked > 0, '~ 가 든 찾을값 사례를 못 찾았다');
});

test('LEFT(VLOOKUP(...),7): part1_7!p124!D6 은 문자 "294,525" 다', () => {
  const r = assertMatches('part1_7', 'p124', 'D6', '294,525');
  assert.equal(typeof r.got, 'string');
  // 단위 8 리뷰 지적 3: 완화를 넓히지 않았다는 것을 함께 고정한다
  assert.equal(sameValue('294,525', 294525), false);
});

test('RIGHT(VLOOKUP(...),n): part1_7!p124 의 RIGHT 셀이 확정본과 같다', () => {
  const { dump } = load('part1_7');
  const ref = Object.entries(dump.sheets['p124']).find(([, f]) => f.startsWith('=RIGHT(VLOOKUP'))?.[0];
  assert.ok(ref, 'RIGHT(VLOOKUP(...)) 셀을 못 찾았다');
  assertMatches('part1_7', 'p124', ref!);
});

// ── 조회 의미: 합성 격자로 경계를 고정한다 ────────────────────────────────────

function fixture() {
  const db = openDb(':memory:');
  loadGridJsonl(db, 'etc', 'S', [
    { r: 1, c: 1, v: '구분' }, { r: 1, c: 2, v: 'A열' }, { r: 1, c: 3, v: 'B열' },
    { r: 2, c: 1, v: 'POP' }, { r: 2, c: 2, v: 10 }, { r: 2, c: 3, v: '십' },
    { r: 3, c: 1, v: '5~9인' }, { r: 3, c: 2, v: 20 },
    { r: 4, c: 1, v: '빈칸행' },
  ].map((x) => JSON.stringify(x)));
  return db;
}

const vlook = (needle: Expr, index: number, r2: number | null = 4): Expr => ({
  op: 'lookup', dir: 'v', needle, index: { op: 'const', v: index },
  range: { src: 'etc', sheet: 'S', c1: 1, c2: 3, r1: r2 === null ? null : 1, r2 },
});

test('VLOOKUP: 첫 열에서 정확히 찾아 n번째 열을 낸다 · 대소문자 무시', () => {
  const ctx = { db: fixture(), grids: {}, sheet: 'p1' };
  assert.equal(execute(vlook({ op: 'str', v: 'POP' }, 2), ctx), 10);
  assert.equal(execute(vlook({ op: 'str', v: 'pop' }, 2), ctx), 10);   // RULING 13
  assert.equal(execute(vlook({ op: 'str', v: 'PoP' }, 3), ctx), '십');
});

test('VLOOKUP: 못 찾으면 #N/A(null) 이고 IFERROR 가 받는다 — 0 이 아니다', () => {
  const ctx = { db: fixture(), grids: {}, sheet: 'p1' };
  const miss = vlook({ op: 'str', v: '없는값' }, 2);
  assert.equal(execute(miss, ctx), null);
  assert.equal(execute({ op: 'iferror', inner: miss, fallback: { op: 'str', v: '-' } }, ctx), '-');
  // 산술로 흘러도 0 으로 뭉개지 않는다
  assert.equal(execute({ op: 'add', args: [miss, { op: 'const', v: 1 }] }, ctx), null);
});

test('VLOOKUP: 찾은 행의 칸이 비어 있으면 0 이다 (엑셀)', () => {
  const ctx = { db: fixture(), grids: {}, sheet: 'p1' };
  assert.equal(execute(vlook({ op: 'str', v: '빈칸행' }, 2), ctx), 0);
});

test('VLOOKUP: ~ 이스케이프를 되돌려 문자 그대로 찾는다', () => {
  const ctx = { db: fixture(), grids: {}, sheet: 'p1' };
  const sub: Expr = { op: 'substitute', inner: { op: 'str', v: '5~9인' },
    find: { op: 'str', v: '~' }, replace: { op: 'str', v: '~~' } };
  assert.equal(execute(sub, ctx), '5~~9인');                       // SUBSTITUTE 는 정직하게
  assert.equal(execute(vlook(sub, 2), ctx), 20);                   // 조회는 이스케이프를 되돌린다
  assert.equal(execute(vlook({ op: 'str', v: '5~9인' }, 2), ctx), 20);
});

test('조회의 찾을값에 실제 와일드카드가 오면 던진다 — 있는 척하지 않는다', () => {
  const ctx = { db: fixture().valueOf() as never, grids: {}, sheet: 'p1' };
  assert.throws(() => execute(vlook({ op: 'str', v: 'P*' }, 2), ctx), /와일드카드/);
});

test('HLOOKUP: 첫 행에서 찾아 n번째 행을 낸다', () => {
  const ctx = { db: fixture(), grids: {}, sheet: 'p1' };
  const e: Expr = { op: 'lookup', dir: 'h', needle: { op: 'str', v: 'A열' },
    index: { op: 'const', v: 2 },
    range: { src: 'etc', sheet: 'S', c1: 1, c2: 3, r1: 1, r2: 4 } };
  assert.equal(execute(e, ctx), 10);
});

test('VLOOKUP 네 번째 인자가 1(근사)이면 unsupported 로 남는다', () => {
  const e = parseFormula('=VLOOKUP($B6,[2]p128!$T$7:$AD$39,2,1)',
    { extmap: { '2': '별도데이터.xlsx' }, headers });
  assert.equal(e.op, 'unsupported');
  assert.match((e as { reason: string }).reason, /네 번째 인자/);
});

// 단위 7 에서 이 갈래가 열렸다 — 같은 통합문서 범위는 지면 격자(ctx.grids)에서 찾는다.
// 그 자리의 옛 단정(「아직 unsupported」)을 사실대로 바꿔 둔다.
test('같은 통합문서 안에서 찾는 VLOOKUP 은 지면 격자 범위가 된다 (단위 7)', () => {
  const e = parseFormula('=VLOOKUP(F24,$A$24:$D$58,3,0)', { extmap: {}, headers });
  assert.equal(e.op, 'lookup');
  assert.deepEqual((e as { range: unknown }).range, { r1: 24, c1: 1, r2: 58, c2: 4 });
});

test('LEFT · RIGHT · SUBSTITUTE 는 문자로 다룬다', () => {
  const ctx = { db: fixture(), grids: {}, sheet: 'p1' };
  assert.equal(execute({ op: 'left', inner: { op: 'str', v: '294,525(70.6)' }, n: { op: 'const', v: 7 } }, ctx), '294,525');
  assert.equal(execute({ op: 'right', inner: { op: 'str', v: '2025년' }, n: { op: 'const', v: 2 } }, ctx), '5년');
  assert.equal(execute({ op: 'left', inner: { op: 'const', v: 2025 }, n: { op: 'const', v: 2 } }, ctx), '20');
  assert.equal(execute({ op: 'substitute', inner: { op: 'str', v: 'a-b-c' },
    find: { op: 'str', v: '-' }, replace: { op: 'str', v: '+' } }, ctx), 'a+b+c');
  // 오류는 그대로 흘려보낸다
  assert.equal(execute({ op: 'left', inner: { op: 'div', a: { op: 'const', v: 1 }, b: { op: 'const', v: 0 } }, n: { op: 'const', v: 2 } }, ctx), null);
});
