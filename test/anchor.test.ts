import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { anchorCell, type AnchorCtx } from '../src/query/anchor.ts';
import { tokenize } from '../src/cellmap/tokenize.ts';
import { execute } from '../src/query/execute.ts';
import type { Expr, Grid } from '../src/types.ts';

type FormulaDump = { extmap: Record<string, string>; sheets: Record<string, Record<string, string>> };
type OracleDump = Record<string, Record<string, string | number>>;

const ANCHOR_FORMULA = "='[1]0_수집현황'!$A$1";

function ctx(sheets: Record<string, Record<string, string>>, anchor = 2025): AnchorCtx {
  return { formulas: sheets, anchor };
}

// ── 규칙 1·3·4: 앵커 바닥값과 사슬 ────────────────────────────────────────────

test('앵커 참조 수식은 기준연도를 낸다 (유일한 바닥값)', () => {
  const ac = ctx({ _시계열: { B1: ANCHOR_FORMULA } });
  assert.equal(anchorCell(ac, '_시계열', 'B1'), 2025);
});

test('앵커 사슬을 거꾸로 타고 내려간다', () => {
  const ac = ctx({ _시계열: { B1: ANCHOR_FORMULA, Q5: '=B1', P5: '=Q5-1', O5: '=P5-1' } });
  assert.equal(anchorCell(ac, '_시계열', 'Q5'), 2025);
  assert.equal(anchorCell(ac, '_시계열', 'P5'), 2024);
  assert.equal(anchorCell(ac, '_시계열', 'O5'), 2023);
});

test('다른 시트의 셀도 푼다', () => {
  const ac = ctx({
    _시계열: { B1: ANCHOR_FORMULA, Q5: '=B1' },
    p8: { C6: '=_시계열!Q5', D6: '=C6+1' },
  });
  assert.equal(anchorCell(ac, 'p8', 'C6'), 2025);
  assert.equal(anchorCell(ac, 'p8', 'D6'), 2026);
});

test('수식이 없는 셀(통합문서의 리터럴)은 undefined 다 — 호출자가 격자로 떨어진다', () => {
  const ac = ctx({ _시계열: { B1: ANCHOR_FORMULA } });
  assert.equal(anchorCell(ac, '_시계열', 'B99'), undefined);
  assert.equal(anchorCell(ac, '없는시트', 'A1'), undefined);
});

// 리뷰 1차 정정: 이 시험이 묶는 것은 STRICT_GRIDS 가드가 아니라 **산술의 null 전파**다
// (단위 4 의 numOrErr). 그래서 이름을 사실대로 바꿨다 — 가드를 지운 뮤턴트에서도 이
// 시험은 통과한다. 가드를 묶는 시험은 바로 아래에 따로 있다.
test('산술은 못 푸는 셀을 null 로 전파한다 — =B4+5 를 5 로 뭉개지 않는다', () => {
  // B4 는 수식이 없다(리터럴). =B4+5 를 4+5 나 0+5 로 계산해 버리면 안 된다.
  const ac = ctx({ _시계열: { B1: ANCHOR_FORMULA }, p8: { G4: '=B4+5' } });
  assert.equal(anchorCell(ac, 'p8', 'G4'), undefined);
});

// 리뷰 [지적 1]: 앵커의 유일한 「조용한 오답」 방어선(STRICT_GRIDS)을 묶는다.
// 산술만 보면 null 전파로 막히는 것처럼 보이지만, IF/ISNUMBER/IFERROR/TEXT 는 null 을
// **삼킨다** — 가드가 없으면 못 푼 셀이 null(→0/거짓)이 되어 앵커가 「계산됐다」며
// 엉뚱한 값을 내고, gridCell 이 확정본보다 그것을 먼저 돌려준다.
// 실측(리뷰): 가드를 {} 로 바꾸면 앵커값이 달라지는 셀 2,807건 · 그 중 확정본과
// 어긋나는 셀 2,585건. 관문은 오늘 이것을 잡지 못한다(소비자가 전부 presentation 셀).
test('STRICT_GRIDS: null 을 삼키는 수식도 앵커로 못 풀면 undefined 다 (확정본을 보지 않는다)', () => {
  // ISNUMBER 가 null 을 삼키는 모양 — 실측 part3!_13개국!C3 과 같은 수식.
  // B3 는 앵커로 못 푸는 셀(INDEX/MATCH), A3 는 리터럴이다.
  const ac = ctx({
    _13개국: {
      B3: "=INDEX('p214'!$G$6:$G$43,MATCH($A3,'p214'!$A$6:$A$43,0))",
      C3: '=IF(ISNUMBER(B3),B3,IF($A3="일본",-9.98E+307,-9.99E+307))',
    },
  });
  assert.equal(anchorCell(ac, '_13개국', 'C3'), undefined);   // 가드 없으면 -9.99e+307

  // IFERROR 가 null 을 삼키는 모양 — 실측 part1_6!p87!B11.
  const ac2 = ctx({ p87: { B11: '=IFERROR(B10*100/A10-100,"-")' } });
  assert.equal(anchorCell(ac2, 'p87', 'B11'), undefined);     // 가드 없으면 "-"

  // TEXT·ISNUMBER 는 null 을 각각 "0" · 거짓으로 삼킨다
  const ac3 = ctx({ p1: { A1: '=TEXT(B1,"0")', A2: '=ISNUMBER(B1)' } });
  assert.equal(anchorCell(ac3, 'p1', 'A1'), undefined);       // 가드 없으면 "0"
  assert.equal(anchorCell(ac3, 'p1', 'A2'), undefined);       // 가드 없으면 0
});

test('STRICT_GRIDS: 실데이터 part3!_13개국!C3 은 확정본으로 떨어진다', () => {
  const dump = JSON.parse(readFileSync(join('data', 'formulas', 'part3.json'), 'utf8')) as FormulaDump;
  const oracle = JSON.parse(readFileSync(join('data', 'oracle', 'part3.json'), 'utf8')) as OracleDump;
  const ac = ctx(dump.sheets);
  assert.equal(anchorCell(ac, '_13개국', 'C3'), undefined);
  // 그리고 execute 는 확정본 값을 돌려준다 — 가드가 없으면 여기서 -9.99e+307 이 나온다.
  const db = null as never;
  assert.equal(
    execute({ op: 'cell', sheet: '_13개국', ref: 'C3' },
      { db, grids: oracle as never, sheet: 'p214', year: '2025', anchor: ac }),
    oracle['_13개국']['C3'],
  );
  assert.equal(oracle['_13개국']['C3'], 35250.42);
});

test('메모이즈: 같은 셀을 두 번 물어도 수식을 다시 읽지 않는다', () => {
  let reads = 0;
  const sheet = new Proxy({ B1: ANCHOR_FORMULA, Q5: '=B1', P5: '=Q5-1', O5: '=P5-1' } as Record<string, string>, {
    get(t, k) { if (typeof k === 'string') reads++; return (t as Record<string, string>)[k as string]; },
  });
  const ac = ctx({ _시계열: sheet });
  assert.equal(anchorCell(ac, '_시계열', 'O5'), 2023);
  const first = reads;
  assert.equal(anchorCell(ac, '_시계열', 'O5'), 2023);
  assert.equal(anchorCell(ac, '_시계열', 'P5'), 2024);
  assert.equal(reads, first, '메모이즈되지 않아 수식을 다시 읽었다');
});

test('순환 수식은 던진다', () => {
  const ac = ctx({ p1: { A1: '=B1', B1: '=A1' } });
  assert.throws(() => anchorCell(ac, 'p1', 'A1'), /순환/);
});

// ── 규칙 2: 외부통합문서 참조는 재귀 경계다 ───────────────────────────────────

// 리뷰 1차 [지적 2]: 이 시험의 옛 이름은 「규칙 2 가」 막는다고 읽혔지만, 규칙 2 를 지운
// 뮤턴트에서도 통과한다 — 파서 장벽(PARSE_CTX 의 빈 extmap)이 똑같이 막기 때문이다.
// 두 겹이 같은 값(undefined)을 내므로 반환값으로는 구별할 수 없다. 그래서 이름을 사실대로
// 「앵커로 풀리지 않는다」로 바꾸고, 아래에 전 데이터 시험을 더했다.
test('실제 SUMIFS 셀은 앵커로 풀리지 않는다 — anchorCell 은 db 를 아예 받지 않는다', () => {
  // 실제 데이터에서 고른 SUMIFS 한 개.
  const dump = JSON.parse(readFileSync(join('data', 'formulas', 'part1_1.json'), 'utf8')) as FormulaDump;
  const found = Object.entries(dump.sheets)
    .flatMap(([sheet, cells]) => Object.entries(cells).map(([ref, f]) => ({ sheet, ref, f })))
    .find((x) => x.f.includes('SUMIFS'));
  assert.ok(found, '데이터에서 SUMIFS 수식을 못 찾았다');
  const ac = ctx(dump.sheets);
  assert.equal(anchorCell(ac, found!.sheet, found!.ref), undefined);
});

// 규칙 2 의 안전 성질을 좌표 하나가 아니라 전 데이터로 못박는다: 앵커 한 칸(바닥값)을
// 뺀 **모든** 외부통합문서 참조 수식이 앵커로 풀리지 않아야 한다. 어느 겹(규칙 2 ·
// 파서 장벽 · NO_DB)이 막는지는 묶지 않지만, 「연도 셀은 DB 를 타지 않는다」는 성질
// 자체는 20,527건으로 묶는다 — 한 건이라도 풀리면 실패한다.
test('외부참조를 품은 수식 20,527건 전부가 앵커로 풀리지 않는다 (DB 경계)', () => {
  let ext = 0;
  const leaked: string[] = [];
  for (const { part, dump } of parts()) {
    const ac = ctx(dump.sheets);
    for (const [sheet, cells] of Object.entries(dump.sheets)) {
      for (const [ref, formula] of Object.entries(cells)) {
        let toks;
        try { toks = tokenize(formula); } catch { continue; }
        if (!toks.some((t) => t.t === 'ref' && t.ext !== null)) continue;
        if (toks.length === 1) continue;            // 앵커 한 칸 자체는 바닥값이다
        ext++;
        const v = anchorCell(ac, sheet, ref);
        if (v !== undefined && leaked.length < 5) leaked.push(`${part}!${sheet}!${ref} → ${JSON.stringify(v)}`);
      }
    }
  }
  assert.deepEqual(leaked, []);
  assert.equal(ext, 20527);                          // 실측 규모 — 줄면 훑지 못한 것이다
});

test('앵커 이외의 외부참조는 시트 이름으로 가려낸다 (인덱스가 아니라)', () => {
  // 같은 [1] 인덱스라도 0_수집현황!A1 이 아니면 앵커가 아니다.
  const ac = ctx({ p1: { A1: "='[1]DT_1DE1S'!$A$1" } });
  assert.equal(anchorCell(ac, 'p1', 'A1'), undefined);
  // 반대로 인덱스가 [2] 여도 0_수집현황!A1 이면 앵커다 (part1_7·part2_1 이 그렇다).
  const ac2 = ctx({ p1: { A1: "='[2]0_수집현황'!$A$1" } });
  assert.equal(anchorCell(ac2, 'p1', 'A1'), 2025);
});

// ── 지면 씨앗셀: 문자열 이어붙이기 ───────────────────────────────────────────

test('씨앗셀 (_시계열!$B$1-N)&"년" 은 문자열을 낸다 (숫자 아님)', () => {
  const ac = ctx({ _시계열: { B1: ANCHOR_FORMULA }, p82: { A7: '=(_시계열!$B$1-17)&"년"' } });
  const v = anchorCell(ac, 'p82', 'A7');
  assert.equal(v, '2008년');
  assert.equal(typeof v, 'string');
});

test('씨앗셀: 실제 데이터의 &"년" 수식이 확정본 값과 같다', () => {
  // part1_7!p122_123!A6 = '=_시계열!B12&"년"' · 확정본 "2017년"
  const dump = JSON.parse(readFileSync(join('data', 'formulas', 'part1_7.json'), 'utf8')) as FormulaDump;
  const oracle = JSON.parse(readFileSync(join('data', 'oracle', 'part1_7.json'), 'utf8')) as OracleDump;
  const ac = ctx(dump.sheets);
  assert.equal(anchorCell(ac, 'p122_123', 'A6'), oracle['p122_123']['A6']);
});

// ── 실제 13개 part 전건 ──────────────────────────────────────────────────────

function parts(): { part: string; dump: FormulaDump; oracle: OracleDump }[] {
  return readdirSync(join('data', 'formulas')).filter((f) => f.endsWith('.json')).map((f) => ({
    part: basename(f, '.json'),
    dump: JSON.parse(readFileSync(join('data', 'formulas', f), 'utf8')) as FormulaDump,
    oracle: JSON.parse(readFileSync(join('data', 'oracle', f), 'utf8')) as OracleDump,
  }));
}

test('_시계열 사슬: 앵커=2025 로 평가한 값이 확정본과 전부 같다 (일치 236 · 불일치 0)', () => {
  let match = 0;
  const bad: string[] = [];
  const noAnchor: string[] = [];
  for (const { part, dump, oracle } of parts()) {
    const cells = dump.sheets['_시계열'];
    assert.ok(cells, `${part} 에 _시계열 이 없다`);
    const ac = ctx(dump.sheets);
    let evaluated = 0;
    for (const ref of Object.keys(cells)) {
      const got = anchorCell(ac, '_시계열', ref);
      if (got === undefined) continue;
      evaluated++;
      const want = oracle['_시계열']?.[ref];
      if (got === want) match++;
      else bad.push(`${part}!_시계열!${ref}: 기대 ${JSON.stringify(want)} 얻음 ${JSON.stringify(got)}`);
    }
    if (evaluated === 0) noAnchor.push(part);
  }
  assert.deepEqual(bad, []);
  assert.equal(match, 236);
  // 평가 못 하는 part 2개 — part1_5·part3 은 _시계열!B1 이 수식이 아니라 리터럴이라
  // (그 통합문서에는 KOSIS 원데이터 연결이 없다) 사슬의 바닥이 없다. 확정본 격자로 떨어진다.
  assert.deepEqual(noAnchor, ['part1_5', 'part3']);
});

test('앵커를 2026 으로 주면 _시계열 사슬이 전부 정확히 1 씩 늘어난다', () => {
  let checked = 0;
  for (const { part, dump } of parts()) {
    const a25 = ctx(dump.sheets, 2025);
    const a26 = ctx(dump.sheets, 2026);
    for (const ref of Object.keys(dump.sheets['_시계열'])) {
      const v25 = anchorCell(a25, '_시계열', ref);
      if (v25 === undefined) continue;
      assert.equal(anchorCell(a26, '_시계열', ref), (v25 as number) + 1, `${part}!_시계열!${ref}`);
      checked++;
    }
  }
  assert.equal(checked, 236);
});

// ── execute 와의 접합 ────────────────────────────────────────────────────────

const grid: Grid = { B5: 1999, C6: 1999 };

test('회귀: anchor 없이 부른 execute 는 지금까지처럼 격자에서 읽는다', () => {
  const e: Expr = { op: 'cell', ref: 'B5' };
  const db = null as never;
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025' }), 1999);
});

test('anchor 가 있으면 셀은 앵커에서 먼저 계산되고, 못 하면 격자로 떨어진다', () => {
  const ac = ctx({ _시계열: { B1: ANCHOR_FORMULA }, p1: { B5: '=_시계열!B1-1' } });
  const db = null as never;
  const c = { db, grids: { p1: grid }, sheet: 'p1', year: '2025', anchor: ac };
  assert.equal(execute({ op: 'cell', ref: 'B5' }, c), 2024);   // 앵커에서 계산 (격자의 1999 아님)
  assert.equal(execute({ op: 'cell', ref: 'C6' }, c), 1999);   // 수식이 없어 격자로
});

test('연도 조건도 앵커에서 계산한다', () => {
  const ac = ctx({ _시계열: { B1: ANCHOR_FORMULA }, p1: { C6: '=_시계열!B1' } });
  const db = {
    prepare: (_sql: string) => ({ get: (...args: unknown[]) => ({ v: args.includes('2025') ? 7 : 0 }) }),
  } as never;
  const e: Expr = { op: 'sumifs', q: { src: 'kosis', table: 'T', value: 'DT',
    where: { PRD_DE: { kind: 'year', ref: 'C6' } } } };
  // 격자에는 1999 가 들어 있지만 앵커가 이긴다
  assert.equal(execute(e, { db, grids: { p1: grid }, sheet: 'p1', year: '2025', anchor: ac }), 7);
});
