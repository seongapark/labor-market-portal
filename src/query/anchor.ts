import type { DatabaseSync } from 'node:sqlite';
import { parseFormula, type ParseCtx } from '../cellmap/parse.ts';
import { tokenize } from '../cellmap/tokenize.ts';
import { execute } from './execute.ts';
import type { Grid } from '../types.ts';

/** Task 9 단위 8: 연도는 확정본 격자에서 읽지 않고 **앵커에서 계산한다**.
    앵커 = 원데이터 통합문서의 '[N]0_수집현황'!$A$1 (기준연도 한 칸). 거기서
    _시계열!B1 → Q5 → P5 → … 로 사슬이 이어지고, 지면의 연도 머리글이 그 사슬을 탄다.
    관문은 이 변경으로 약해지지 않고 강해진다 — 확정본의 연도를 믿는 대신,
    앵커로부터 사슬이 제대로 계산되는지를 증명하게 된다. */
export type AnchorCtx = {
  formulas: Record<string, Record<string, string>>;  // sheet → ref → 수식
  anchor: number;                                     // 기준연도. 검증 때는 2025
  /** 아래 둘은 내부용이다 — 호출자는 { formulas, anchor } 만 주면 된다.
      part 하나(=AnchorCtx 하나) 안에서만 메모이즈한다: part 마다 수식이 다르다. */
  memo?: Map<string, string | number | undefined>;
  stack?: Set<string>;
};

/** 앵커 셀은 통합문서마다 외부참조 인덱스가 다르다([1] 이기도 [2] 이기도 하다 — extmap
    이 part 별인 이유가 그것이다). 그래서 인덱스가 아니라 **시트 이름과 좌표로** 가려낸다. */
const ANCHOR_SHEET = '0_수집현황';
const ANCHOR_CELL = 'A1';

/** 앵커로 못 푸는 셀을 참조했다는 신호. 이 셀은 통째로 「계산 불가」다.
    0 이나 null 로 뭉개면 =B4+5 가 5 가 되어 조용히 틀린 값이 나온다. */
class Unresolved extends Error {}

/** 앵커 평가 전용 격자 — 여기에 닿았다는 것은 anchorCell 이 못 푼 셀이라는 뜻이다.
    앵커 계산은 확정본 격자를 절대 보지 않는다(그게 이 단위의 목적이다). */
const STRICT_GRIDS: Record<string, Grid> = new Proxy({} as Record<string, Grid>, {
  get(_t, sheet) {
    if (typeof sheet !== 'string') return undefined;
    return new Proxy({} as Grid, {
      get(_t2, ref) {
        if (typeof ref !== 'string') return undefined;
        throw new Unresolved(`앵커로 못 푸는 셀: ${sheet}!${ref}`);
      },
    });
  },
});

/** 규칙 2 덕분에 앵커 계산에는 SUMIFS/COUNTIFS 가 절대 들어오지 않는다(외부통합문서
    참조가 있으면 그 전에 undefined 로 끊긴다). 그래서 db 는 쓰이지 않는다. */
const NO_DB = null as unknown as DatabaseSync;

/** 외부참조를 미리 걸러내므로 extmap·headers 는 쓰일 일이 없다. */
const PARSE_CTX: ParseCtx = { extmap: {}, headers: {} };

function plainRef(a1: string): string {
  return a1.replace(/\$/g, '');
}

/** 수식 전체가 앵커 한 칸인가 — 사슬의 유일한 바닥값 */
function isAnchor(toks: ReturnType<typeof tokenize>): boolean {
  if (toks.length !== 1) return false;
  const t = toks[0];
  return t.t === 'ref' && t.ext !== null && t.sheet === ANCHOR_SHEET && plainRef(t.a1) === ANCHOR_CELL;
}

function evalFormula(ac: AnchorCtx, sheet: string, formula: string): string | number | undefined {
  let toks;
  try {
    toks = tokenize(formula);
  } catch {
    return undefined;                      // 토큰화도 안 되면 계산 불가다
  }
  if (isAnchor(toks)) return ac.anchor;                                  // 규칙 1
  if (toks.some((t) => t.t === 'ref' && t.ext !== null)) return undefined; // 규칙 2

  const e = parseFormula(formula, PARSE_CTX);                            // 규칙 3
  if (e.op === 'unsupported') return undefined;
  try {
    const v = execute(e, { db: NO_DB, grids: STRICT_GRIDS, sheet, year: '', anchor: ac });
    return v === null ? undefined : v;     // null 은 실행기의 오류값이다 — 계산 불가로 본다
  } catch (err) {
    if (err instanceof Unresolved) return undefined;
    throw err;                             // 순환 등 진짜 오류는 그대로 올린다
  }
}

/** 셀 하나를 앵커로부터 계산한다. 계산 불가면 undefined (호출자가 격자로 떨어진다). */
export function anchorCell(ac: AnchorCtx, sheet: string, ref: string): string | number | undefined {
  const key = `${sheet}!${ref}`;
  const memo = (ac.memo ??= new Map());
  if (memo.has(key)) return memo.get(key);

  const formula = ac.formulas[sheet]?.[ref];
  // 수식이 없는 셀은 통합문서의 리터럴이다 — 앵커로는 못 구한다(버그가 아니다).
  if (typeof formula !== 'string') { memo.set(key, undefined); return undefined; }

  const stack = (ac.stack ??= new Set());
  if (stack.has(key)) throw new Error(`앵커 수식이 순환한다: ${[...stack, key].join(' → ')}`);
  stack.add(key);
  try {
    const v = evalFormula(ac, sheet, formula);
    memo.set(key, v);
    return v;
  } finally {
    stack.delete(key);
  }
}
