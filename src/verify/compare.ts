import type { DatabaseSync } from 'node:sqlite';
import { buildCellMap } from '../cellmap/build.ts';
import { execute } from '../query/execute.ts';
import { makeAnchorCtxFromMap, ANCHOR_SEAT, type AnchorCtx } from '../query/anchor.ts';
import type { CellMap, Grid, Headers } from '../types.ts';

export type Verdict = 'match' | 'mismatch' | 'unsupported' | 'no-oracle' | 'error' | 'presentation'
  // Task 9 단위 9: 사용자가 「인쇄본이 틀렸다」고 판정한 칸. 확정본은 고치지 않는다 —
  // 확정본은 계속 「인쇄된 것」을 뜻하고, 그래서 나머지 29,558칸의 재현 주장이 유효하다.
  | 'known-divergence';

/** Task 9 단위 9: 면제 한 건. **좌표만으로 면제하지 않는다** — 기대하는 확정본 값과
    기대하는 계산값을 둘 다 적고, 둘 다 그대로일 때만 면제한다. 면제 목록은 관문을
    느슨하게 만드는 장치이므로, 좌표만 걸면 그 칸은 영원히 눈먼 자리가 된다. */
export type KnownDivergence = {
  part: string; sheet: string; ref: string;
  oracle: number | string;
  computed: number | string;
  reason: string;
  decided_by: string;
  decided_on: string;
};

/** 더 이상 유효하지 않은 면제. 관문을 **실패**시켜야 한다 — 면제가 조용히 쌓이면
    관문이 썩는다. */
export type StaleDivergence = { entry: KnownDivergence; why: string };

/** 면제를 적용한다. `mismatch` 이고 두 값이 그대로인 칸만 `known-divergence` 로 바꾸고,
    그러지 못한 면제 항목은 **묵은 것**으로 돌려준다(호출부가 관문을 실패시킨다).
    **멱등이다**: 이미 `known-divergence` 인 칸은 두 값만 다시 확인하고 그대로 둔다 —
    관문이 part 별로 적용한 뒤 전체에 대해 묵음 검사를 한 번 더 돌리기 때문이다. */
export function applyKnownDivergences(
  rows: CellResult[], known: KnownDivergence[],
): { rows: CellResult[]; stale: StaleDivergence[] } {
  const byKey = new Map(rows.map((r) => [`${r.part}!${r.sheet}!${r.ref}`, r]));
  const out = rows.slice();
  const stale: StaleDivergence[] = [];
  for (const e of known) {
    const key = `${e.part}!${e.sheet}!${e.ref}`;
    const r = byKey.get(key);
    if (!r) { stale.push({ entry: e, why: `그 좌표가 대조 결과에 없다 (${key})` }); continue; }
    if (r.verdict !== 'mismatch' && r.verdict !== 'known-divergence') {
      stale.push({ entry: e, why: `더 이상 불일치가 아니다 — 지금 판정은 ${r.verdict} 다 (${key})` });
      continue;
    }
    if (!sameValue(e.oracle, r.expected)) {
      stale.push({ entry: e, why: `확정본 값이 달라졌다: 적힌 값 ${JSON.stringify(e.oracle)} / 지금 ${JSON.stringify(r.expected)} (${key})` });
      continue;
    }
    if (!sameValue(e.computed, r.got)) {
      stale.push({ entry: e, why: `계산값이 달라졌다: 적힌 값 ${JSON.stringify(e.computed)} / 지금 ${JSON.stringify(r.got)} (${key})` });
      continue;
    }
    out[out.indexOf(r)] = { ...r, verdict: 'known-divergence', reason: e.reason };
  }
  return { rows: out, stale };
}

export type CellResult = {
  part: string; sheet: string; ref: string;
  verdict: Verdict;
  expected: number | string | null;
  got: number | string | null;
  reason?: string;
};

export type FormulaDump = {
  extmap: Record<string, string>;
  sheets: Record<string, Record<string, string>>;
};
export type OracleDump = Record<string, Record<string, string | number>>;

const REL = 1e-9;

/** 제대로 세 자리씩 끊은 숫자 문자열만 — "1,234.5" 는 맞고 "1,2" · "12,34" 는 아니다 */
const GROUPED = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** 유한한 숫자로 읽히는가. 공백만 있는 문자열은 숫자로 치지 않는다 — Number('') 가
    0 이 되어 sameValue('', 0) 을 참으로 만드는 것을 막는다.
    Task 9 단위 8: `grouped` 를 켜면 천단위 구분자가 찍힌 숫자 문자열도 숫자로 읽는다 —
    TEXT(G6,"#,##0") 의 결과 "211,983" 과, 그 값을 Excel COM 이 숫자로 강제 변환해 담은
    오라클 211983 은 같은 값의 두 표현이다(단위 4 CHANGE 1 의 "84.0" vs 84 와 같은
    사정, 실측 307건). 구분자 모양이 정확할 때만 벗긴다. */
function asFiniteNumber(v: unknown, grouped = false): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(grouped && GROUPED.test(s) ? s.replace(/,/g, '') : s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Task 9 단위 4 (CHANGE 1): 냉동 통합문서의 차트 데이터레이블 열(헤더 "(레이블)")은
// 오라클을 얼려담을 때 Excel COM 이 TEXT(G9,"0.0") 의 문자열 결과("84.0")를 숫자로
// 강제 변환해 84 를 남긴다 — 84 와 "84.0" 은 같은 값의 두 표현일 뿐, 둘 다 틀리지
// 않았다. 실측 65건이 이 원인이었다. 양쪽이 모두 유한한 숫자로 읽히면 숫자로
// 비교하고(기존 1e-9 상대오차 그대로), 아니면 지금까지처럼 문자열로 비교한다.
// Task 9 단위 8 (리뷰 1차 [지적 3]): 구분자 완화는 **비대칭**이다 — 근거 307건이 전부
// 「오라클이 숫자 · 계산값이 구분자 문자열」한 방향이기 때문이다. 반대 방향(오라클이
// "294,525" 같은 구분자 문자열 · 계산값이 맨숫자)은 받지 않는다: 그 모양의 오라클이
// 전 데이터에 18건 있고(part1_7!p124!D6·F6 등, 지금은 VLOOKUP 미지원으로 대조되지
// 않는다), 다음 단위가 VLOOKUP 을 구현하면 구분자를 떨어뜨린 계산값이 조용히 통과하게
// 된다. 인자 이름이 곧 방향이다 — 호출부는 sameValue(오라클, 계산값) 이다.
// 전체 리뷰 F8: **양쪽이 문자열이면 문자열로 비교한다.** 옛 비교기는 둘 다 숫자로
// 읽히면 숫자로 봤고(`sameValue('5.40','5.4') === true`), `TEXT()` 의 결과는 문자열이므로
// **자릿수 회귀가 보이지 않았다**: `textFormat` 이 `"0.000"` 을 잘못 읽어 "5.400" 을 내도
// 확정본 "5.40" 과 통과한다. 이 경로로 통과한 칸은 오늘 0건(리뷰어 측정)이라 관문 수치는
// 움직이지 않는다 — 잠재 구멍을 닫는 것이다. 숫자↔문자 교차(실측 1,001건)와 구분자
// 완화(비대칭, 커밋 2d461d2)는 **건드리지 않는다.**
export function sameValue(expected: unknown, got: unknown): boolean {
  if (expected === null || got === null || expected === undefined || got === undefined) {
    return expected === got;
  }
  if (typeof expected === 'string' && typeof got === 'string') return expected === got;
  const x = asFiniteNumber(expected);
  const y = asFiniteNumber(got, typeof expected === 'number');
  if (x !== null && y !== null) {
    const scale = Math.max(Math.abs(x), Math.abs(y), 1);
    return Math.abs(x - y) <= REL * scale;
  }
  return String(expected) === String(got);
}

export function verifyPart(
  part: string,
  formulas: FormulaDump,
  oracle: OracleDump,
  db: DatabaseSync,
  headers: Headers,
  /** 기준연도. Task 9 단위 10: 이 인자가 **앵커의 출처**다 — 단위 8 이후로 실행기가
      읽지 않는 죽은 손잡이였다(리뷰 지적 6). 시그니처는 그대로 두고 뜻만 되살렸다. */
  year: string,
  anchor = Number(year),
): CellResult[] {
  if (!Number.isInteger(anchor)) {
    throw new Error(`기준연도(앵커)를 정수로 못 읽었다: ${JSON.stringify(year)}`);
  }
  // Task 9 단위 11 (물화): 수식을 그때그때 파싱하는 것이 아니라, **cellmap 을 만들어
  // 그것을 실행한다.**
  // 전체 리뷰 F4-b: 예전 주석은 「두 경로가 같은 코드를 타므로 왕복 시험이 뜻을 갖는다」고
  // 적었는데 인과가 뒤집혀 있었다 — 이 함수가 `verifyCellMap` 에 위임하므로, 같은
  // **입력**을 주면 두 결과는 논리적으로 같다. 왕복 시험이 뜻을 갖는 이유는 다른 데 있다:
  // `test/materialize.test.ts` 가 비교하는 cellmap 은 **커밋된 `data/cellmap/*.json`
  // 을 디스크에서 읽은 것**이라, 그 시험이 지는 주장은 「저장소의 물화물이 지금 수식에서
  // 만든 것과 같다(최신이다)」다. 관문의 진짜 주장은 이제 verify-all 의 기본 경로
  // 자체가 진다(F4).
  return verifyCellMap(part, buildCellMap(part, formulas, headers), oracle, db, anchor);
}

/** Task 9 단위 11: **물화된 cellmap 만으로** 한 part 를 대조한다.
    수식 문자열도 헤더 매핑도 쓰지 않는다 — 필요한 것은 cellmap · 확정본 · DB 뿐이다.
    이것이 「로컬 참고파일 없이 수치 관리」의 실행 지점이다. */
export function verifyCellMap(
  part: string,
  map: CellMap,
  oracle: OracleDump,
  db: DatabaseSync,
  anchor = 2025,
): CellResult[] {
  if (!Number.isInteger(anchor)) {
    throw new Error(`앵커를 정수로 못 읽었다: ${JSON.stringify(anchor)}`);
  }
  const out: CellResult[] = [];

  // 단위 8·10: 연도는 확정본에서 읽지 않고 앵커에서 계산한다. 앵커 자리가 빈 통합문서
  // (part1_5·part3)에는 RULING 17 로 값을 심고, 확정본의 그 자리 값으로 전제를 단정한다.
  const anchorCtx: AnchorCtx = makeAnchorCtxFromMap(
    map, anchor, oracle[ANCHOR_SEAT.sheet]?.[ANCHOR_SEAT.ref]);

  // RULING 8: 실행기에는 파트 전체의 격자(시트명 → Grid)를 넘긴다 — 지면 간 참조와
  // 보조시트 참조가 있어 단일 시트로는 풀 수 없다. 확정본이 이미 그 모양이다.
  const grids: Record<string, Grid> = oracle;

  for (const [sheet, cells] of Object.entries(map.sheets)) {
    if (sheet.startsWith('_')) continue;        // 보조시트는 지면이 아니다
    const grid: Grid = (oracle[sheet] ?? {}) as Grid;

    for (const [ref, spec] of Object.entries(cells)) {
      const expected = Object.prototype.hasOwnProperty.call(grid, ref)
        ? (grid[ref] as number | string) : null;
      if (expected === null) {
        out.push({ part, sheet, ref, verdict: 'no-oracle', expected: null, got: null });
        continue;
      }
      if (spec.kind !== 'expr') {
        // 다룰 수 없는 셀. 판정(unsupported/presentation)은 **물화 때 이미 정해져 있다** —
        // cellmap 에 수식 문자열이 없으므로 여기서 다시 판정할 수 없다.
        out.push({ part, sheet, ref, verdict: spec.kind, expected, got: null, reason: spec.reason });
        continue;
      }
      let got: number | string | null = null;
      try {
        got = execute(spec.e, { db, grids, sheet, anchor: anchorCtx });
      } catch (err) {
        out.push({ part, sheet, ref, verdict: 'error', expected, got: null,
                   reason: (err as Error).message });
        continue;
      }
      out.push({ part, sheet, ref, expected, got,
                 verdict: sameValue(expected, got) ? 'match' : 'mismatch' });
    }
  }
  return out;
}
