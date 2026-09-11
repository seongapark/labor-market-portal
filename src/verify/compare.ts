import type { DatabaseSync } from 'node:sqlite';
import { parseFormula } from '../cellmap/parse.ts';
import { execute } from '../query/execute.ts';
import type { AnchorCtx } from '../query/anchor.ts';
import { tokenize } from '../cellmap/tokenize.ts';
import type { Grid, Headers } from '../types.ts';

export type Verdict = 'match' | 'mismatch' | 'unsupported' | 'no-oracle' | 'error' | 'presentation';

// booklet 의 OECD 부록 페이지는 같은 시트의 값을 INDEX/MATCH/RANK 로 정렬·표시만
// 한다 — 원천 통합문서에서 아무 것도 가져오지 않는다. 이 정렬 로직은 SQL 로 재구현하지
// 않기로 계획 단계에서 결정했다: 이건 데이터가 아니라 표현(presentation)이다.
// 실측 규칙(추측 아님): 파싱 실패 3,364건 중 외부통합문서 참조(ref.ext !== null)를
// 하나라도 품은 건 0건이었다 — 전부 같은시트 참조([1]시트!같은 형태 없이)만 쓴다.
// 그래서 판정 기준은 "같은시트 정렬 함수 이름이 이유에 나오는가" + "외부 참조가
// 없는가" 의 AND 다. 정규식으로 대괄호([1])를 찾지 않는다 — 문자열 리터럴 안에
// "[1]" 이 들어 있을 수 있어서다. tokenize 로 실제 토큰을 봐야 한다.
const PRESENTATION_FN = /\b(INDEX|MATCH|RANK)\b/;

function isPresentation(formula: string, reason: string): boolean {
  if (!PRESENTATION_FN.test(reason)) return false;
  let toks;
  try {
    toks = tokenize(formula);
  } catch {
    return false; // 토큰화조차 안 되면 외부 참조 여부를 확인할 수 없다 — 보수적으로 unsupported
  }
  return !toks.some((t) => t.t === 'ref' && t.ext !== null);
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
    Task 9 단위 8: 천단위 구분자가 찍힌 숫자 문자열도 숫자로 읽는다 — TEXT(G6,"#,##0") 의
    결과 "211,983" 과, 그 값을 Excel COM 이 숫자로 강제 변환해 담은 오라클 211983 은
    같은 값의 두 표현이다(단위 4 CHANGE 1 의 "84.0" vs 84 와 같은 사정, 실측 307건).
    구분자 모양이 정확할 때만 벗긴다 — 같은 문자열끼리는 어차피 같으므로 이 완화가
    맞던 대조를 틀리게 만들 수는 없다. */
function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(GROUPED.test(s) ? s.replace(/,/g, '') : s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Task 9 단위 4 (CHANGE 1): 냉동 통합문서의 차트 데이터레이블 열(헤더 "(레이블)")은
// 오라클을 얼려담을 때 Excel COM 이 TEXT(G9,"0.0") 의 문자열 결과("84.0")를 숫자로
// 강제 변환해 84 를 남긴다 — 84 와 "84.0" 은 같은 값의 두 표현일 뿐, 둘 다 틀리지
// 않았다. 실측 65건이 이 원인이었다. 양쪽이 모두 유한한 숫자로 읽히면 숫자로
// 비교하고(기존 1e-9 상대오차 그대로), 아니면 지금까지처럼 문자열로 비교한다.
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  const x = asFiniteNumber(a), y = asFiniteNumber(b);
  if (x !== null && y !== null) {
    const scale = Math.max(Math.abs(x), Math.abs(y), 1);
    return Math.abs(x - y) <= REL * scale;
  }
  return String(a) === String(b);
}

export function verifyPart(
  part: string,
  formulas: FormulaDump,
  oracle: OracleDump,
  db: DatabaseSync,
  headers: Headers,
  year: string,
  anchor = 2025,
): CellResult[] {
  const out: CellResult[] = [];
  const ctx = { extmap: formulas.extmap, headers };

  // Task 9 단위 8: 연도는 확정본에서 읽지 않고 앵커('[N]0_수집현황'!$A$1)에서 계산한다.
  // 작업본 수식을 이미 들고 있으니 그것으로 AnchorCtx 를 만든다. 기본 앵커는 2025 —
  // 관문의 전제가 "인쇄된 값의 재현"이므로 다른 값으로 관문을 돌리지 않는다.
  // 이로써 관문은 확정본의 연도를 *믿는* 대신 앵커에서 사슬이 제대로 계산되는지를
  // *증명한다*. 앵커로 못 구하는 셀(수식이 없는 리터럴 등)만 격자로 떨어진다.
  const anchorCtx: AnchorCtx = { formulas: formulas.sheets, anchor };

  // RULING 8: 실행기에는 파트 전체의 격자(시트명 → Grid)를 넘긴다. booklet 페이지 간
  // 셀 참조('p68'!$F$5, 2,616건)와 보조시트(_시계열, 2,092건) 참조가 실측으로 나와,
  // 단일 시트의 grid 로는 풀 수 없다. oracle 자체가 이미 { 시트명 → { 셀 → 값 } } 모양이라
  // 그대로 grids 로 넘긴다 — 보조시트도 참조 대상으로는 남기고, 대조 지면으로만 건너뛴다.
  const grids: Record<string, Grid> = oracle;

  for (const [sheet, cells] of Object.entries(formulas.sheets)) {
    if (sheet.startsWith('_')) continue;        // 보조시트는 지면이 아니다
    const grid: Grid = (oracle[sheet] ?? {}) as Grid;

    for (const [ref, formula] of Object.entries(cells)) {
      const expected = Object.prototype.hasOwnProperty.call(grid, ref)
        ? (grid[ref] as number | string) : null;
      if (expected === null) {
        out.push({ part, sheet, ref, verdict: 'no-oracle', expected: null, got: null });
        continue;
      }
      const e = parseFormula(formula, ctx);
      if (e.op === 'unsupported') {
        const verdict: Verdict = isPresentation(formula, e.reason) ? 'presentation' : 'unsupported';
        out.push({ part, sheet, ref, verdict, expected, got: null, reason: e.reason });
        continue;
      }
      let got: number | string | null = null;
      try {
        got = execute(e, { db, grids, sheet, year, anchor: anchorCtx });
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
