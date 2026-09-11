import type { DatabaseSync } from 'node:sqlite';
import { anchorCell, type AnchorCtx } from './anchor.ts';
import { colLetters } from '../cellmap/parse.ts';
import type { CellRange, Crit, Expr, Grid, GridQuery, Query, RangeArg, RangePred } from '../types.ts';

/** RULING 8: ExecCtx 는 파트 전체의 격자(시트명 → Grid)를 들고, 지금 계산 중인 시트를 함께 표시한다.
    booklet 페이지 간 셀 참조('p68'!$F$5)와 보조시트(_시계열) 참조가 실측으로 8%+6% 나와,
    단일 grid 로는 풀 수 없다는 것을 Task 5 가 확인했다.
    RULING 10: 연도 조건(critValue 의 'year' 분기)은 기준연도 예비값으로 조용히
    대체하지 않고 던진다.
    RULING 11 (Task 9 단위 8): anchor 를 주면 셀 값은 **먼저 앵커에서 계산한다**. 앵커로 못
    구하는 셀만 지금까지처럼 격자(확정본)로 떨어진다. anchor 가 없으면 동작은 전과 똑같다.
    Task 9 단위 10: `year` 필드를 없앴다. RULING 10 이후로 읽는 곳이 한 군데도 없어
    「기준연도를 여기 주면 무언가 달라진다」는 거짓 손잡이였고, 단위 8 로 기준연도의
    유일한 출처가 anchor 가 되면서 함정이 됐다(리뷰 지적 6). 기준연도를 옮기려면
    anchor 를 옮긴다. verifyPart 의 시그니처는 그대로다. */
export type ExecCtx = {
  db: DatabaseSync; grids: Record<string, Grid>; sheet: string;
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

/** 전체 리뷰 F2: 엑셀 조건 문자열(`">0"` · `"<>OECD"` · `"<>"` · `"=계"` · `"계"`)의
    연산자를 **긴 것부터 정확히 끊어** 읽는다. 세 조건 경로(`gridCritSql`·`matchCrit`·
    `critSql`)가 **이 함수만** 쓴다 — 경로마다 다른 정규식을 두면 같은 조건이 경로마다
    다른 뜻이 된다(리뷰가 `<>`(빈 우변)와 `=`(접두) 두 지점에서 실제로 그것을 찾아냈다).

    정규식으로 풀지 않는다. 옛 `critSql` 의 `/^(<=|>=|<>|<|>)\s*(.+)$/` 는 우변이 빈
    `"<>"` 에서 `(.+)` 가 한 글자를 요구해 **백트래킹**이 일어나 연산자 `<` · 우변 `'>'`
    로 갈렸다. 그 조건이 맞고 있던 유일한 이유는 `oecd_obs.value` 가 REAL 이고 SQLite 가
    숫자를 문자보다 앞에 정렬해 `value < '>'` 가 우연히 `value IS NOT NULL` 과 같아진
    것이었다 — TEXT 조건 열(모든 KOSIS 열)에서는 같은 조건이 조용히 0 을 낸다.

    연산자가 없으면 `=` 다(엑셀). 연산자 뒤의 공백은 버린다(`"> 6"`). */
export type CritOp = '<>' | '>=' | '<=' | '>' | '<' | '=';
const CRIT_OPS: readonly CritOp[] = ['<>', '>=', '<=', '>', '<', '='];

export function splitCrit(raw: string): { op: CritOp; rhs: string; blank: boolean } {
  for (const op of CRIT_OPS) {
    if (raw.startsWith(op)) {
      const rhs = raw.slice(op.length).replace(/^\s+/, '');
      return { op, rhs, blank: rhs.trim() === '' };
    }
  }
  return { op: '=', rhs: raw, blank: raw.trim() === '' };
}

/** Task 9 단위 5: 격자 조건 하나를 SQL 조각으로. `alias` 는 조인 별칭이다.
    엑셀 의미 세 가지를 지킨다:
    - 문자 비교는 대소문자를 구분하지 않는다(RULING 13 — 빼먹으면 조용히 0 이 나온다).
    - 조건값이 숫자로 읽히면 v_num 과도 맞춘다. 적재기가 엑셀 셀 타입을 그대로 옮겨
      "202508" 같은 숫자꼴 문자열이 v_txt 에 남아 있기 때문에 양쪽을 다 본다.
    - `<>` 는 **빈 칸에도 맞는다**. 격자에는 빈 칸의 행이 아예 없으므로(적재 때 버렸다)
      LEFT JOIN 으로 붙이고 `alias.r IS NULL` 을 허용한다 — 그래서 negated 를 돌려준다.
      숫자 칸(v_txt IS NULL)이 문자 조건과 "같지 않다"인 경우도 COALESCE 로 받는다. */
function gridCritSql(alias: string, raw: string | null): { sql: string; args: (string | number)[]; negated: boolean } {
  // RULING 18: 빈 조건은 빈 칸에만 맞는다. 격자에는 빈 칸의 행이 아예 없으므로
  // (적재 때 버렸다) 아무것도 맞지 않는다 — 실측 대상에는 이 경우가 없다.
  if (raw === null) return { sql: `${alias}.v_txt = ''`, args: [], negated: false };
  const { op, rhs, blank } = splitCrit(raw);
  const num = blank ? NaN : Number(rhs);
  const isNum = Number.isFinite(num);

  const eqSql = isNum
    ? `(${alias}.v_txt = ? COLLATE NOCASE OR ${alias}.v_num = ?)`
    : `${alias}.v_txt = ? COLLATE NOCASE`;
  const eqArgs: (string | number)[] = isNum ? [rhs, num] : [rhs];

  if (op === '=') return { sql: eqSql, args: eqArgs, negated: false };
  if (op === '<>') {
    // 전체 리뷰 F2: 우변이 비면(`"<>"`) 엑셀의 뜻은 **「빈 칸이 아닌 것」**이다 —
    // 「무엇과도 같지 않은 것」이 아니다. 격자에는 빈 칸의 행이 아예 없으므로
    // (적재 때 버렸다) **값이 있는 행**이 곧 조건이고, 그래서 부정형이 아니다
    // (LEFT JOIN 으로 빈 칸까지 받으면 엑셀과 반대가 된다).
    if (blank) {
      return { sql: `(${alias}.v_num IS NOT NULL OR COALESCE(${alias}.v_txt, '') <> '')`,
               args: [], negated: false };
    }
    return { sql: `(${alias}.r IS NULL OR NOT COALESCE(${eqSql}, 0))`, args: eqArgs, negated: true };
  }
  if (isNum) return { sql: `${alias}.v_num ${op} ?`, args: [num], negated: false };
  return { sql: `${alias}.v_txt ${op} ? COLLATE NOCASE`, args: [rhs], negated: false };
}

/** Task 9 단위 5: 별도데이터·패널의 SUMIFS/COUNTIFS — grid 자기조인.
    조건 하나마다 (src, sheet, r) 가 같고 c 가 그 열인 행을 붙인다. grid 의 PK 가
    (src, sheet, r, c) 라 조인은 전부 PK 점조회다(etc 는 시트 26개 · 43,981칸뿐이다).

    기준 테이블(b):
    - SUM: **값 열**이다. 조건에 맞는 행인데 값 칸이 비어 있으면 엑셀은 0 을 더하므로,
      그 행이 빠져도 합은 같다. 문자 칸은 v_num 이 NULL 이라 SUM 이 무시한다 — 엑셀도
      SUMIFS 에서 문자를 더하지 않는다.
    - COUNT: **첫 긍정 조건의 열**이다. COUNTIFS 는 행을 세는 것이고, 긍정 조건에 맞는
      행은 그 칸이 반드시 비어 있지 않으므로 그 열이 행 우주가 된다. 조건이 전부
      부정형(`<>`)이면 행 우주를 알 수 없어 던진다 — 조용히 0 을 내지 않는다. */
function runGridIfs(q: GridQuery, ctx: ExecCtx, agg: 'SUM' | 'COUNT' | 'AVG'): number {
  const parts = q.crits.map((c, i) => {
    const { sql, args, negated } = gridCritSql(`k${i}`, critValue(c.crit, ctx));
    return { alias: `k${i}`, col: c.col, sql, args, negated };
  });

  let baseCol: number;
  if (agg === 'SUM') {
    if (q.valueCol === null) throw new Error('SUMIFS 인데 합계 열이 없다');
    baseCol = q.valueCol;
  } else {
    const positive = parts.find((p) => !p.negated);
    if (!positive) throw new Error('COUNTIFS 조건이 전부 부정형이다 — 행 우주를 알 수 없다');
    baseCol = positive.col;
  }

  const args: (string | number)[] = [];
  const joins: string[] = [];
  for (const p of parts) {
    joins.push(`${p.negated ? 'LEFT JOIN' : 'JOIN'} grid ${p.alias}`
      + ` ON ${p.alias}.src = b.src AND ${p.alias}.sheet = b.sheet`
      + ` AND ${p.alias}.r = b.r AND ${p.alias}.c = ?`);
    args.push(p.col);
  }
  const where = ['b.src = ?', 'b.sheet = ?', 'b.c = ?'];
  args.push(q.src, q.sheet, baseCol);
  for (const p of parts) { where.push(p.sql); args.push(...p.args); }

  // 한 행도 없으면 SUMIFS 는 0 이다 (NULL 이 아니다) — COALESCE 가 그것이다.
  const select = agg === 'SUM' ? 'COALESCE(SUM(b.v_num), 0)' : 'COUNT(*)';
  const sql = `SELECT ${select} AS v FROM grid b ${joins.join(' ')} WHERE ${where.join(' AND ')}`;
  const row = ctx.db.prepare(sql).get(...args) as { v: number } | undefined;
  return row ? Number(row.v) : 0;
}

/** Task 9 단위 6: 격자의 한 칸. 수치면 v_num, 아니면 v_txt.
    **없는 칸은 0 이다** — 엑셀에서 빈 칸을 참조하면 0 이다. 추측이 아니라 실측이다:
    `=[1]청년패널!A11:B11` 28건의 확정본이 그 칸이 비었을 때 정확히 0 이었다.
    (조회에서 「못 찾은 것」은 이것과 다르다 — 그건 #N/A 로 null 이다.) */
function gridOne(ctx: ExecCtx, src: string, sheet: string, r: number, c: number): string | number {
  const row = ctx.db.prepare(
    'SELECT v_num, v_txt FROM grid WHERE src = ? AND sheet = ? AND r = ? AND c = ?',
  ).get(src, sheet, r, c) as { v_num: number | null; v_txt: string | null } | undefined;
  if (!row) return 0;
  if (row.v_num !== null) return row.v_num;
  return row.v_txt ?? 0;
}

/** 엑셀 조회의 찾을값은 와일드카드 패턴이다: `~` 가 `*`·`?`·`~` 를 이스케이프한다.
    우리는 와일드카드를 구현하지 않으므로 **이스케이프를 되돌려 문자 그대로** 찾는다 —
    실측 121건(HLOOKUP)이 전부 `SUBSTITUTE($B6,"~","~~")` 로 감싸여 있고, 격자에는
    `5~9인` 처럼 `~` 가 든 값이 있어서, 되돌리지 않으면 아무것도 못 찾는다.
    되돌릴 수 없는 진짜 와일드카드(`*`·`?`)가 오면 던진다 — 있는 척하지 않는다. */
function unescapeWildcards(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '~') {
      const next = s[i + 1];
      if (next === '~' || next === '*' || next === '?') { out += next; i++; continue; }
      out += ch;                       // 이스케이프가 아닌 ~ 는 그대로 문자다
      continue;
    }
    out += ch;
  }
  return out;
}

/** 조회(VLOOKUP/HLOOKUP)의 찾을값: 이스케이프를 되돌리고, **남은 진짜 와일드카드는
    던진다** — 패턴이 다른 행을 맞히면 조용히 틀린 값을 내기 때문이다. */
function literalNeedle(s: string): string {
  const out = unescapeWildcards(s);
  if (/[*?]/.test(out)) {
    throw new Error(`조회 찾을값에 와일드카드가 있다 — 지원하지 않는다: ${s}`);
  }
  return out;
}

/** Task 9 단위 7: 지면 격자 범위를 셀 값 목록으로 펼친다. 값은 지금 쓰는 셀 해석
    경로(anchorCell → grids)를 그대로 탄다 — DB 도 grid 도 타지 않는다.
    행 우선으로 훑으므로 한 열·한 행 범위는 순서가 그대로 위치 번호가 된다. */
const RANGE_CAP = 50_000;

function rangeValues(range: CellRange, ctx: ExecCtx): (string | number | null)[] {
  const rows = range.r2 - range.r1 + 1;
  const cols = range.c2 - range.c1 + 1;
  if (rows * cols > RANGE_CAP) {
    throw new Error(`범위가 너무 크다 (${rows}×${cols}) — 수식을 잘못 읽은 것이다`);
  }
  const sheet = range.sheet ?? ctx.sheet;
  const out: (string | number | null)[] = [];
  for (let r = range.r1; r <= range.r2; r++) {
    for (let c = range.c1; c <= range.c2; c++) {
      out.push(gridCell(ctx, sheet, `${colLetters(c)}${r}`));
    }
  }
  return out;
}

/** 범위 인자(범위 또는 식) → 값 목록 */
function argValues(a: RangeArg, ctx: ExecCtx): (string | number | null)[] {
  return 'range' in a ? rangeValues(a.range, ctx) : [execute(a.expr, ctx)];
}

/** 셀 값 하나가 조건값과 같은가 — 엑셀처럼 문자는 대소문자를 구별하지 않고,
    숫자와 숫자꼴 문자열은 같다고 본다(격자에 "2025" 가 문자로 남아 있을 수 있다). */
function cellEquals(v: string | number | null, needle: string | number): boolean {
  if (v === null) return false;
  if (typeof v === 'number' && typeof needle === 'number') return v === needle;
  const vs = String(v).trim(), ns = String(needle).trim();
  if (vs.toUpperCase() === ns.toUpperCase()) return true;
  const vn = Number(vs), nn = Number(ns);
  return vs !== '' && ns !== '' && Number.isFinite(vn) && Number.isFinite(nn) && vn === nn;
}

/** 엑셀 조건 문자열(">0" · "<>OECD" · "계")을 셀 값 하나에 적용한다.
    `"<>값"` 은 **빈 칸에도 맞는다**(엑셀: 빈 칸은 그 값이 아니다). 그 밖의 조건은 빈 칸에
    맞지 않는다.
    전체 리뷰 F2: 우변이 빈 `"<>"` 는 예외다 — **「빈 칸이 아닌 것」**이라 빈 칸에 맞지
    않는다. 짝으로 `"="`(우변이 빈 것)은 「빈 칸인 것」이다. 실측 노출 0건이지만 세
    경로의 뜻을 하나로 맞춘다. */
function matchCrit(v: string | number | null, raw: string): boolean {
  const { op, rhs, blank } = splitCrit(raw);
  const num = blank ? NaN : Number(rhs);
  const isBlankCell = v === null || v === '';
  if (op === '=') return blank ? isBlankCell : cellEquals(v, rhs);
  if (op === '<>') return blank ? !isBlankCell : !cellEquals(v, rhs);
  if (v === null) return false;                 // 빈 칸은 비교 조건에 맞지 않는다
  // 엑셀은 **같은 종류끼리만** 비교한다: ">10" 은 숫자 칸만 보고(문자 'OECD' 는 세지
  // 않는다), ">가" 는 문자 칸만 본다. 종류를 섞어 문자열로 비교하면 'OECD' > '10' 이
  // 참이 되어 순위가 조용히 틀린다(실측으로 part3!p215!I8 이 30 대신 31 이 됐다).
  const vs = typeof v === 'number' ? '' : String(v).trim();
  const vn = typeof v === 'number' ? v : (vs === '' ? NaN : Number(vs));
  if (Number.isFinite(num)) {
    if (!Number.isFinite(vn)) return false;
    // 양쪽을 **유효자릿수 15** 로 맞춰 비교한다. 엑셀의 정밀도가 15자리이고, 무엇보다
    // 조건이 `">"&값` 처럼 숫자를 문자로 바꿔 만들어질 때 그 변환이 15자리라서다.
    // 맞추지 않으면 x > text(x) 가 참이 되어 자기 자신을 세고 순위가 1 밀린다
    // (실측: part3!p215!I8 이 확정본 30 대신 31 이 나왔다).
    const a = Number(vn.toPrecision(15)), b = Number(num.toPrecision(15));
    switch (op) {
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
    }
  }
  if (typeof v === 'number') return false;
  const a = vs.toUpperCase(), b = rhs.trim().toUpperCase();
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
  }
  return false;
}

/** 위치를 맞춰 「모든 술어를 만족하는 칸 수」를 센다.
    범위 크기가 다르면 던진다 — 엑셀도 #VALUE! 이고, 조용히 짧은 쪽에 맞추면 틀린 수를 센다. */
function runRangeCount(preds: RangePred[], ctx: ExecCtx): number | null {
  if (!preds.length) return null;
  const cols: { vals: (string | number | null)[]; test: (v: string | number | null) => boolean }[] = [];
  for (const p of preds) {
    const vals = rangeValues(p.range, ctx);
    if (p.kind === 'isnumber') {
      cols.push({ vals, test: (v) => typeof v === 'number' && Number.isFinite(v) });
    } else {
      const raw = textOf(execute(p.crit, ctx));
      if (raw === null) return null;                  // 조건 자체가 오류다
      cols.push({ vals, test: (v) => matchCrit(v, raw) });
    }
  }
  const n = cols[0].vals.length;
  for (const c of cols) {
    if (c.vals.length !== n) {
      throw new Error(`범위 크기가 다르다 (${cols.map((x) => x.vals.length).join(' vs ')})`);
    }
  }
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (cols.every((c) => c.test(c.vals[i]))) count++;
  }
  return count;
}

/** Task 9 단위 7: 지면 격자(=이미 계산된 칸들) 안에서 찾는 VLOOKUP/HLOOKUP.
    찾은 칸이 비어 있으면 0 이다(엑셀). 못 찾으면 #N/A(null) — 둘은 다르다. */
function lookupInCells(
  dir: 'v' | 'h', needle: string | number, range: CellRange, idx: number, ctx: ExecCtx,
): string | number | null {
  const sheet = range.sheet ?? ctx.sheet;
  const at = (c: number, r: number) => gridCell(ctx, sheet, `${colLetters(c)}${r}`);
  if (dir === 'v') {
    for (let r = range.r1; r <= range.r2; r++) {
      if (!cellEquals(at(range.c1, r), needle)) continue;
      const c = range.c1 + idx - 1;
      if (c > range.c2) return null;                   // #REF!
      return at(c, r) ?? 0;
    }
    return null;
  }
  for (let c = range.c1; c <= range.c2; c++) {
    if (!cellEquals(at(c, range.r1), needle)) continue;
    const r = range.r1 + idx - 1;
    if (r > range.r2) return null;
    return at(c, r) ?? 0;
  }
  return null;
}

/** VLOOKUP/HLOOKUP — 정확히 일치(네 번째 인자 0)만. 못 찾으면 #N/A(null)다. */
function runLookup(e: Extract<Expr, { op: 'lookup' }>, ctx: ExecCtx): string | number | null {
  const raw = execute(e.needle, ctx);
  if (raw === null) return null;                        // 찾을값이 이미 오류다
  const idx = numOrErr(execute(e.index, ctx));
  if (idx === null || !Number.isInteger(idx) || idx < 1) return null;

  const needle = typeof raw === 'number' ? raw : literalNeedle(raw);
  // Task 9 단위 7: 같은 통합문서 범위는 지면 격자에서 찾는다 (DB 를 타지 않는다)
  if (!('src' in e.range)) return lookupInCells(e.dir, needle, e.range, idx, ctx);

  const eqSql = typeof needle === 'number'
    ? '(k.v_num = ? OR k.v_txt = ? COLLATE NOCASE)'
    : '(k.v_txt = ? COLLATE NOCASE OR k.v_num = ?)';
  const eqArgs: (string | number)[] = typeof needle === 'number'
    ? [needle, String(needle)]
    : [needle, Number(needle)];        // 숫자꼴 문자열이 v_num 으로 들어간 칸도 맞춘다

  const { src, sheet, c1, c2, r1, r2 } = e.range;
  const args: (string | number)[] = [src, sheet];
  const where = ['k.src = ?', 'k.sheet = ?'];
  if (e.dir === 'v') {
    where.push('k.c = ?'); args.push(c1);                          // 첫 열에서 찾는다
    if (r1 !== null) { where.push('k.r >= ?'); args.push(r1); }
    if (r2 !== null) { where.push('k.r <= ?'); args.push(r2); }
  } else {
    if (r1 === null) throw new Error('HLOOKUP 범위에 행 번호가 없다');
    where.push('k.r = ?'); args.push(r1);                          // 첫 행에서 찾는다
    where.push('k.c >= ?'); args.push(c1);
    where.push('k.c <= ?'); args.push(c2);
  }
  where.push(eqSql); args.push(...eqArgs);
  const order = e.dir === 'v' ? 'k.r' : 'k.c';
  const hit = ctx.db.prepare(
    `SELECT k.r AS r, k.c AS c FROM grid k WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 1`,
  ).get(...args) as { r: number; c: number } | undefined;
  if (!hit) return null;                                // #N/A — 0 이 아니다

  return e.dir === 'v'
    ? gridOne(ctx, src, sheet, hit.r, c1 + idx - 1)
    : gridOne(ctx, src, sheet, r1! + idx - 1, hit.c);
}

/** 조건 값. `null` 은 **빈 조건**이다 (RULING 18, 아래 cell 분기 참고). */
function critValue(c: Crit, ctx: ExecCtx): string | null {
  if (c.kind === 'year') {
    // FIX ROUND 1: TEXT(C$6,"0") 은 "C6 가 가리키는 값을 정수로" 다 — 연도는 c.ref 가
    // 가리키는 셀 그 자체에서 읽는다.
    // RULING 10: gridCell 은 "키가 아예 없다"와 "값이 명시적으로 null 이다"를 구별하지
    // 못한다. 예비값으로 기준연도를 돌려주면 202개 지면 어딘가의 빈 칸·병합된 연도
    // 머리글이 조용히 기준연도의 답을 받고 대조에서 절대 드러나지 않는다 — 던져서
    // verifyPart(8단계) 가 error 판정으로 잡게 한다. 조용히 틀린 값보다 크래시가 낫다
    // (RULING 7 과 같은 원칙).
    // RULING 11: gridCell 이 anchor 를 먼저 본다 — 연도 조건은 anchor 가 있으면 앵커에서
    // 계산된 값을 받고, 앵커로 못 구할 때만 격자로 떨어진다. 아래 문자열 변환은 그대로
    // 거치므로 SUMIFS 기준값의 모양(정수 문자열)은 변하지 않는다.
    // Task 9 단위 8b: 조건이 단일 셀이 아니라 **식**이다(실측 34건이
    // `TEXT(_시계열!$B$1-1,"0")`). execute 가 그 식의 셀 참조를 gridCell(=앵커 먼저)로
    // 풀므로 규칙은 그대로다. 못 풀면(null) **던진다** — RULING 10 을 되돌리지 않는다.
    const v = execute(c.e, ctx);
    if (v === null) {
      const where = c.e.op === 'cell'
        ? `${c.e.sheet ?? ctx.sheet}!${c.e.ref}`
        : `${ctx.sheet} (식 ${c.e.op})`;
      throw new Error(`연도 조건 셀이 격자에 없다 — 앵커로도 못 풀었다: ${where}`);
    }
    // prd_de·TIME_PERIOD 는 TEXT 열이다 — 숫자를 그대로 두면 "2025.0" 같은 꼴이
    // 되므로 정수 문자열로 맞추고, 이미 문자열이면 값은 손대지 않고 앞뒤 공백만 지운다.
    return typeof v === 'number' ? String(Math.round(v) === v ? Math.round(v) : v) : v.trim();
  }
  if (c.kind === 'lit') return c.value;
  if (c.kind === 'expr') {
    // Task 9 단위 8b: 식 조건 — SUBSTITUTE 이스케이프(48건)와 문자 연결(5건).
    // 엑셀은 조건에서 `*`·`?` 를 와일드카드로 쓰고 `~` 로 이스케이프한다. 우리 등호는
    // 이미 문자 그대로 맞히므로 **이스케이프를 되돌린다** — 단위 6 이 조회 바늘에서
    // 내린 판단과 같은 규칙이다. 실측으로 p49 의 A 열에 진짜 `*`·`~` 가 들어 있다
    // ("* 사회간접자본 및 기타서비스업(D~U)").
    const s = textOf(execute(c.e, ctx));
    if (s === null) throw new Error(`조건 식을 못 풀었다: ${ctx.sheet} (${c.e.op})`);
    // 조회와 달리 **남은 와일드카드에는 던지지 않는다.** 실측 2건(`TEXT($A9,"@")` 로
    // 이스케이프 없이 "* 광공업(BC)" 를 그대로 쓰는 p49!B9 등)이 있고, 그 조건 열에는
    // " 광공업(BC)" 로 끝나는 값이 **하나뿐**이라 엑셀의 패턴 일치와 우리 등호의 문자
    // 일치가 같은 행을 맞힌다(확정본 4322.1 로 확인). 우리 등호는 문자 그대로 맞힌다 —
    // 패턴이 여러 행을 맞히는 자료가 들어오면 갈릴 수 있다(보고서에 남긴 기록).
    return unescapeWildcards(s);
  }
  // Task 9 단위 5: 조건 참조가 시트를 한정한 경우(p116_117!$B30, 실측 1,122건)는 그
  // 시트에서 읽는다 — 실측으로는 전부 지금 지면 자신이지만 이름이 있으면 그것을 따른다.
  // 한정이 없으면 지금까지처럼 지금 시트다 (RULING 8).
  const v = gridCell(ctx, c.sheet ?? ctx.sheet, c.ref);
  // RULING 18 (Task 9 단위 8b): 조건 셀이 비어 있으면 **빈 조건**이다 — 던지지 않는다.
  // 책자는 `SUMIFS(위칸)+SUMIFS(아래칸)` 으로 「두 구간을 더한 칸」과 「한 구간만 쓰는
  // 칸」을 한 수식으로 처리하고, 한 구간만 쓰는 열은 위칸을 비워 둔다(p139 실측).
  // 엑셀에서 빈 조건은 빈 칸에만 맞고, KOSIS 조건 열에는 빈 값이 없어 그 항이 0 이 된다.
  // **연도 조건(위 year 분기)은 여전히 던진다** — 그쪽의 조용한 대체가 p42 의 불일치
  // 68건을 만들었다. 두 갈래를 섞지 않는다.
  if (v === null) return null;
  // 연도 헤더가 숫자로 들어있는 경우 정수 문자열로 맞춘다
  return typeof v === 'number' ? String(Math.round(v) === v ? Math.round(v) : v) : String(v);
}

/** ">0" · ">=5" · "<>계" 같은 비교 조건을 SQL 조각으로
    FIX(대조 9-1): 엑셀 SUMIFS 의 텍스트 기준 비교는 대소문자를 구별하지 않는다
    (예: 헬퍼셀 'pop' 이 DB 의 'POP' 과 같다고 본다). 우리 SQL 의 '=' 는 대소문자를
    구별해 실측에서 2,100건의 불일치(들어오는 값이 전부 '-')를 냈다. 텍스트 기준에만
    COLLATE NOCASE 를 붙인다 — ASCII A~Z 만 접는 콜레이션이라 코드값(ASCII)에는
    맞고 한글 기준값에는 영향이 없다. 숫자 비교(CAST ... AS REAL)는 건드리지 않는다. */
function critSql(col: string, raw: string | null): { sql: string; args: (string | number)[] } {
  // RULING 18: 빈 조건은 **빈 칸에만** 맞는다(엑셀). long 테이블의 조건 열에는 빈 값이
  // 없으므로 맞는 행이 없고 그 SUMIFS 항이 0 이 된다 — 「모두 맞음」이 아니다.
  if (raw === null) return { sql: `${col} = ''`, args: [] };
  const { op, rhs, blank } = splitCrit(raw);
  // 전체 리뷰 F2: `=` 접두를 읽는다(옛 정규식은 `'=계'` 를 리터럴로 찾아 0행을 냈다).
  // 연산자가 없는 조건도 여기로 온다 — 지금까지와 같은 텍스트 등호다(숫자꼴 조건값도
  // 열 친화도(affinity)로 맞는다. CAST 로 바꾸면 168개 리터럴의 뜻이 달라져 건드리지 않는다).
  // 우변이 비면(`"="`) `col = ''` 이 되고, 그것이 엑셀의 「빈 칸」이며 위 RULING 18
  // 분기와 같은 뜻이다.
  if (op === '=') return { sql: `${col} = ? COLLATE NOCASE`, args: [rhs] };
  const sqlOp = op === '<>' ? '!=' : op;
  // 우변이 비면 숫자 비교로 내려가지 않는다 — `Number('') === 0` 이 `"<>"` 를
  // 「0 이 아닌 것」으로 바꿔 버린다. 그래서 `"<>"` 는 `col != ''` 이 되는데, SQL 에서
  // 그것이 정확히 **「빈 칸이 아닌 것」**이다(NULL 은 비교에서 떨어지고 빈 문자열은
  // 같다고 판정된다) — 엑셀의 `"<>"` 와 같다.
  if (!blank) {
    const num = Number(rhs);
    if (Number.isFinite(num)) return { sql: `CAST(${col} AS REAL) ${sqlOp} ?`, args: [num] };
  }
  // 남은 차이(기록): 엑셀의 `"<>값"` 은 빈 칸도 맞히지만 SQL 의 `!=` 는 NULL 행을
  // 떨어뜨린다. 이 조건을 쓰는 칸은 `<>OECD` 2건뿐이고 그 열(oecd_obs.REF_AREA)에
  // NULL 이 없어 노출 0건이다 — 없는 일반성을 만들지 않고 시험(critop)으로 고정해 둔다.
  return { sql: `${col} ${sqlOp} ? COLLATE NOCASE`, args: [rhs] };
}

/** Task 9 단위 7: 집계 SQL 조각. AVERAGEIFS 는 **합÷개수가 아니다** — SQL 의 AVG 가
    엑셀처럼 빈 칸·문자 칸을 분모에서 빼 준다(NULL 은 세지 않는다). 한 행도 없으면
    AVG 는 NULL 이고 그것이 엑셀의 #DIV/0! 다 — 0 으로 만들지 않는다. */
function aggSql(agg: 'SUM' | 'COUNT' | 'AVG', target: string): string {
  if (agg === 'SUM') return `COALESCE(SUM(${target}), 0)`;
  if (agg === 'COUNT') return `COUNT(${target})`;
  return `AVG(${target})`;
}

function aggValue(agg: 'SUM' | 'COUNT' | 'AVG', row: { v: number | null } | undefined): number | null {
  if (agg === 'AVG') return row && row.v !== null ? Number(row.v) : null;   // #DIV/0!
  return row && row.v !== null ? Number(row.v) : 0;
}

/** RULING 7: 소스마다 열 이름 체계가 달라 테이블이 나뉜다.
    - kosis → obs. 헤더 이름을 COL 로 스네이크케이스 열에 매핑하고, obs 가 src 열을 갖고
      있으므로 src = 'kosis' 도 함께 건다.
    - oecd → oecd_obs. 헤더 이름이 곧 열 이름이라 매핑이 없다. 열 이름에 한글('국가명')과
      소문자 영어('value')가 섞여 있어 모든 식별자를 큰따옴표로 인용한다.
    - etc·panel → 아직 long 테이블이 없다 (grid 좌표로만 적재됨). 0 을 돌려주면 정당한 0 과
      구별할 수 없어 대조를 속이게 되므로, 던진다. 9단계가 이 소스들에 long 뷰를 만들 것이다. */
function runIfs(q: Query | GridQuery, ctx: ExecCtx, agg: 'SUM' | 'COUNT' | 'AVG'): number | null {
  // Task 9 단위 5: 격자 질의는 열 번호로 grid 를 자기조인한다.
  if ('kind' in q && q.kind === 'grid') return runGridIfs(q, ctx, agg);

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
    const sql = `SELECT ${aggSql(agg, target)} AS v FROM obs WHERE ${where.join(' AND ')}`;
    const row = ctx.db.prepare(sql).get(...args) as { v: number | null } | undefined;
    return aggValue(agg, row);
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
    const sql = `SELECT ${aggSql(agg, target)} AS v FROM oecd_obs WHERE ${where.join(' AND ')}`;
    const row = ctx.db.prepare(sql).get(...args) as { v: number | null } | undefined;
    return aggValue(agg, row);
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

/** 엑셀의 반올림 — **TEXT 와 ROUND 가 함께 쓰는 하나의 규칙이다.**
    0.5 는 항상 0 에서 먼 쪽으로 보낸다(사사오입). 그리고 엑셀은 부동소수 오차를 그대로
    반올림하지 않는다: **자릿수만큼 스케일한 값**을 유효자릿수 15 로 줄이고 그것을
    반올림한다. 21.049999999999997 을 한 자리로 줄이면 210.49999999999997 → 15자리로
    210.500000000000 → 211 → 21.1 이다(part3!p223!O31 실측. 한 번에 반올림하면 21.0).

    전체 리뷰 F5: 예전에는 이 규칙이 **두 곳에 따로** 구현돼 있었고 `toPrecision(15)` 가
    스케일링의 반대편에 있어 결과가 갈렸다 — `textFixed` 는 「먼저 줄이고 스케일」이라
    1.005 를 두 자리로 "1.00" 으로 냈고(스케일 후의 부동소수 꼬리
    `1.005*100 = 100.49999999999999` 를 되살렸다), `case 'round'` 는 1.01 을 냈다.
    엑셀은 1.01 이므로 `round` 쪽이 옳았다. 한 함수로 합쳤다. */
function excelRound(n: number, decimals: number): number {
  const f = 10 ** decimals;
  const n15 = Number((n * f).toPrecision(15));
  return Math.sign(n15) * Math.round(Math.abs(n15)) / f;
}

/** TEXT(x,"0.0") — 위 규칙으로 반올림하고 자릿수를 맞춘다. */
function textFixed(n: number, decimals: number, group = false): string {
  const s = excelRound(n, decimals).toFixed(decimals);
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
    // Task 9 단위 6
    case 'anchor': return ctx.anchor ? ctx.anchor.anchor : null;
    case 'gridcell': return gridOne(ctx, e.src, e.sheet, e.r, e.c);
    case 'lookup': return runLookup(e, ctx);
    case 'substitute': {
      const s = textOf(execute(e.inner, ctx));
      const find = textOf(execute(e.find, ctx));
      const rep = textOf(execute(e.replace, ctx));
      if (s === null || find === null || rep === null) return null;
      return find === '' ? s : s.split(find).join(rep);
    }
    case 'left': case 'right': {
      const s = textOf(execute(e.inner, ctx));
      const n = numOrErr(execute(e.n, ctx));
      if (s === null || n === null || n < 0) return null;
      return e.op === 'left' ? s.slice(0, n) : (n === 0 ? '' : s.slice(-n));
    }
    // Task 9 단위 7 — 지면 내부 범위 함수
    case 'agg': {
      const vals: (string | number | null)[] = [];
      for (const a of e.args) vals.push(...argValues(a, ctx));
      const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (e.fn === 'sum') return nums.reduce((a, b) => a + b, 0);
      if (e.fn === 'max') return nums.length ? Math.max(...nums) : 0;
      // COUNTA — 비어 있지 않은 칸 수. 빈 문자열은 세지 않는다.
      return vals.filter((v) => v !== null && v !== '').length;
    }
    case 'rangecount': return runRangeCount(e.preds, ctx);
    case 'index': {
      const n = numOrErr(execute(e.n, ctx));
      if (n === null || !Number.isInteger(n) || n < 1) return null;
      const vals = rangeValues(e.range, ctx);
      if (n > vals.length) return null;                 // #REF!
      return vals[n - 1] ?? 0;                          // 빈 칸은 0 (엑셀)
    }
    case 'match': {
      const raw = execute(e.needle, ctx);
      if (raw === null) return null;
      const vals = rangeValues(e.range, ctx);
      for (let i = 0; i < vals.length; i++) {
        if (cellEquals(vals[i], raw)) return i + 1;     // 1-based
      }
      return null;                                      // #N/A
    }
    case 'n': {
      const v = execute(e.inner, ctx);
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    }
    case 'len': {
      const s = textOf(execute(e.inner, ctx));
      return s === null ? null : s.length;
    }
    case 'find': {
      const needle = textOf(execute(e.needle, ctx));
      const inside = textOf(execute(e.inside, ctx));
      if (needle === null || inside === null) return null;
      const i = inside.indexOf(needle);
      return i < 0 ? null : i + 1;                      // 못 찾으면 #VALUE!
    }
    case 'quotient': case 'mod': {
      const a = numOrErr(execute(e.a, ctx));
      const b = numOrErr(execute(e.b, ctx));
      if (a === null || b === null || b === 0) return null;   // #DIV/0!
      if (e.op === 'quotient') return Math.trunc(a / b);
      return a - b * Math.floor(a / b);                 // 엑셀 MOD 는 나누는 수의 부호를 따른다
    }
    case 'round': {
      const v = numOrErr(execute(e.inner, ctx));
      const d = numOrErr(execute(e.digits, ctx));
      if (v === null || d === null) return null;
      return excelRound(v, d);          // TEXT 와 **같은 함수**다 (F5)
    }
    case 'averageifs': return runIfs(e.q, ctx, 'AVG');
    case 'unsupported': return null;
  }
}
