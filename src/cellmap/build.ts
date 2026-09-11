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
// Task 9 단위 11: 이 판정을 **물화 시점으로 옮겼다.** cellmap 에는 수식 문자열이 없으므로
// 나중에 다시 판정할 수 없다 — 그래서 kind 로 못박아 담는다.
//
// 전체 리뷰 F1 (2026-09-11): 판정을 **예외 메시지 정규식에서 떼어냈다.**
// 옛 판정은 `/\b(INDEX|MATCH|RANK)\b/` 로 **사유 문자열**을 맞혔는데, 파서의 예외
// 메시지는 토큰 JSON 덤프나 인자 수 불만을 꼬리로 달기 때문에 전혀 다른 실패가 함수
// 이름을 품었다: 깨진 수식(`=A1 MATCH(…)`)·2차원 INDEX(안 만들기로 한 것)·근사 조회
// MATCH 가 모두 presentation 으로 삼켜졌고, presentation 은 관문의 분모에서 빠지므로
// **그 칸들이 조용히 관문을 벗어났다**(같은 성격의 `VLOOKUP(…,1)` 은 옳게 관문을
// 실패시켰다 — 같은 거부가 정반대 대우를 받았다). 오늘의 5,132건은 깨끗했지만
// (사유가 두 종류뿐) 키잉이 원리적이지 않았다.
//
// 지금 판정은 두 가지의 AND 다:
//   1. **던진 자리**가 표현 거부로 표시했는가(`PresentationRefusal` → `e.presentation`).
//      지원하지 않는 함수·깨진 수식·미구현 모드는 표식을 받지 못하고 `unsupported` 로 남는다.
//   2. **구조적 사실**: 이 셀이 외부 통합문서를 참조하지 않는가(RULING 14).
//      실측으로 presentation 전건에 예외가 없었던 규칙이고, 부록·서식 칸이라는 뜻이다.
//      정규식으로 대괄호([1])를 찾지 않는다 — 문자열 리터럴 안에 "[1]" 이 들어 있을 수
//      있어서다. tokenize 로 실제 토큰을 봐야 한다.
export function isPresentation(formula: string, e: Extract<Expr, { op: 'unsupported' }>): boolean {
  if (e.presentation !== true) return false;
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
    return isPresentation(formula, e)
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
