import type { DatabaseSync } from 'node:sqlite';
import type { Crit, Expr, Grid, Query } from '../types.ts';

/** RULING 8: ExecCtx 는 파트 전체의 격자(시트명 → Grid)를 들고, 지금 계산 중인 시트를 함께 표시한다.
    booklet 페이지 간 셀 참조('p68'!$F$5)와 보조시트(_시계열) 참조가 실측으로 8%+6% 나와,
    단일 grid 로는 풀 수 없다는 것을 Task 5 가 확인했다.
    RULING 10: year 필드는 더 이상 연도 조건(critValue 의 'year' 분기)에 쓰이지 않는다 —
    그 분기는 이제 격자에 셀이 없으면 이 값으로 조용히 대체하지 않고 던진다. Task 8 의
    verifyPart 호출부 시그니처를 건드리지 않기 위해 필드 자체는 남겨 둔다. */
export type ExecCtx = { db: DatabaseSync; grids: Record<string, Grid>; sheet: string; year: string };

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

/** ">0" · ">=5" · "<>계" 같은 비교 조건을 SQL 조각으로 */
function critSql(col: string, raw: string): { sql: string; args: (string | number)[] } {
  const m = /^(<=|>=|<>|<|>)\s*(.+)$/.exec(raw);
  if (!m) return { sql: `${col} = ?`, args: [raw] };
  const op = m[1] === '<>' ? '!=' : m[1];
  const rhs = m[2];
  const num = Number(rhs);
  if (Number.isFinite(num) && rhs.trim() !== '') {
    return { sql: `CAST(${col} AS REAL) ${op} ?`, args: [num] };
  }
  return { sql: `${col} ${op} ?`, args: [rhs] };
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

export function execute(e: Expr, ctx: ExecCtx): number | string | null {
  switch (e.op) {
    case 'sumifs': return runIfs(e.q, ctx, 'SUM');
    case 'countifs': return runIfs(e.q, ctx, 'COUNT');
    case 'const': return e.v;
    case 'cell': return gridCell(ctx, e.sheet ?? ctx.sheet, e.ref);
    case 'add': return e.args.reduce((s, a) => s + num(execute(a, ctx)), 0);
    case 'sub': return num(execute(e.a, ctx)) - num(execute(e.b, ctx));
    case 'mul': return num(execute(e.a, ctx)) * num(execute(e.b, ctx));
    case 'div': {
      const b = num(execute(e.b, ctx));
      if (b === 0) return null;              // 엑셀은 #DIV/0! — 대조에서 걸러낸다
      return num(execute(e.a, ctx)) / b;
    }
    case 'pct': return num(execute(e.inner, ctx)) / 100;
    case 'zeroDash': {
      const v = num(execute(e.inner, ctx));
      return v === 0 ? '-' : v;
    }
    case 'unsupported': return null;
  }
}
