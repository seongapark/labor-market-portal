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
  | { kind: 'year'; ref: string }         // TEXT(C$6,"0") — 실행 시 ref 가 가리키는 셀에서 읽는다
  // $A14 · C$6 등. Task 9 단위 5: sheet 는 조건 참조가 시트를 한정한 경우다
  // (p116_117!$B30, 실측 1,122건 — 전부 지금 지면과 같은 시트를 가리킨다). 없으면 지금 시트다.
  | { kind: 'cell'; sheet?: string; ref: string };

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
  | { op: 'unsupported'; reason: string; formula: string };

/** 한 시트의 값 격자. 셀 참조를 푸는 데 쓴다. 'A14' → 값 */
export type Grid = Record<string, string | number | null>;
