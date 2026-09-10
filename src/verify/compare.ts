import type { DatabaseSync } from 'node:sqlite';
import { parseFormula } from '../cellmap/parse.ts';
import { execute } from '../query/execute.ts';
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

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b);
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const scale = Math.max(Math.abs(x), Math.abs(y), 1);
  return Math.abs(x - y) <= REL * scale;
}

export function verifyPart(
  part: string,
  formulas: FormulaDump,
  oracle: OracleDump,
  db: DatabaseSync,
  headers: Headers,
  year: string,
): CellResult[] {
  const out: CellResult[] = [];
  const ctx = { extmap: formulas.extmap, headers };

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
        got = execute(e, { db, grids, sheet, year });
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
