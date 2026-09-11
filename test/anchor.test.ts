import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { anchorCell, type AnchorCtx } from '../src/query/anchor.ts';
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

test('못 푸는 셀을 참조하면 그 셀도 undefined 다 — 0 으로 뭉개지 않는다', () => {
  // B4 는 수식이 없다(리터럴). =B4+5 를 4+5 나 0+5 로 계산해 버리면 안 된다.
  const ac = ctx({ _시계열: { B1: ANCHOR_FORMULA }, p8: { G4: '=B4+5' } });
  assert.equal(anchorCell(ac, 'p8', 'G4'), undefined);
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

test('앵커가 아닌 외부통합문서 참조가 있으면 undefined 다 — DB 를 타지 않는다', () => {
  // 실제 데이터에서 고른 SUMIFS 한 개. anchorCell 은 db 를 아예 받지 않으므로
  // 여기서 undefined 가 나온다는 것이 곧 "DB 를 타지 않는다"의 증거다.
  const dump = JSON.parse(readFileSync(join('data', 'formulas', 'part1_1.json'), 'utf8')) as FormulaDump;
  const found = Object.entries(dump.sheets)
    .flatMap(([sheet, cells]) => Object.entries(cells).map(([ref, f]) => ({ sheet, ref, f })))
    .find((x) => x.f.includes('SUMIFS'));
  assert.ok(found, '데이터에서 SUMIFS 수식을 못 찾았다');
  const ac = ctx(dump.sheets);
  assert.equal(anchorCell(ac, found!.sheet, found!.ref), undefined);
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
