import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseFormula } from '../src/cellmap/parse.ts';
import { specOf } from '../src/cellmap/build.ts';
import { execute } from '../src/query/execute.ts';
import { makeAnchorCtx, makeAnchorCtxFromMap, ANCHOR_SEAT } from '../src/query/anchor.ts';
import { sameValue } from '../src/verify/compare.ts';
import type { CellMap, Expr, Grid, Headers } from '../src/types.ts';

// Task 9 단위 13 — **정렬 수식을 계산 경로에 넣는다.**
//
// OECD 부록(p214~p240)은 값 크기로 **정렬된** 표다. 그 정렬을 상수로 동결하면 원데이터가
// 바뀌어도 순서가 그대로 남는다 — 그래서 정렬을 계산해야 한다. 그런데 그 수식
// (시트 수식어 붙은 INDEX/MATCH · RANK · COUNTIF · ROW)을 **판정 경로**에 넣으면
// presentation 3,364칸이 재파싱되어 판정 범주가 무너진다(단위 7 이 `mustRange` 로 막았다).
//
// 그래서 이 단위는 두 경로를 가른다: 파서에 **계산 전용 모드**(`ParseCtx.compute`)를 두고,
// cellmap 항목이 `kind:'presentation'` 을 유지하면서 계산용 `e` 를 함께 담는다.
// 관문은 `e` 를 보지 않는다(`spec.kind !== 'expr'` 로 빠진다). 계산기만 쓴다.

const headers = JSON.parse(readFileSync(join('data', 'raw', 'headers.json'), 'utf8')) as Headers;
const realDb = new DatabaseSync(join('data', 'obs.sqlite'), { readOnly: true });

// ── 1. 실행기: RANK · COUNTIF · ROW ─────────────────────────────────────────

const grid: Grid = {
  A1: 10, A2: 30, A3: 20, A4: 30, A5: 'OECD', A6: null,
  B1: 5, B2: 5, B3: 5,
};
const ctx = (ref?: string) => ({ db: realDb, grids: { p1: grid }, sheet: 'p1', ref });
const R = (r1: number, r2: number, c = 1) => ({ r1, c1: c, r2, c2: c });

test('RANK: 엑셀 기본은 내림차순이고 같은 값은 같은 순위다', () => {
  const c = ctx();
  const rank = (n: number): Expr => ({ op: 'rank', x: { op: 'const', v: n }, range: R(1, 6) });
  assert.equal(execute(rank(30), c), 1);      // 최대값 — 동순위 둘
  assert.equal(execute(rank(20), c), 3);      // 30 두 개 뒤 → 3 (2 가 아니다)
  assert.equal(execute(rank(10), c), 4);
});

test('RANK: 범위에 없는 값은 #N/A(null) 다 — 0 이나 근사값이 아니다', () => {
  const c = ctx();
  assert.equal(execute({ op: 'rank', x: { op: 'const', v: 15 }, range: R(1, 6) }, c), null);
  // 문자·빈 칸은 순위에서 빠진다(엑셀). 문자를 찾으면 #N/A 다.
  assert.equal(execute({ op: 'rank', x: { op: 'str', v: 'OECD' }, range: R(1, 6) }, c), null);
});

test('COUNTIF: 단일 조건을 범위에 적용해 센다 · 조건이 셀 값이면 같은 값을 센다', () => {
  const c = ctx();
  const cif = (crit: Expr, r2 = 6): Expr => ({ op: 'countif', range: R(1, r2), crit });
  assert.equal(execute(cif({ op: 'const', v: 30 }), c), 2);
  assert.equal(execute(cif({ op: 'str', v: '>15' }), c), 3);      // 30 · 20 · 30
  assert.equal(execute(cif({ op: 'str', v: 'OECD' }), c), 1);
  assert.equal(execute(cif({ op: 'cell', ref: 'A2' }), c), 2);    // A2=30 → 30 이 둘
});

test('COUNTIF: 자기 행까지 자라는 부분 범위가 동순위를 펼친다 (RANK+COUNTIF-1 관용구)', () => {
  const c = ctx();
  // B1:B3 은 전부 5 다. RANK 는 셋 다 1 을 내고, COUNTIF 가 1·2·3 을 내서
  // 최종 순위가 1·2·3 으로 펼쳐진다 — 그것이 이 관용구의 전부다.
  const idiom = (row: number): Expr => ({
    op: 'sub',
    a: { op: 'add', args: [
      { op: 'rank', x: { op: 'cell', ref: `B${row}` }, range: R(1, 3, 2) },
      { op: 'countif', range: R(1, row, 2), crit: { op: 'cell', ref: `B${row}` } },
    ] },
    b: { op: 'const', v: 1 },
  });
  assert.equal(execute(idiom(1), c), 1);
  assert.equal(execute(idiom(2), c), 2);
  assert.equal(execute(idiom(3), c), 3);
});

test('COUNTIF·RANK: 부동소수 꼬리가 있어도 자기 자신을 센다 (관용구가 기대는 전부)', () => {
  // 0.1+0.2 는 0.30000000000000004 다. 이 값이 든 칸을 그 값으로 세지 못하면
  // 관용구의 자기 카운트가 0 이 되어 순위가 통째로 1 밀린다. 비교하는 두 쪽이 **같은 칸**
  // 이라 허용오차 없이 정확히 같다 — 그래서 오차범위를 두지 않았다(두면 엑셀이 만들지
  // 않는 동순위를 우리가 만든다).
  const g: Grid = { A1: 0.1 + 0.2, A2: 0.3 };
  const c = { db: realDb, grids: { p1: g }, sheet: 'p1' };
  assert.equal(execute({ op: 'countif', range: R(1, 2), crit: { op: 'cell', ref: 'A1' } }, c), 1);
  assert.equal(execute({ op: 'rank', x: { op: 'cell', ref: 'A1' }, range: R(1, 2) }, c), 1);
  // 0.3 은 0.30000000000000004 보다 작다 — 엑셀도 두 값을 구별한다
  assert.equal(execute({ op: 'rank', x: { op: 'cell', ref: 'A2' }, range: R(1, 2) }, c), 2);
});

test('ROW(): 인자가 없으면 자기 행이다 · 인자가 있으면 그 참조의 행이다', () => {
  assert.equal(execute({ op: 'row' }, ctx('A6')), 6);
  assert.equal(execute({ op: 'row' }, ctx('AB123')), 123);
  assert.equal(execute({ op: 'row', r: 41 }, ctx()), 41);
});

test('ROW(): 자기 행을 모르면 던진다 — 조용히 0 을 내지 않는다', () => {
  assert.throws(() => execute({ op: 'row' }, ctx()), /자기 행/);
});

// ── 2. 파서: 판정 경로는 그대로, 계산 경로만 넓힌다 ─────────────────────────

const gateCtx = { extmap: {}, headers };
const computeCtx = { extmap: {}, headers, compute: true as const };

test('판정 경로: 시트 수식어 붙은 INDEX/MATCH 는 여전히 표현 거부다 (mustRange 유지)', () => {
  const e = parseFormula('=INDEX(_정렬기준!$A$3:$A$41,MATCH(ROW()-5,_정렬기준!$CA$3:$CA$41,0))', gateCtx);
  assert.equal(e.op, 'unsupported');
  assert.equal((e as { presentation?: true }).presentation, true);
});

test('판정 경로: RANK·COUNTIF·ROW 는 여전히 파싱되지 않는다', () => {
  for (const f of ['=RANK(A1,$A$1:$A$9)', '=COUNTIF($A$1:A5,A5)', '=ROW()-5']) {
    assert.equal(parseFormula(f, gateCtx).op, 'unsupported', f);
  }
  // RANK 만 표현 거부 표식을 싣는다(단위 7·전체 리뷰 F1 의 판정). 나머지는 그냥 미지원이다.
  assert.equal((parseFormula('=RANK(A1,$A$1:$A$9)', gateCtx) as { presentation?: true }).presentation, true);
  assert.equal((parseFormula('=COUNTIF($A$1:A5,A5)', gateCtx) as { presentation?: true }).presentation, undefined);
});

test('계산 경로: 같은 수식이 식으로 파싱된다', () => {
  const a = parseFormula('=INDEX(_정렬기준!$A$3:$A$41,MATCH(ROW()-5,_정렬기준!$CA$3:$CA$41,0))', computeCtx);
  assert.equal(a.op, 'index');
  const b = parseFormula('=RANK(C3,$C$3:$C$41)+COUNTIF($C$3:C3,C3)-1', computeCtx);
  assert.equal(b.op, 'sub');
  const c = parseFormula("=INDEX('p214'!$G$6:$G$43,MATCH($A3,'p214'!$A$6:$A$43,0))", computeCtx);
  assert.equal(c.op, 'index');
  assert.equal((c as Extract<Expr, { op: 'index' }>).range.sheet, 'p214');
});

test('계산 경로: RANK 의 세 번째 인자는 0(내림차순)만 받는다 — 없는 뜻을 만들지 않는다', () => {
  assert.equal(parseFormula('=RANK(C3,$C$3:$C$41,0)', computeCtx).op, 'rank');
  const up = parseFormula('=RANK(C3,$C$3:$C$41,1)', computeCtx);
  assert.equal(up.op, 'unsupported');
  assert.match((up as { reason: string }).reason, /세 번째 인자/);
});

test('계산 경로: MATCH 의 세 번째 인자는 여전히 0 만 받는다', () => {
  const e = parseFormula('=MATCH($A6,_13개국!$A$6:$A$43,1)', computeCtx);
  assert.equal(e.op, 'unsupported');
  assert.match((e as { reason: string }).reason, /세 번째 인자/);
});

test('계산 경로: 못 찾은 MATCH 는 #N/A(null) 다 — 0 이 아니다', () => {
  const e = parseFormula('=MATCH("없는나라",$A$1:$A$6,0)', computeCtx);
  assert.equal(execute(e, ctx()), null);
});

// ── 3. cellmap: presentation 이 kind·reason 을 지키면서 계산용 e 를 싣는다 ──

test('명세: presentation 은 kind·reason 이 그대로이고 계산용 e 를 함께 담는다', () => {
  const ctxB = { extmap: { '1': '별도데이터.xlsx' }, headers };
  const s = specOf('=RANK(A1,$A$1:$A$9)', ctxB);
  assert.equal(s.kind, 'presentation');
  assert.equal(s.reason, '못 다루는 함수: RANK');           // 한 글자도 달라지지 않는다
  assert.ok('e' in s && s.e, 'presentation 에 계산용 e 가 없다');
  const s2 = specOf("=INDEX('p214'!$B$48:$B$60,MATCH($A48,'p214'!$A$48:$A$60,0))", ctxB);
  assert.equal(s2.kind, 'presentation');
  assert.ok('e' in s2 && s2.e);
});

test('명세: unsupported 에는 e 를 달지 않는다 — 계산 경로가 관문의 빚을 가리지 않는다', () => {
  const ctxB = { extmap: { '1': '별도데이터.xlsx' }, headers };
  const s = specOf('=MATCH($A6,$A$6:$A$43,1)', ctxB);
  assert.equal(s.kind, 'unsupported');
  assert.equal('e' in s, false);
});

// ── 4. 실데이터: 정렬이 원데이터에서 계산된다 ───────────────────────────────

type FormulaDump = { extmap: Record<string, string>; sheets: Record<string, Record<string, string>> };
type OracleDump = Record<string, Record<string, string | number>>;
const dump = JSON.parse(readFileSync(join('data', 'formulas', 'part3.json'), 'utf8')) as FormulaDump;
const oracle = JSON.parse(readFileSync(join('data', 'oracle', 'part3.json'), 'utf8')) as OracleDump;

/** part3 의 셀 하나를 **계산 모드로** 파싱해 실행한다. 의존 칸은 확정본 격자에서
    읽는다 — 여기서 확인하는 것은 「정렬 수식 자체가 인쇄된 값을 내는가」다.
    (확정본을 읽지 않는 전 파이프라인 대조는 `scripts/compare-computed.mjs` 가 한다.) */
function computeCell(sheet: string, ref: string) {
  const formula = dump.sheets[sheet]?.[ref];
  assert.ok(formula, `part3!${sheet}!${ref} 에 수식이 없다`);
  const e = parseFormula(formula, { extmap: dump.extmap, headers, compute: true });
  assert.notEqual(e.op, 'unsupported', `계산 모드에서도 파싱되지 않는다: ${formula}`);
  const anchor = makeAnchorCtx(dump.sheets, 2025, oracle[ANCHOR_SEAT.sheet]?.[ANCHOR_SEAT.ref]);
  const got = execute(e, { db: realDb, grids: oracle as Record<string, Grid>, sheet, ref, anchor });
  return { got, want: oracle[sheet][ref], formula };
}

function assertComputes(sheet: string, ref: string, want: string | number) {
  const r = computeCell(sheet, ref);
  assert.equal(r.want, want, `확정본이 바뀌었다: part3!${sheet}!${ref}`);
  assert.ok(sameValue(r.want, r.got),
    `part3!${sheet}!${ref} ${r.formula}\n  확정본 ${JSON.stringify(r.want)} / 계산 ${JSON.stringify(r.got)}`);
}

test('정렬 순위: part3!_정렬기준!D3 = 21 (RANK+COUNTIF, 39개국 중 그리스)', () => {
  assertComputes('_정렬기준', 'D3', 21);
});

test('정렬 결과: part3!p214!A6 = "미국" (INDEX/MATCH + ROW(), 시트 수식어 붙은 범위)', () => {
  assertComputes('p214', 'A6', '미국');
});

test('정렬 결과: part3!p214!A43 = "아이슬란드" (꼴찌 — 동순위 펼치기가 맞아야 나온다)', () => {
  assertComputes('p214', 'A43', '아이슬란드');
});

test('13개국 표: part3!_13개국!B3 · D3 (지면 값을 국가명으로 끌어와 순위)', () => {
  assertComputes('_13개국', 'B3', 35250.42);
  assertComputes('_13개국', 'D3', 9);
});

test('13개국 정렬 결과: part3!p214!A48 = "미국"', () => {
  assertComputes('p214', 'A48', '미국');
});

// ── 5. 전건: 물화된 cellmap 의 presentation 이 전부 계산되고 인쇄본과 같다 ───

test('물화: presentation 5,132칸 전부가 계산용 e 를 싣고 있다', () => {
  let presentation = 0, withE = 0;
  for (const f of readdirSync(join('data', 'cellmap'))) {
    if (!f.endsWith('.json')) continue;
    const m = JSON.parse(readFileSync(join('data', 'cellmap', f), 'utf8')) as CellMap;
    for (const cells of Object.values(m.sheets)) {
      for (const spec of Object.values(cells)) {
        if (spec.kind !== 'presentation') continue;
        presentation++;
        if (spec.e) withE++;
      }
    }
  }
  // 하나라도 e 를 잃으면 그 지면의 정렬이 계산 경로에서 빈칸이 된다 — 조용히 「-」가 찍힌다.
  assert.equal(presentation, 5132);
  assert.equal(withE, 5132);
});

test('전건: presentation 의 정렬 결과가 인쇄된 값과 같다 (지면 3,364 · 보조시트 1,768)', () => {
  // 관문은 이 칸들을 대조하지 않는다(구현하지 않기로 정한 범주다). 그래서 「정렬을
  // 계산하기로」 한 이 단위는 **따로** 증명해야 한다: 인쇄된 입력을 주면 인쇄된 순서가
  // 나오는가. (원데이터만으로 같은 값이 나오는가는 `scripts/compare-computed.mjs` 가
  // 전 파이프라인으로 본다 — 여기서 확정본을 격자로 쓰는 것은 정렬 논리만 떼어 보기
  // 위해서다.)
  //
  // **보조시트를 함께 세는 이유**: 지면 칸은 INDEX/MATCH/ROW 뿐이고, 정렬 순위표
  // (`_정렬기준!D` 등)를 확정본에서 읽어 온다 — 그래서 지면만 보면 RANK·COUNTIF 가
  // 한 번도 돌지 않는다(변이 확인에서 「COUNTIF 가 언제나 1」이 지면 시험을 통과했다).
  // RANK+COUNTIF 관용구는 보조시트에 있고, 거기에 동순위가 몰려 있다(값이 "-" 인 나라가
  // 전부 -9.99E+307 로 묶인다).
  const n: Record<string, number> = { 지면: 0, 보조: 0 };
  const bad: string[] = [];
  for (const f of readdirSync(join('data', 'cellmap'))) {
    if (!f.endsWith('.json')) continue;
    const part = basename(f, '.json');
    const m = JSON.parse(readFileSync(join('data', 'cellmap', f), 'utf8')) as CellMap;
    const o = JSON.parse(readFileSync(join('data', 'oracle', f), 'utf8')) as OracleDump;
    const anchor = makeAnchorCtxFromMap(m, 2025, o[ANCHOR_SEAT.sheet]?.[ANCHOR_SEAT.ref]);
    for (const [sheet, cells] of Object.entries(m.sheets)) {
      for (const [ref, spec] of Object.entries(cells)) {
        if (spec.kind !== 'presentation' || !spec.e) continue;
        const want = o[sheet]?.[ref];
        if (want === undefined) continue;              // 확정본에 값 없음 — 관문도 제외한다
        n[sheet.startsWith('_') ? '보조' : '지면']++;
        let got: string | number | null = null;
        try {
          got = execute(spec.e, { db: realDb, grids: o as Record<string, Grid>, sheet, ref, anchor });
        } catch (err) {
          bad.push(`${part}!${sheet}!${ref}: 던졌다 — ${(err as Error).message}`);
          continue;
        }
        if (!sameValue(want, got)) {
          bad.push(`${part}!${sheet}!${ref}: 확정본 ${JSON.stringify(want)} / 계산 ${JSON.stringify(got)}`);
        }
      }
    }
  }
  assert.deepEqual(bad.slice(0, 10), []);
  // 지면 수는 관문이 세는 presentation 과 같아야 한다 — 범위가 어긋나면 이 시험이
  // 「무엇을 증명했는가」가 흐려진다.
  assert.equal(n.지면, 3364);
  assert.equal(n.보조, 1768);
});
