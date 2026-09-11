import type { DatabaseSync } from 'node:sqlite';
import { anchorCell, type AnchorCtx } from './anchor.ts';
import type { Crit, Expr, Grid, Query } from '../types.ts';

/** RULING 8: ExecCtx 는 파트 전체의 격자(시트명 → Grid)를 들고, 지금 계산 중인 시트를 함께 표시한다.
    booklet 페이지 간 셀 참조('p68'!$F$5)와 보조시트(_시계열) 참조가 실측으로 8%+6% 나와,
    단일 grid 로는 풀 수 없다는 것을 Task 5 가 확인했다.
    RULING 10: year 필드는 더 이상 연도 조건(critValue 의 'year' 분기)에 쓰이지 않는다 —
    그 분기는 이제 격자에 셀이 없으면 이 값으로 조용히 대체하지 않고 던진다. Task 8 의
    verifyPart 호출부 시그니처를 건드리지 않기 위해 필드 자체는 남겨 둔다.
    RULING 11 (Task 9 단위 8): anchor 를 주면 셀 값은 **먼저 앵커에서 계산한다**. 앵커로 못
    구하는 셀만 지금까지처럼 격자(확정본)로 떨어진다. anchor 가 없으면 동작은 전과 똑같다. */
export type ExecCtx = {
  db: DatabaseSync; grids: Record<string, Grid>; sheet: string; year: string;
  anchor?: AnchorCtx;
};

/** jsonl 키 → obs 열 (parse 가 내는 이름은 대문자 헤더 이름이다) */
const COL: Record<string, string> = {
  PRD_DE: 'prd_de', ITM_ID: 'itm_id', ITM_NM: 'itm_nm',
  C1_OBJ_NM: 'c1_obj_nm', C1: 'c1', C1_NM: 'c1_nm',
  C2_OBJ_NM: 'c2_obj_nm', C2: 'c2', C2_NM: 'c2_nm',
  C3_OBJ_NM: 'c3_obj_nm', C3: 'c3', C3_NM: 'c3_nm',
  C4_OBJ_NM: 'c4_obj_nm', C4: 'c4', C4_NM: 'c4_nm',
  UNIT_NM: 'unit_nm', DT: 'dt',
};

function dbCol(name: string): string {
  const c = COL[name.toUpperCase()];
  if (!c) throw new Error('모르는 열 이름: ' + name);
  return c;
}

/** RULING 8: 시트를 명시하면 그 시트의 격자에서, 아니면 지금 시트의 격자에서 읽는다.
    없는 시트·없는 셀은 null 이다 — 예외를 던지지 않는다. 오라클과 대조할 때(8단계) 불일치로
    잡히길 바라는 신호이기 때문이다. */
function gridCell(ctx: ExecCtx, sheet: string, ref: string): string | number | null {
  // RULING 11: 앵커에서 계산할 수 있는 셀(연도 사슬과 그 씨앗셀)은 확정본을 읽지 않고
  // 계산한다 — 원데이터가 2026년치로 바뀌면 연도도 따라 움직여야 하기 때문이다.
  if (ctx.anchor) {
    const a = anchorCell(ctx.anchor, sheet, ref);
    if (a !== undefined) return a;
  }
  const v = ctx.grids[sheet]?.[ref];
  return v === undefined ? null : v;
}

function critValue(c: Crit, ctx: ExecCtx): string {
  if (c.kind === 'year') {
    // FIX ROUND 1: TEXT(C$6,"0") 은 "C6 가 가리키는 값을 정수로" 다 — 연도는 c.ref 가
    // 가리키는 셀 그 자체에서 읽는다.
    // RULING 10: gridCell 은 "키가 아예 없다"와 "값이 명시적으로 null 이다"를 구별하지
    // 못한다. 예비값으로 ctx.year 를 돌려주면 202개 지면 어딘가의 빈 칸·병합된 연도
    // 머리글이 조용히 기준연도의 답을 받고 대조에서 절대 드러나지 않는다 — 던져서
    // verifyPart(8단계) 가 error 판정으로 잡게 한다. 조용히 틀린 값보다 크래시가 낫다
    // (RULING 7 과 같은 원칙).
    // RULING 11: gridCell 이 anchor 를 먼저 본다 — 연도 조건은 anchor 가 있으면 앵커에서
    // 계산된 값을 받고, 앵커로 못 구할 때만 격자로 떨어진다. 아래 문자열 변환은 그대로
    // 거치므로 SUMIFS 기준값의 모양(정수 문자열)은 변하지 않는다.
    const v = gridCell(ctx, ctx.sheet, c.ref);
    if (v === null) throw new Error(`연도 조건 셀이 격자에 없다: ${ctx.sheet}!${c.ref}`);
    // prd_de·TIME_PERIOD 는 TEXT 열이다 — 숫자를 그대로 두면 "2025.0" 같은 꼴이
    // 되므로 정수 문자열로 맞추고, 이미 문자열이면 값은 손대지 않고 앞뒤 공백만 지운다.
    return typeof v === 'number' ? String(Math.round(v) === v ? Math.round(v) : v) : v.trim();
  }
  if (c.kind === 'lit') return c.value;
  // Crit 의 cell 은 sheet 를 갖지 않는다 — SUMIFS/COUNTIFS 조건은 이 데이터에서 항상
  // 지금 시트를 가리키기 때문이다 (RULING 8). ctx.grids[ctx.sheet] 에서 읽는다.
  const v = gridCell(ctx, ctx.sheet, c.ref);
  if (v === undefined || v === null) throw new Error(`격자에 ${c.ref} 가 없다`);
  // 연도 헤더가 숫자로 들어있는 경우 정수 문자열로 맞춘다
  return typeof v === 'number' ? String(Math.round(v) === v ? Math.round(v) : v) : String(v);
}

/** ">0" · ">=5" · "<>계" 같은 비교 조건을 SQL 조각으로
    FIX(대조 9-1): 엑셀 SUMIFS 의 텍스트 기준 비교는 대소문자를 구별하지 않는다
    (예: 헬퍼셀 'pop' 이 DB 의 'POP' 과 같다고 본다). 우리 SQL 의 '=' 는 대소문자를
    구별해 실측에서 2,100건의 불일치(들어오는 값이 전부 '-')를 냈다. 텍스트 기준에만
    COLLATE NOCASE 를 붙인다 — ASCII A~Z 만 접는 콜레이션이라 코드값(ASCII)에는
    맞고 한글 기준값에는 영향이 없다. 숫자 비교(CAST ... AS REAL)는 건드리지 않는다. */
function critSql(col: string, raw: string): { sql: string; args: (string | number)[] } {
  const m = /^(<=|>=|<>|<|>)\s*(.+)$/.exec(raw);
  if (!m) return { sql: `${col} = ? COLLATE NOCASE`, args: [raw] };
  const op = m[1] === '<>' ? '!=' : m[1];
  const rhs = m[2];
  const num = Number(rhs);
  if (Number.isFinite(num) && rhs.trim() !== '') {
    return { sql: `CAST(${col} AS REAL) ${op} ?`, args: [num] };
  }
  return { sql: `${col} ${op} ? COLLATE NOCASE`, args: [rhs] };
}

/** RULING 7: 소스마다 열 이름 체계가 달라 테이블이 나뉜다.
    - kosis → obs. 헤더 이름을 COL 로 스네이크케이스 열에 매핑하고, obs 가 src 열을 갖고
      있으므로 src = 'kosis' 도 함께 건다.
    - oecd → oecd_obs. 헤더 이름이 곧 열 이름이라 매핑이 없다. 열 이름에 한글('국가명')과
      소문자 영어('value')가 섞여 있어 모든 식별자를 큰따옴표로 인용한다.
    - etc·panel → 아직 long 테이블이 없다 (grid 좌표로만 적재됨). 0 을 돌려주면 정당한 0 과
      구별할 수 없어 대조를 속이게 되므로, 던진다. 9단계가 이 소스들에 long 뷰를 만들 것이다. */
function runIfs(q: Query, ctx: ExecCtx, agg: 'SUM' | 'COUNT'): number {
  if (q.src === 'kosis') {
    const where: string[] = ['src = ?', 'table_id = ?'];
    const args: (string | number)[] = ['kosis', q.table];
    for (const [name, crit] of Object.entries(q.where)) {
      const col = dbCol(name);
      const { sql, args: a } = critSql(col, critValue(crit, ctx));
      where.push(sql);
      args.push(...a);
    }
    const target = dbCol(q.value);
    const sql = agg === 'SUM'
      ? `SELECT COALESCE(SUM(${target}), 0) AS v FROM obs WHERE ${where.join(' AND ')}`
      : `SELECT COUNT(${target}) AS v FROM obs WHERE ${where.join(' AND ')}`;
    const row = ctx.db.prepare(sql).get(...args) as { v: number } | undefined;
    return row ? Number(row.v) : 0;
  }

  if (q.src === 'oecd') {
    const where: string[] = [`"table_id" = ?`];
    const args: (string | number)[] = [q.table];
    for (const [name, crit] of Object.entries(q.where)) {
      const col = `"${name}"`;
      const { sql, args: a } = critSql(col, critValue(crit, ctx));
      where.push(sql);
      args.push(...a);
    }
    const target = `"${q.value}"`;
    const sql = agg === 'SUM'
      ? `SELECT COALESCE(SUM(${target}), 0) AS v FROM oecd_obs WHERE ${where.join(' AND ')}`
      : `SELECT COUNT(${target}) AS v FROM oecd_obs WHERE ${where.join(' AND ')}`;
    const row = ctx.db.prepare(sql).get(...args) as { v: number } | undefined;
    return row ? Number(row.v) : 0;
  }

  throw new Error(`실행 불가: src '${q.src}' 는 long 테이블이 없다 (grid 좌표만 적재됨)`);
}

function num(v: number | string | null): number {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Task 9 단위 4 (CHANGE 3): 산술(add/sub/mul/div/pct) 전용. num() 과 달리 숫자로도
    빈 값으로도 못 읽는 문자열 피연산자를 0 으로 조용히 뭉개지 않고 오류(null)를 낸다.
    엑셀은 텍스트를 산술에 넣으면 #VALUE! 를 낸다 — IFERROR(B10*100/A10-100,"-") 에서
    A10="실질임금"(라벨)이면 우리도 "-" 를 내야지 -100 을 내면 안 된다.
    null(이미 오류인 하위식) 은 그대로 오류로 흘려보낸다. 빈 문자열은 지금까지처럼
    0 이다(Number('') === 0) — zeroDash 가 기대는 5,754건과 무관하다: zeroDash 는 이
    함수를 쓰지 않고 num() 을 그대로 쓴다(SUM 이 이미 0 을 낸다). */
function numOrErr(v: number | string | null): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Task 9 단위 4 (CHANGE 2): NUMBERVALUE — 숫자면 그대로, 문자열이면 천단위 구분자를
    지우고 끝의 '%' 는 ÷100 으로 읽는다. 못 읽으면 오류(null) — 0 이 아니다. */
function numberValue(v: number | string | null): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = v.trim();
  if (s === '') return null;
  let pct = false;
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
  s = s.replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

/** Task 9 단위 8: & 가 숫자를 문자로 바꿀 때 엑셀은 일반(General) 서식을 쓴다 —
    2025 는 "2025" 이지 "2025.0" 이 아니다. 부동소수 꼬리는 유효자릿수 15 로 잘라
    없앤다(엑셀이 표시하는 자릿수와 같다). null 은 오류이므로 그대로 null 이다. */
function textOf(v: number | string | null): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return null;
  return String(Number(v.toPrecision(15)));
}

/** Task 9 단위 3: if 가 참으로 볼 값 — 0 이 아니고 빈 문자열도 아니면 참이다.
    null 은 거짓이다(연도 조건 셀이 없어 던지는 경우는 여기 오지 않는다 — 그건 예외다). */
function truthy(v: number | string | null): boolean {
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  return v !== '';
}

/** eq/ne 는 문자열 비교('OECD' 등)라 num() 으로 뭉개면 안 된다 — 숫자가 아닌 문자열은
    둘 다 0 이 되어 항상 같다고 오판한다. lt/lte/gt/gte 는 이 데이터에서 전부 연도
    비교(B$21<2020)라 숫자로 비교한다. */
function cmpResult(rel: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
                    a: number | string | null, b: number | string | null): boolean {
  if (rel === 'eq' || rel === 'ne') {
    const eq = a === null || b === null
      ? a === b
      : (typeof a === 'string' || typeof b === 'string') ? String(a) === String(b) : a === b;
    return rel === 'eq' ? eq : !eq;
  }
  const x = num(a), y = num(b);
  switch (rel) {
    case 'lt': return x < y;
    case 'lte': return x <= y;
    case 'gt': return x > y;
    case 'gte': return x >= y;
  }
}

/** TEXT(x,"0.0") — 반올림은 반올림기준 0.5 를 항상 0에서 먼 쪽으로 보낸다(사사오입).
    정수로 올려붙인 뒤 다시 나누고 toFixed 로 자릿수를 맞춘다 — 부동소수 오차가
    반올림 경계에 걸리는 것을 피한다.
    Task 9 단위 4 (CHANGE 4): 엑셀은 부동소수 오차를 그대로 반올림하지 않는다 — 먼저
    유효자릿수 15 자리로 줄인 값을 쓴다. 21.049999999999997 은 수학적으로는 21.0 으로
    반올림되지만, 15 유효자릿수로 줄이면 정확히 21.05 가 되고 그 다음에야 사사오입해
    21.1 이 된다. 두 단계를 순서대로 밟아야 한다 — 한 번에 반올림하면 21.0 이 나와
    틀린다(part3!p223!O31 실측). */
function textFixed(n: number, decimals: number, group = false): string {
  const n15 = Number(n.toPrecision(15));
  const factor = 10 ** decimals;
  const rounded = Math.sign(n15) * Math.round(Math.abs(n15) * factor);
  const s = (rounded / factor).toFixed(decimals);
  if (!group) return s;
  // Task 9 단위 8: "#,##0" 은 천단위 구분자를 찍는다. 정수부만 세 자리씩 끊는다.
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+$)/g, ',');
  return (neg ? '-' : '') + grouped + (frac ? '.' + frac : '');
}

export function execute(e: Expr, ctx: ExecCtx): number | string | null {
  switch (e.op) {
    case 'sumifs': return runIfs(e.q, ctx, 'SUM');
    case 'countifs': return runIfs(e.q, ctx, 'COUNT');
    case 'const': return e.v;
    case 'cell': return gridCell(ctx, e.sheet ?? ctx.sheet, e.ref);
    case 'add': {
      let sum = 0;
      for (const a of e.args) {
        const v = numOrErr(execute(a, ctx));
        if (v === null) return null;          // 텍스트 피연산자 — 엑셀은 #VALUE!
        sum += v;
      }
      return sum;
    }
    case 'sub': {
      const a = numOrErr(execute(e.a, ctx));
      const b = numOrErr(execute(e.b, ctx));
      if (a === null || b === null) return null;
      return a - b;
    }
    case 'mul': {
      const a = numOrErr(execute(e.a, ctx));
      const b = numOrErr(execute(e.b, ctx));
      if (a === null || b === null) return null;
      return a * b;
    }
    case 'div': {
      const a = numOrErr(execute(e.a, ctx));
      const b = numOrErr(execute(e.b, ctx));
      if (a === null || b === null) return null;
      if (b === 0) return null;              // 엑셀은 #DIV/0! — 대조에서 걸러낸다
      return a / b;
    }
    case 'pct': {
      const v = numOrErr(execute(e.inner, ctx));
      return v === null ? null : v / 100;
    }
    case 'numbervalue': return numberValue(execute(e.inner, ctx));
    case 'concat': {
      let s = '';
      for (const a of e.args) {
        const t = textOf(execute(a, ctx));
        if (t === null) return null;         // 오류인 하위식은 그대로 오류로 흘려보낸다
        s += t;
      }
      return s;
    }
    case 'zeroDash': {
      const v = num(execute(e.inner, ctx));
      return v === 0 ? '-' : v;
    }
    case 'str': return e.v;
    case 'if': return truthy(execute(e.cond, ctx)) ? execute(e.then, ctx) : execute(e.else, ctx);
    case 'cmp': return cmpResult(e.rel, execute(e.a, ctx), execute(e.b, ctx)) ? 1 : 0;
    case 'and': return e.args.every((a) => truthy(execute(a, ctx))) ? 1 : 0;
    case 'isnumber': {
      const v = execute(e.inner, ctx);
      return typeof v === 'number' && Number.isFinite(v) ? 1 : 0;
    }
    case 'text': return textFixed(num(execute(e.inner, ctx)), e.decimals, e.group);
    case 'iferror': {
      // Task 9 단위 3: inner 의 실행 결과가 null 이면 오류로 본다(div 는 0 나눗셈을
      // null 로 낸다) — fallback 을 실행한다. null 이 아니면 inner 값을 그대로 낸다.
      const v = execute(e.inner, ctx);
      return v === null ? execute(e.fallback, ctx) : v;
    }
    case 'unsupported': return null;
  }
}
