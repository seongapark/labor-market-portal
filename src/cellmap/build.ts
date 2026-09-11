import { parseFormula } from './parse.ts';
import { tokenize } from './tokenize.ts';
import type { CellMap, CellSpec, Expr, Headers } from '../types.ts';

export type FormulaDump = {
  extmap: Record<string, string>;
  sheets: Record<string, Record<string, string>>;
};

// booklet 의 OECD 부록 페이지는 같은 시트의 값을 INDEX/MATCH/RANK 로 정렬·표시만
// 한다 — 원천 통합문서에서 아무 것도 가져오지 않는다. 이 정렬 로직은 SQL 로 재구현하지
// 않기로 계획 단계에서 결정했다: 이건 데이터가 아니라 표현(presentation)이다.
// 실측 규칙(추측 아님): 파싱 실패 중 외부통합문서 참조(ref.ext !== null)를 하나라도
// 품은 건 0건이었다 — 전부 같은시트/같은통합문서 참조만 쓴다. 그래서 판정 기준은
// "같은시트 정렬 함수 이름이 이유에 나오는가" + "외부 참조가 없는가" 의 AND 다.
// 정규식으로 대괄호([1])를 찾지 않는다 — 문자열 리터럴 안에 "[1]" 이 들어 있을 수
// 있어서다. tokenize 로 실제 토큰을 봐야 한다.
// Task 9 단위 11: 이 판정을 **물화 시점으로 옮겼다.** cellmap 에는 수식 문자열이 없으므로
// 나중에 다시 판정할 수 없다 — 그래서 kind 로 못박아 담는다.
const PRESENTATION_FN = /\b(INDEX|MATCH|RANK)\b/;

export function isPresentation(formula: string, reason: string): boolean {
  if (!PRESENTATION_FN.test(reason)) return false;
  let toks;
  try {
    toks = tokenize(formula);
  } catch {
    return false; // 토큰화조차 안 되면 외부 참조 여부를 확인할 수 없다 — 보수적으로 unsupported
  }
  return !toks.some((t) => t.t === 'ref' && t.ext !== null);
}

/** 수식 하나 → 명세 하나. 수식 문자열은 버린다(unsupported 의 formula 필드까지). */
export function specOf(formula: string, ctx: { extmap: Record<string, string>; headers: Headers }): CellSpec {
  const e = parseFormula(formula, ctx);
  if (e.op === 'unsupported') {
    return isPresentation(formula, e.reason)
      ? { kind: 'presentation', reason: e.reason }
      : { kind: 'unsupported', reason: e.reason };
  }
  return { kind: 'expr', e };
}

/** Task 9 단위 11: 작업본 수식 덤프 → 물화된 cellmap.
    한 번 만들어 저장소에 넣으면, 그 다음부터는 수식 파일도 헤더 매핑도 필요 없다. */
export function buildCellMap(part: string, formulas: FormulaDump, headers: Headers): CellMap {
  const ctx = { extmap: formulas.extmap, headers };
  const sheets: Record<string, Record<string, CellSpec>> = {};
  let hasAnchor = false;
  for (const [sheet, cells] of Object.entries(formulas.sheets)) {
    const out: Record<string, CellSpec> = {};
    for (const [ref, formula] of Object.entries(cells)) {
      const spec = specOf(formula, ctx);
      if (spec.kind === 'expr' && isAnchorExpr(spec.e)) hasAnchor = true;
      out[ref] = spec;
    }
    sheets[sheet] = out;
  }
  return { part, hasAnchor, sheets };
}

/** 명세가 앵커 한 칸인가 — RULING 17 의 주입 여부를 이것으로 판단한다 */
export function isAnchorExpr(e: Expr): boolean {
  return e.op === 'anchor';
}
