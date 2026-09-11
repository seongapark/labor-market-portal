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
  /** RULING 17 (Task 9 단위 10): 앵커 수식이 **없는** 통합문서의 앵커 자리.
      여기에 수식이 없으면 `anchor` 값을 직접 심는다 — 가짜 수식을 만들어 넣지 않는다.
      `makeAnchorCtx` 만 이 필드를 채운다. 비어 있으면 주입은 일어나지 않는다. */
  seed?: { sheet: string; ref: string };
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

/** RULING 17: 앵커 자리 — 13개 part 전부 `_시계열!B1` 이다(실측). 앵커 수식이 있는
    part 는 전부 거기에 있고, 없는 part(part1_5·part3)의 확정본도 거기에 숫자 2025 를
    들고 있다. 주입은 이 한 칸에만 한다. */
export const ANCHOR_SEAT = { sheet: '_시계열', ref: 'B1' } as const;

/** 이 part 안에 앵커 수식이 하나라도 있는가. `_시계열!B1` 만 보지 않는다 —
    실측으로 `part1_4(1)!p67!B1` 처럼 지면에 앵커가 직접 놓인 셀도 있다.
    전 데이터에서 `0_수집현황` 을 언급하는 수식은 12건뿐이라, 문자열 검사로 먼저
    걸러 토큰화 비용을 피한다. */
export function hasAnchorFormula(formulas: Record<string, Record<string, string>>): boolean {
  for (const cells of Object.values(formulas)) {
    for (const formula of Object.values(cells)) {
      if (!formula.includes(ANCHOR_SHEET)) continue;
      try {
        if (isAnchor(tokenize(formula))) return true;
      } catch { /* 토큰화 실패는 앵커가 아니다 */ }
    }
  }
  return false;
}

/** RULING 17 (Task 9 단위 10): `AnchorCtx` 를 만든다. 앵커 수식이 없는 통합문서
    (`part1_5`·`part3` — `KOSIS_원데이터.xlsx` 로의 외부링크가 아예 없어 사람이 2025 를
    손으로 박았다)에는 앵커 자리에 앵커 값을 **직접 심는다**. 그러지 않으면 원데이터를
    2026년치로 받아도 그 두 part 의 연도가 2025 에 얼어붙는다 — 실측으로 지면 374칸
    (part1_5 50 · part3 324)이 얼어붙은 값 대신 계산값을 타게 된다.

    근거 = 「2025 를 타이핑한 사람은 앵커를 옮겨 적고 있었다」. 그 근거를 주석이 아니라
    **검사되는 불변식**으로 박는다: `frozen`(확정본의 앵커 자리 값)을 주면 그것이 앵커와
    같아야 하고, 다르면 던진다. 그 전제가 깨지는 순간 조용히 연도가 밀리는 대신 크게
    깨진다(RULING 7·10 과 같은 태도). 확정본 없이 부르는 쪽(실제 2026년치 생산 경로,
    앵커를 옮겨 보는 시험)은 `frozen` 을 주지 않는다 — 검사할 근거가 없기 때문이다. */
export function makeAnchorCtx(
  formulas: Record<string, Record<string, string>>,
  anchor: number,
  frozen?: string | number | null,
): AnchorCtx {
  if (hasAnchorFormula(formulas)) return { formulas, anchor };   // 앵커 수식이 이긴다
  // 앵커 자리에 (앵커가 아닌) 수식이라도 있으면 그 수식이 이긴다 — 심을 자리가 없다.
  // 단정도 하지 않는다: 주입이 일어나지 않는 곳에서 확정본을 따질 근거가 없다.
  if (typeof formulas[ANCHOR_SEAT.sheet]?.[ANCHOR_SEAT.ref] === 'string') {
    return { formulas, anchor };
  }
  if (frozen !== undefined && frozen !== null && Number(frozen) !== anchor) {
    throw new Error(
      `RULING 17 전제 위반: 확정본 ${ANCHOR_SEAT.sheet}!${ANCHOR_SEAT.ref} 의 얼어붙은 값 ` +
      `${JSON.stringify(frozen)} 이 앵커 ${anchor} 와 다르다 — 이 통합문서의 앵커 자리를 ` +
      `앵커로 볼 근거가 없다. 주입하지 않는다.`);
  }
  return { formulas, anchor, seed: { ...ANCHOR_SEAT } };
}

function evalFormula(ac: AnchorCtx, sheet: string, formula: string): string | number | undefined {
  let toks;
  try {
    toks = tokenize(formula);
  } catch {
    return undefined;                      // 토큰화도 안 되면 계산 불가다
  }
  if (isAnchor(toks)) return ac.anchor;                                  // 규칙 1
  // 규칙 2. 리뷰 1차 [지적 2]: 이 줄은 **지금의 PARSE_CTX 아래서는 중복이다** — extmap 이
  // 비어 있어 외부참조를 품은 수식은 파싱 단계에서 어차피 unsupported 가 된다(실측: 이
  // 줄을 지우고 전 데이터 20,527건을 돌려도 앵커로 풀리는 것 0건). 두 겹이 똑같이
  // undefined 를 내므로 anchorCell 의 반환값만으로는 어느 겹이 막았는지 구별할 수 없고,
  // 따라서 이 줄만 끄고 실패하는 시험은 만들 수 없다. 그래도 남겨 둔다: (1) 브리프가
  // 명시한 경계이고, (2) PARSE_CTX 가 나중에 진짜 extmap 을 받게 되면 SUMIFS 가 파싱에
  // 성공해 NO_DB 에 닿는다 — 이 줄이 그때의 유일한 방어선이다. 대신 「외부참조를 품은
  // 수식은 하나도 앵커로 풀리지 않는다」를 전 데이터 시험(20,527건)으로 못박아 두었다.
  if (toks.some((t) => t.t === 'ref' && t.ext !== null)) return undefined;

  const e = parseFormula(formula, PARSE_CTX);                            // 규칙 3
  if (e.op === 'unsupported') return undefined;
  try {
    const v = execute(e, { db: NO_DB, grids: STRICT_GRIDS, sheet, anchor: ac });
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
  // RULING 17 의 예외는 앵커 자리 한 칸뿐이다: 거기에 수식이 없고 seed 가 있으면
  // 앵커 값을 심는다. 수식이 있으면 위 조건에 걸리지 않으므로 **수식이 언제나 이긴다**.
  if (typeof formula !== 'string') {
    const seeded = ac.seed && ac.seed.sheet === sheet && ac.seed.ref === ref ? ac.anchor : undefined;
    memo.set(key, seeded);
    return seeded;
  }

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
