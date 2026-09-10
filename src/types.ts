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
  | { kind: 'lit'; value: string }        // "계" 같은 리터럴
  | { kind: 'year'; ref: string }         // TEXT(C$6,"0") — 실행 시 ref 가 가리키는 셀에서 읽는다
  | { kind: 'cell'; ref: string };        // $A14 · C$6 등

export type Expr =
  | { op: 'sumifs'; q: Query }
  | { op: 'countifs'; q: Query }
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
  | { op: 'text'; inner: Expr; decimals: number }   // TEXT(x,"0.0") 같은 형식 — 결과는 문자열
  | { op: 'iferror'; inner: Expr; fallback: Expr }
  | { op: 'unsupported'; reason: string; formula: string };

/** 한 시트의 값 격자. 셀 참조를 푸는 데 쓴다. 'A14' → 값 */
export type Grid = Record<string, string | number | null>;
