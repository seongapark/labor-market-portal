export type Src = 'kosis' | 'oecd' | 'etc' | 'panel';

/** 열 문자('C')를 열 이름('DT')으로 옮길 때 쓰는 시트별 헤더 */
export type Headers = Record<string, Record<string, string[]>>;

/** SUMIFS 한 개가 되는 질의 */
export type Query = {
  src: Src;
  table: string;          // 시트명 (KOSIS 는 표ID)
  value: string;          // 값 열 이름 (예 'DT')
  where: Record<string, Crit>;   // 열 이름 → 조건
};

export type Crit =
  | { kind: 'lit'; value: string }        // "계" · ">0" · "<>포르투갈" 같은 리터럴
  // TEXT(<식>,"0") — 실행 시 식을 앵커/격자로 풀어 정수 문자열로 만든다.
  // Task 9 단위 8b: RULING 9 의 「단일 같은시트 셀」 제약을 풀었다 — 앵커로 풀 수 있는
  // 표현식(`_시계열!$B$1-1`)도 받는다. 못 풀면 **던진다**(RULING 10, 예비값 금지).
  | { kind: 'year'; e: Expr }
  // $A14 · C$6 등. Task 9 단위 5: sheet 는 조건 참조가 시트를 한정한 경우다
  // (p116_117!$B30, 실측 1,122건 — 전부 지금 지면과 같은 시트를 가리킨다). 없으면 지금 시트다.
  | { kind: 'cell'; sheet?: string; ref: string }
  // Task 9 단위 8b: 조건이 식으로 온다 — SUBSTITUTE 이스케이프(48건)와 문자 연결(5건).
  // 실행 시 문자로 평가하고, 엑셀의 와일드카드 이스케이프(`~*`→`*`)를 되돌려 문자
  // 그대로 맞힌다(단위 6 이 조회 바늘에서 내린 판단과 같은 규칙).
  | { kind: 'expr'; e: Expr };

/** Task 9 단위 5: 별도데이터(etc)·패널(panel)은 `grid(src, sheet, r, c, v_num, v_txt)` 에
    좌표로만 적재돼 있고 long 테이블이 없다. 헤더 행도 없다 — 사람이 웹 표를 붙여 만든
    시트라서 1행이 인용 줄인 경우까지 있다. 그래서 **열 이름을 쓰지 않고 엑셀처럼 열
    번호로 조회한다**. 이 데이터의 범위 참조는 전부 열 전체($B:$B)라 번호로 바로 옮겨진다.
    열 번호는 `grid.c` 와 같은 1-based 다. */
export type GridQuery = {
  kind: 'grid';
  src: Extract<Src, 'etc' | 'panel'>;
  sheet: string;
  /** SUMIFS 의 합계 열. COUNTIFS 는 세는 것이므로 없다(null). */
  valueCol: number | null;
  crits: { col: number; crit: Crit }[];
};

/** Task 9 단위 6: 격자 위의 사각 범위. VLOOKUP/HLOOKUP 이 찾는 판이다.
    `r1`·`r2` 가 null 이면 열 전체 참조('$A:$B')다 — 행 제한이 없다. */
export type GridRange = {
  src: Extract<Src, 'etc' | 'panel'>;
  sheet: string;
  c1: number; c2: number;
  r1: number | null; r2: number | null;
};

/** Task 9 단위 7: **지면 격자 위**의 사각 범위(같은 통합문서). `sheet` 가 없으면 지금
    시트다. 값은 DB 도 grid 도 아니라 `ExecCtx.grids`(+`anchorCell`)에서 읽는다 —
    이미 계산된 칸들을 범위로 묶는 것이 이 단위의 전부다. */
export type CellRange = { sheet?: string; r1: number; c1: number; r2: number; c2: number };

/** SUM(A1:A3) 처럼 범위로 오거나 SUM(C22) 처럼 값 하나로 온다 */
export type RangeArg = { range: CellRange } | { expr: Expr };

/** 위치를 맞춰 세는 술어. 범위 대상 COUNTIFS 와 (측정된 한 모양의) SUMPRODUCT 가 쓴다. */
export type RangePred =
  | { kind: 'isnumber'; range: CellRange }
  | { kind: 'crit'; range: CellRange; crit: Expr };   // 조건은 실행 시 문자열로 평가된다

export type Expr =
  // Task 9 단위 5: long 테이블 질의(Query)와 격자 질의(GridQuery) 둘 다 온다.
  // 집계 종류는 op 하나가 정한다 — GridQuery 에 agg 를 또 두면 두 곳이 어긋날 수 있다.
  | { op: 'sumifs'; q: Query | GridQuery }
  | { op: 'countifs'; q: Query | GridQuery }
  | { op: 'add'; args: Expr[] }
  | { op: 'sub'; a: Expr; b: Expr }
  | { op: 'div'; a: Expr; b: Expr }
  | { op: 'mul'; a: Expr; b: Expr }
  | { op: 'pct'; inner: Expr }            // 뒤에 % 가 붙은 것 (×100 아니다 — 엑셀 % 는 ÷100)
  | { op: 'const'; v: number }
  | { op: 'cell'; sheet?: string; ref: string }  // 셀 (sheet 없으면 같은 시트)
  | { op: 'zeroDash'; inner: Expr }       // IF(x=0,"-",x)
  | { op: 'str'; v: string }              // 문자열 리터럴 — "-" · "…" · "OECD" 등
  | { op: 'if'; cond: Expr; then: Expr; else: Expr }
  // Task 9 단위 3: 비교는 불리언이 아니라 1/0 을 낸다 — execute 의 공개 반환 타입이
  // number | string | null 로 그대로 유지되어 Task 7/8 을 건드리지 않는다. if 는
  // 0 이 아니고 빈 문자열도 아닌 결과를 참으로 본다. 비교가 수식 전체로 단독 쓰이면
  // 1/0 이 그대로 드러나 불일치로 잡힌다 — 이건 의도된 것이다(조용한 오답보다 낫다).
  | { op: 'cmp'; rel: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; a: Expr; b: Expr }
  | { op: 'and'; args: Expr[] }
  | { op: 'isnumber'; inner: Expr }
  // TEXT(x,"0.0") 같은 형식 — 결과는 문자열. group 은 "#,##0" 처럼 형식에 천단위
  // 구분자가 있는 경우다(Task 9 단위 8: & 로 이어붙이면 구분자가 지면에 그대로 찍힌다).
  | { op: 'text'; inner: Expr; decimals: number; group?: boolean }
  | { op: 'iferror'; inner: Expr; fallback: Expr }
  // Task 9 단위 4 (CHANGE 2): NUMBERVALUE(x) — "69.3%" 같은 문자열을 숫자로 읽는다.
  // 껍데기만 벗기던 예전 동작(문자열이 그대로 산술로 새어나가 num() 이 0 으로 뭉갬)을
  // 대체한다. 파싱 못하면 execute 가 오류(null)를 낸다 — 0 으로 조용히 넘기지 않는다.
  | { op: 'numbervalue'; inner: Expr }
  // Task 9 단위 8: 문자열 이어붙이기 a&b — 지면의 연도 씨앗셀이 이 모양이다
  // (=(_시계열!$B$1-3)&"년" → "2022년"). 결과는 언제나 문자열이다.
  | { op: 'concat'; args: Expr[] }
  // Task 9 단위 6 — 같은 grid 표를 다른 모양으로 읽는 갈래들
  /** '[N]0_수집현황'!$A$1 — 지면에 앵커가 직접 놓인 셀(실측 1건: part1_4(1)!p67!B1) */
  | { op: 'anchor' }
  /** 격자의 한 칸. 빈 칸은 0 이다(엑셀에서 빈 칸 참조는 0). */
  | { op: 'gridcell'; src: Extract<Src, 'etc' | 'panel'>; sheet: string; r: number; c: number }
  /** VLOOKUP(dir 'v')·HLOOKUP(dir 'h') — 정확히 일치(네 번째 인자 0)만. 못 찾으면 #N/A(null) */
  // Task 9 단위 7: 범위가 `CellRange` 면 외부 데이터가 아니라 지면 격자에서 찾는다.
  | { op: 'lookup'; dir: 'v' | 'h'; needle: Expr; range: GridRange | CellRange; index: Expr }
  | { op: 'substitute'; inner: Expr; find: Expr; replace: Expr }
  | { op: 'left'; inner: Expr; n: Expr }
  | { op: 'right'; inner: Expr; n: Expr }
  // Task 9 단위 7 — 지면 내부 범위 함수
  | { op: 'agg'; fn: 'sum' | 'max' | 'counta'; args: RangeArg[] }
  /** 위치를 맞춰 「모든 술어를 만족하는 칸 수」를 센다 — 범위 대상 COUNTIFS 와
      측정된 한 모양의 SUMPRODUCT(--ISNUMBER(범위),--(범위<>"문자")) 가 같은 셈이다. */
  | { op: 'rangecount'; preds: RangePred[] }
  | { op: 'index'; range: CellRange; n: Expr }
  | { op: 'match'; needle: Expr; range: CellRange }   // 세 번째 인자 0(정확히 일치)만
  | { op: 'n'; inner: Expr }                          // N(x) — 수치면 그대로, 아니면 0
  | { op: 'len'; inner: Expr }
  | { op: 'find'; needle: Expr; inside: Expr }        // 1-based. 못 찾으면 #VALUE!
  | { op: 'quotient'; a: Expr; b: Expr }
  | { op: 'mod'; a: Expr; b: Expr }
  | { op: 'round'; inner: Expr; digits: Expr }
  | { op: 'averageifs'; q: Query }                    // long 테이블(oecd_obs) 대상
  // 전체 리뷰 F1: `presentation` 인지는 **던진 자리**가 정한다 — 예외 메시지에 함수
  // 이름이 있는지로 되맞히면(옛 방식) 전혀 다른 이유로 깨진 칸이 조용히 관문의 분모에서
  // 빠진다. parse.ts 의 `PresentationRefusal` 만 이 표식을 싣는다.
  | { op: 'unsupported'; reason: string; formula: string; presentation?: true };

/** 한 시트의 값 격자. 셀 참조를 푸는 데 쓴다. 'A14' → 값 */
export type Grid = Record<string, string | number | null>;

/** Task 9 단위 11 (물화): 셀 하나의 **질의 명세**. 수식 문자열도 열 문자도 담지 않는다 —
    열 이름이 이미 해석된 `Expr` 이다. 그게 엑셀에서 벗어나는 지점이다.
    다룰 수 없는 셀도 **사유와 함께** 담는다: 빠뜨리면 다음 회차가 「이 셀은 왜 없나」를
    다시 조사해야 한다(특히 presentation 3,364건은 분류에 실측이 필요했다). */
export type CellSpec =
  | { kind: 'expr'; e: Expr }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'presentation'; reason: string };

/** part 하나의 물화된 cellmap. 보조시트(`_`)도 담는다 — 앵커 사슬과 지면 간 참조가
    거기 있고, 그것까지 담아야 엑셀 없이 연도를 옮길 수 있다. */
export type CellMap = {
  part: string;
  /** 이 통합문서에 앵커 수식이 있는가 (`{op:'anchor'}` 명세가 하나라도 있는가).
      없으면 RULING 17 의 주입 대상이다 — 관문이 그것을 판단한다. */
  hasAnchor: boolean;
  sheets: Record<string, Record<string, CellSpec>>;
};
