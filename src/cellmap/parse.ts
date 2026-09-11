import { tokenize, type Token } from './tokenize.ts';
import type { CellRange, Crit, Expr, GridQuery, GridRange, Headers, Query, RangeArg, RangePred, Src } from '../types.ts';

export type ParseCtx = { extmap: Record<string, string>; headers: Headers };

export function srcOf(filename: string): Src {
  if (filename.startsWith('KOSIS')) return 'kosis';
  if (filename.startsWith('OECD')) return 'oecd';
  if (filename.startsWith('별도데이터')) return 'etc';
  if (filename.includes('패널데이터')) return 'panel';
  throw new Error('모르는 원천 파일: ' + filename);
}

/** '$C:$C' · '$C' → 열 문자 'C' */
function colLetter(a1: string): string {
  const m = /^\$?([A-Z]{1,3})/.exec(a1);
  if (!m) throw new Error('열 문자를 못 읽었다: ' + a1);
  return m[1];
}

function letterIndex(letter: string): number {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;             // A → 0
}

/** Task 9 단위 5: 열 문자 → **1-based 열 번호** ('A'→1 · 'C'→3 · 'P'→16 · 'AA'→27).
    `grid.c` 가 1-based 다. */
export function colNumber(letter: string): number {
  return letterIndex(letter) + 1;
}

/** 열 **전체** 참조('$B:$B' · 'C:C')만 열 번호로 옮긴다. 부분 범위('$A$9:$E$25')를
    조용히 첫 열로 뭉개면 행 범위를 무시한 틀린 답이 나오므로 던진다 — 별도데이터의
    대상 1,917건은 실측으로 전부 열 전체다. */
export function wholeColumn(a1: string): number {
  const m = /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/.exec(a1);
  if (!m || m[1] !== m[2]) throw new Error('열 전체 참조가 아니다: ' + a1);
  return colNumber(m[1]);
}

/** Task 9 단위 7: 1-based 열 번호 → 열 문자 (1→'A' · 27→'AA' · 102→'CX').
    범위를 셀 좌표로 펼칠 때 쓴다. */
export function colLetters(n: number): string {
  let out = '';
  let k = n;
  while (k > 0) {
    const rem = (k - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    k = Math.floor((k - 1) / 26);
  }
  return out;
}

export function colName(src: Src, sheet: string, a1: string, headers: Headers): string {
  const cols = headers[src]?.[sheet];
  if (!cols) throw new Error(`헤더를 모른다: ${src}/${sheet}`);
  const i = letterIndex(colLetter(a1));
  const name = cols[i];
  if (!name) throw new Error(`${src}/${sheet} ${i}번째 열에 이름이 없다 (${a1})`);
  return name;
}

/** 절대참조 기호를 벗긴 셀 좌표 */
function plainRef(a1: string): string {
  return a1.replace(/\$/g, '');
}

/** Task 9 단위 8 의 앵커 자리 — 통합문서마다 외부참조 인덱스가 다르므로(`[1]` 이기도
    `[2]` 이기도 하다) **시트 이름과 좌표로** 가려낸다. Task 9 단위 10 에서 anchor.ts 가
    쓰던 것을 여기로 옮겼다: 「무엇이 앵커 참조인가」는 수식 문법의 문제이고, 이렇게
    두면 parse.ts → anchor.ts 방향의 순환 import 가 생기지 않는다. */
export const ANCHOR_REF = { sheet: '0_수집현황', cell: 'A1' } as const;

export function isAnchorRef(t: Token): boolean {
  return t.t === 'ref' && t.ext !== null
    && t.sheet === ANCHOR_REF.sheet && plainRef(t.a1) === ANCHOR_REF.cell;
}

/** 'A5' · '$A$5' → {r,c}. 범위면 **첫 칸**을 낸다 (엑셀 암시적 교차) */
function cellCoord(a1: string): { r: number; c: number } {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)/.exec(a1);
  if (!m) throw new Error('격자 좌표를 못 읽었다 (행 번호가 없다): ' + a1);
  return { r: Number(m[2]), c: colNumber(m[1]) };
}

/** '$T$7:$AD$39' → 사각범위 · '$A:$B' → 열 전체(행 제한 없음) */
function rangeCoord(a1: string): { c1: number; c2: number; r1: number | null; r2: number | null } {
  const full = /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/.exec(a1);
  if (full) return { c1: colNumber(full[1]), c2: colNumber(full[2]), r1: null, r2: null };
  const box = /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/.exec(a1);
  if (!box) throw new Error('사각범위를 못 읽었다: ' + a1);
  return { c1: colNumber(box[1]), c2: colNumber(box[3]), r1: Number(box[2]), r2: Number(box[4]) };
}

type P = { toks: Token[]; i: number; ctx: ParseCtx };

function peek(p: P): Token | undefined { return p.toks[p.i]; }
function take(p: P): Token { const t = p.toks[p.i]; p.i++; return t; }

function expect(p: P, kind: Token['t']): Token {
  const t = take(p);
  if (!t || t.t !== kind) throw new Error(`${kind} 를 기대했는데 ${t?.t}`);
  return t;
}

/** 인자 목록을 파싱해 토큰 덩어리로 돌려준다 (괄호 깊이를 세며 쉼표로 자른다) */
function argTokens(p: P): Token[][] {
  expect(p, 'lp');
  const args: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  while (p.i < p.toks.length) {
    const t = p.toks[p.i];
    if (t.t === 'lp') depth++;
    if (t.t === 'rp') {
      if (depth === 0) { p.i++; break; }
      depth--;
    }
    if (t.t === 'comma' && depth === 0) { args.push(cur); cur = []; p.i++; continue; }
    cur.push(t); p.i++;
  }
  if (cur.length) args.push(cur);
  return args;
}

/** fn TEXT, lp, … 로 시작하는 토큰열에서 TEXT() 의 인자 목록을 뽑는다
    (argTokens 와 같은 규칙이지만 파서 상태 없이 평평한 토큰열 위에서 동작한다) */
function textCallArgs(toks: Token[]): Token[][] {
  const args: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (let i = 2; i < toks.length; i++) {   // 0=fn TEXT, 1=lp
    const t = toks[i];
    if (t.t === 'lp') depth++;
    if (t.t === 'rp') {
      if (depth === 0) break;
      depth--;
    }
    if (t.t === 'comma' && depth === 0) { args.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) args.push(cur);
  return args;
}

/** 조건 인자 하나를 Crit 으로.
    Task 9 단위 8b: 단일 토큰이 아닌 조건도 **식으로** 받는다 — SUBSTITUTE 이스케이프
    (48건)와 문자 연결(5건), TEXT 의 앵커 표현식(34건)이 거기에 해당한다.
    파싱할 수 없는 식은 여전히 던져 unsupported 로 남는다(추측하지 않는다). */
function toCrit(toks: Token[], ctx: ParseCtx): Crit {
  if (toks.length === 1) {
    const t = toks[0];
    if (t.t === 'str') return { kind: 'lit', value: t.v };
    if (t.t === 'num') return { kind: 'lit', value: String(t.v) };
    if (t.t === 'ref' && t.ext === null) {
      // Task 9 단위 5: 시트를 한정한 조건 참조(p116_117!$B30, 실측 1,122건)도 받는다.
      // 실측으로 그 시트는 전부 지금 지면 자신이다 — 그래도 이름을 버리지 않고 실어 보낸다.
      return t.sheet === null
        ? { kind: 'cell', ref: plainRef(t.a1) }
        : { kind: 'cell', sheet: t.sheet, ref: plainRef(t.a1) };
    }
  }
  // RULING 9/10: TEXT(<식>,"0") — 연도 조건은 실행 시점에 그 식을 앵커/격자로 푼다.
  // Task 9 단위 8b: 인자가 단일 셀이어야 한다는 제약을 풀었다(실측 34건이
  // `TEXT(_시계열!$B$1-1,"0")` 이고, 단위 8·10 의 anchorCell 이 그것을 계산한다).
  // 형식은 정수("0")만 받는다 — critValue 가 정수 문자열로 맞추기 때문이다.
  if (toks[0]?.t === 'fn' && toks[0].v === 'TEXT') {
    const args = textCallArgs(toks);
    const fmt = args[1];
    if (!(fmt?.length === 1 && fmt[0].t === 'str')) {
      throw new Error('TEXT 조건의 형식 인자를 못 읽었다: ' + JSON.stringify(fmt));
    }
    if (!args[0]?.length) throw new Error('TEXT 조건에 인자가 없다');
    // 실측 2건: TEXT($A8,"@") — "@" 는 엑셀의 **텍스트 서식**이라 「값을 문자로 그대로」
    // 라는 뜻이다. 연도 조건이 아니므로 식 조건으로 보낸다(critValue 가 문자로 만든다).
    if (fmt[0].v === '@') return { kind: 'expr', e: parseTokens(args[0], ctx) };
    if (!/^[#,]*0$/.test(fmt[0].v)) {
      throw new Error('TEXT 조건의 형식이 정수("0")도 텍스트("@")도 아니다: ' + JSON.stringify(fmt[0].v));
    }
    return { kind: 'year', e: parseTokens(args[0], ctx) };
  }
  return { kind: 'expr', e: parseTokens(toks, ctx) };
}

function ifsQuery(name: 'SUMIFS' | 'COUNTIFS', args: Token[][], ctx: ParseCtx): Query | GridQuery {
  // SUMIFS(값범위, 조건범위, 조건, …)  /  COUNTIFS(조건범위, 조건, …)
  let src: Src | null = null;
  let sheet: string | null = null;
  let value = '';
  let rest: Token[][];

  const refOf = (toks: Token[]) => {
    const r = toks.find((t) => t.t === 'ref') as Extract<Token, { t: 'ref' }> | undefined;
    if (!r || r.ext === null || !r.sheet) throw new Error('외부 범위 참조가 아니다');
    const file = ctx.extmap[String(r.ext)];
    if (!file) throw new Error(`extmap 에 ${r.ext} 번이 없다`);
    return { src: srcOf(file), sheet: r.sheet, a1: r.a1 };
  };

  const first = refOf(args[0]);
  src = first.src; sheet = first.sheet;
  // COUNTIFS 는 첫 범위가 곧 조건 범위이기도 하다 — SUMIFS 만 첫 범위를 값 범위로 뗀다.
  rest = name === 'SUMIFS' ? args.slice(1) : args;

  // Task 9 단위 5: etc·panel 은 long 테이블이 없다. 열 이름이 아니라 열 번호로 간다.
  if (src === 'etc' || src === 'panel') {
    const crits: { col: number; crit: Crit }[] = [];
    for (let k = 0; k + 1 < rest.length; k += 2) {
      const cr = refOf(rest[k]);
      if (cr.src !== src || cr.sheet !== sheet) {
        throw new Error(`한 ${name} 안에서 시트가 갈린다: ${cr.sheet} vs ${sheet}`);
      }
      crits.push({ col: wholeColumn(cr.a1), crit: toCrit(rest[k + 1], ctx) });
    }
    if (!crits.length) throw new Error(`${name} 에 조건이 없다`);
    return {
      kind: 'grid', src, sheet,
      valueCol: name === 'SUMIFS' ? wholeColumn(first.a1) : null,
      crits,
    };
  }

  value = colName(src, sheet, first.a1, ctx.headers);

  const where: Record<string, Crit> = {};
  for (let k = 0; k + 1 < rest.length; k += 2) {
    const cr = refOf(rest[k]);
    if (cr.src !== src || cr.sheet !== sheet) {
      throw new Error(`한 ${name} 안에서 시트가 갈린다: ${cr.sheet} vs ${sheet}`);
    }
    where[colName(src, sheet, cr.a1, ctx.headers)] = toCrit(rest[k + 1], ctx);
  }
  return { src, table: sheet!, value, where };
}

/** Task 9 단위 7: 같은 통합문서의 사각 범위 토큰 → `CellRange`. 범위가 아니면 null.
    `B6:CX6` 처럼 2자리 열 문자도 받는다(102칸). */
function cellRangeOf(toks: Token[]): CellRange | null {
  if (toks.length !== 1) return null;
  const t = toks[0];
  if (t.t !== 'ref' || t.ext !== null || !t.a1.includes(':')) return null;
  const m = /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/.exec(t.a1);
  if (!m) return null;                       // 열 전체($A:$A) 등은 여기서 다루지 않는다
  const [ra, rb] = [Number(m[2]), Number(m[4])];
  const [ca, cb] = [colNumber(m[1]), colNumber(m[3])];
  const range: CellRange = {
    r1: Math.min(ra, rb), r2: Math.max(ra, rb),
    c1: Math.min(ca, cb), c2: Math.max(ca, cb),
  };
  return t.sheet === null ? range : { sheet: t.sheet, ...range };
}

/** 범위 인자 하나 — 범위면 범위로, 아니면 식으로 */
function rangeArg(toks: Token[], ctx: ParseCtx): RangeArg {
  const r = cellRangeOf(toks);
  return r ? { range: r } : { expr: parseTokens(toks, ctx) };
}

/** 범위여야 하는 인자. 시트를 한정한 INDEX/MATCH 범위는 **표현(presentation)** 이다 —
    OECD 부록의 정렬 로직(실측 3,246건)이 전부 그 모양이고, 같은 지면 안에서 순위를
    세는 이 단위의 대상 28건은 전부 한정이 없다. 그 둘을 여기서 가른다.
    (이유 문자열에 함수 이름이 남아야 compare.ts 의 presentation 판정이 계속 맞는다.) */
function mustRange(fn: string, toks: Token[]): CellRange {
  const r = cellRangeOf(toks);
  if (!r) throw new Error(`${fn} 의 범위 인자를 못 읽었다: ${JSON.stringify(toks)}`);
  if (r.sheet !== undefined) {
    throw new Error(`${fn} 범위가 다른 시트를 가리킨다 — 정렬·표시(표현) 로직이다: ${r.sheet}`);
  }
  return r;
}

/** Task 9 단위 6: 외부참조 토큰 → 격자 원천. kosis·oecd 는 좌표로 적재된 적이 없어
    (long 테이블만 있다) 여기서 사유를 바꿔 남긴다 — 없는 좌표를 추측하지 않는다. */
function gridSrc(t: Extract<Token, { t: 'ref' }>, ctx: ParseCtx): { src: 'etc' | 'panel'; sheet: string } {
  const file = ctx.extmap[String(t.ext)];
  if (!file) throw new Error(`extmap 에 ${t.ext} 번이 없다`);
  const src = srcOf(file);
  if (src !== 'etc' && src !== 'panel') {
    throw new Error(`격자가 없는 원천의 좌표 참조다: ${src} ${t.sheet}!${t.a1}`);
  }
  if (!t.sheet) throw new Error('외부 좌표 참조에 시트가 없다: ' + t.a1);
  return { src, sheet: t.sheet };
}

/** 조회 함수의 두 번째 인자 — **외부** 사각범위만 받는다.
    같은 통합문서 안에서 찾는 VLOOKUP(실측 182건)은 확정본 격자를 훑어야 하는 다른
    문제라 여기서 던진다(단위 7 소관). */
function lookupRange(toks: Token[], ctx: ParseCtx): GridRange | CellRange {
  const r = toks.find((t) => t.t === 'ref') as Extract<Token, { t: 'ref' }> | undefined;
  if (!r || toks.length !== 1) {
    throw new Error('조회 범위가 사각범위가 아니다: ' + JSON.stringify(toks));
  }
  // Task 9 단위 7: 같은 통합문서 범위(실측 182건, 그 중 18건은 다른 시트)는 지면
  // 격자에서 찾는다. 시트 한정을 그대로 실어 보낸다 — 지금 지면만 보면 18건이 틀린다.
  if (r.ext === null) {
    const cr = cellRangeOf(toks);
    if (!cr) throw new Error('조회 범위가 사각범위가 아니다: ' + r.a1);
    return cr;
  }
  const g = gridSrc(r, ctx);
  return { ...g, ...rangeCoord(r.a1) };
}

/** Task 9 단위 7: 지면 격자를 세는 COUNTIFS — 조건 범위마다 술어 하나.
    조건은 `">0"` 같은 문자열이기도 하고 `">"&INDEX(…)` 처럼 실행 시 계산되는 식이기도
    하다(실측 28건이 후자다). 그래서 Crit 이 아니라 Expr 로 들고 간다. */
function rangeCountifs(args: Token[][], ctx: ParseCtx): Expr {
  if (args.length < 2 || args.length % 2 !== 0) {
    throw new Error(`COUNTIFS 인자 수가 짝이 아니다 (${args.length}개)`);
  }
  const preds: RangePred[] = [];
  for (let k = 0; k + 1 < args.length; k += 2) {
    const r = cellRangeOf(args[k]);
    if (!r) throw new Error('COUNTIFS 조건 범위가 사각범위가 아니다: ' + JSON.stringify(args[k]));
    preds.push({ kind: 'crit', range: r, crit: parseTokens(args[k + 1], ctx) });
  }
  return { op: 'rangecount', preds };
}

/** SUMPRODUCT 의 한 인자 `--ISNUMBER(범위)` 또는 `--(범위<>"문자")` → 술어 하나.
    실측 28건이 이 두 모양뿐이다. 다른 모양은 던져서 unsupported 로 남긴다. */
function sumproductPred(toks: Token[], ctx: ParseCtx): RangePred {
  // 앞의 `--`(단항 부정 2회 = 논리→0/1)를 벗긴다
  let i = 0;
  while (i < toks.length && toks[i].t === 'op' && (toks[i] as { v: string }).v === '-') i++;
  if (i !== 2) throw new Error('SUMPRODUCT 인자가 -- 로 시작하지 않는다: ' + JSON.stringify(toks));
  const rest = toks.slice(i);
  if (rest[0]?.t === 'fn' && rest[0].v === 'ISNUMBER') {
    const inner = rest.slice(2, rest.length - 1);       // fn, lp … rp
    const r = cellRangeOf(inner);
    if (!r) throw new Error('SUMPRODUCT 의 ISNUMBER 인자가 범위가 아니다: ' + JSON.stringify(inner));
    return { kind: 'isnumber', range: r };
  }
  // (범위<>"문자")
  if (rest[0]?.t === 'lp' && rest[rest.length - 1]?.t === 'rp') {
    const inner = rest.slice(1, rest.length - 1);
    const opAt = inner.findIndex((x) => x.t === 'op' && x.v === '<>');
    if (opAt > 0) {
      const r = cellRangeOf(inner.slice(0, opAt));
      if (r) {
        return { kind: 'crit', range: r,
                 crit: { op: 'concat', args: [{ op: 'str', v: '<>' }, parseTokens(inner.slice(opAt + 1), ctx)] } };
      }
    }
  }
  throw new Error('SUMPRODUCT 인자 모양을 모른다: ' + JSON.stringify(toks));
}

const CMP_REL: Record<string, 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'> = {
  '=': 'eq', '<>': 'ne', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte',
};

/** 비교는 산술보다 우선순위가 낮다 — 산술식을 좌우로 한 번씩만 허용한다
    (엑셀 자체가 연쇄비교 a<b<c 를 모르므로 반복시키지 않는다) */
function parseCompare(p: P): Expr {
  const left = parseConcat(p);
  const t = peek(p);
  if (t?.t === 'op' && t.v in CMP_REL) {
    p.i++;
    const right = parseConcat(p);
    return { op: 'cmp', rel: CMP_REL[t.v], a: left, b: right };
  }
  return left;
}

/** Task 9 단위 8: 이어붙이기 & — 엑셀 우선순위에서 산술보다 낮고 비교보다 높다.
    지면의 연도 씨앗셀 147건이 이 모양(=_시계열!B12&"년")이라 '남은 토큰이 있다'로
    미지원에 쌓여 있었다. 왼쪽부터 평평하게 모은다. */
function parseConcat(p: P): Expr {
  let left = parseExpr(p);
  for (;;) {
    const t = peek(p);
    if (t?.t === 'op' && t.v === '&') {
      p.i++;
      const right = parseExpr(p);
      left = left.op === 'concat'
        ? { op: 'concat', args: [...left.args, right] }
        : { op: 'concat', args: [left, right] };
      continue;
    }
    break;
  }
  return left;
}

/** Task 9 단위 3: TEXT(x,"0.0") 의 형식 문자열 → 소수 자릿수 + 천단위 구분자 여부.
    실측(FAMILY 1)에 나온 형식은 "#,##0" · "0.0" · "0.00" 세 가지뿐이었다.
    Task 9 단위 8 (정정): 예전에는 콤마(천단위 구분자)를 세지 않았다 — 오라클이 콤마 없는
    숫자였기 때문이다(part3!p214!O6 은 차트 레이블 열이라 Excel COM 이 "211,983" 을
    211983 으로 강제 변환해 담았다). 그런데 & 로 이어붙인 셀에서는 그 문자열이 그대로
    지면에 찍힌다 — part1_6!p104!B18 의 확정본이 "월평균 4,205천원" 이다. 엑셀대로
    구분자를 찍고, 숫자로 강제 변환된 오라클 쪽은 compare 의 sameValue 가 받아준다.
    일반형 "[#,]*0(.0+)?" 을 벗어나면 추측하지 않고 형식 문자열을 이유에 남겨 unsupported 로 던진다. */
function textFormat(fmt: string): { decimals: number; group: boolean } {
  const m = /^[#,]*0(?:\.(0+))?$/.exec(fmt);
  if (!m) throw new Error(`TEXT 형식을 모른다: ${fmt}`);
  return { decimals: m[1] ? m[1].length : 0, group: fmt.includes(',') };
}

/** 단항/이항 산술을 왼쪽부터. 엑셀 우선순위는 * / 가 + - 보다 높다 */
function parseExpr(p: P): Expr {
  let left = parseTerm(p);
  for (;;) {
    const t = peek(p);
    if (t?.t === 'op' && (t.v === '+' || t.v === '-')) {
      p.i++;
      const right = parseTerm(p);
      left = t.v === '+'
        ? (left.op === 'add'
            ? { op: 'add', args: [...left.args, right] }
            : { op: 'add', args: [left, right] })
        : { op: 'sub', a: left, b: right };
      continue;
    }
    break;
  }
  return left;
}

function parseTerm(p: P): Expr {
  let left = parseUnary(p);
  for (;;) {
    const t = peek(p);
    if (t?.t === 'op' && (t.v === '*' || t.v === '/')) {
      p.i++;
      const right = parseUnary(p);
      left = t.v === '*' ? { op: 'mul', a: left, b: right } : { op: 'div', a: left, b: right };
      continue;
    }
    break;
  }
  return left;
}

function parseUnary(p: P): Expr {
  let e = parseAtom(p);
  // 후위 % — 엑셀에서 x% 는 x/100 이다
  while (peek(p)?.t === 'op' && (peek(p) as { v: string }).v === '%') {
    p.i++;
    e = { op: 'pct', inner: e };
  }
  return e;
}

function parseAtom(p: P): Expr {
  const t = take(p);
  if (!t) throw new Error('식이 갑자기 끝났다');

  if (t.t === 'num') return { op: 'const', v: t.v };
  if (t.t === 'str') return { op: 'str', v: t.v };
  if (t.t === 'lp') {
    // parseCompare(비교 포함) — 괄호 안에 조건식이 올 수 있다(AND 인자 등). 비교 연산자가
    // 없으면 이제껏처럼 산술식 결과를 그대로 돌려준다.
    const e = parseCompare(p);
    expect(p, 'rp');
    return e;
  }
  if (t.t === 'op' && t.v === '-') {
    return { op: 'sub', a: { op: 'const', v: 0 }, b: parseUnary(p) };
  }
  if (t.t === 'ref') {
    // RULING 8: ext===null 이면 참조 대상이 같은 통합문서 안이다 — 같은 시트든 다른 시트
    // (booklet 페이지 간 셀 복사, p68!$F$5 같은 형태)든 보조시트(_시계열 등)든 모두 cell 로 받는다.
    // ext!==null (외부 통합문서 범위)만 산술 위치에서는 에러로 남긴다.
    if (t.ext === null) {
      return t.sheet === null
        ? { op: 'cell', ref: plainRef(t.a1) }
        : { op: 'cell', sheet: t.sheet, ref: plainRef(t.a1) };
    }
    // Task 9 단위 6: 외부통합문서의 **좌표 한 칸**은 grid 에서 읽는다(실측 439건).
    // 앵커 한 칸은 단위 8 의 바닥값이다.
    if (isAnchorRef(t)) return { op: 'anchor' };
    const g = gridSrc(t, p.ctx);
    const { r, c } = cellCoord(t.a1);      // 범위면 첫 칸 (엑셀 암시적 교차, 실측 28건)
    return { op: 'gridcell', src: g.src, sheet: g.sheet, r, c };
  }
  if (t.t === 'fn') {
    if (t.v === 'SUMIFS' || t.v === 'COUNTIFS') {
      const args = argTokens(p);
      // Task 9 단위 7: 첫 범위가 같은 통합문서면 지면 격자를 세는 COUNTIFS 다
      // (실측 28건, part3 의 순위 계산). 외부 데이터를 타는 것과 셈이 전혀 다르다.
      const firstRef = args[0]?.find((x) => x.t === 'ref') as Extract<Token, { t: 'ref' }> | undefined;
      if (t.v === 'COUNTIFS' && firstRef && firstRef.ext === null) {
        return rangeCountifs(args, p.ctx);
      }
      const q = ifsQuery(t.v, args, p.ctx);
      return t.v === 'SUMIFS' ? { op: 'sumifs', q } : { op: 'countifs', q };
    }
    if (t.v === 'IF') {
      const args = argTokens(p);
      // IF(X=0,"-",X) 는 지금까지처럼 zeroDash 로 남긴다 — 5,754건이 이미 맞고 있는
      // 경로라 건드리지 않는다. 일반형 IF 는 zeroDash 모양이 아닐 때만 손댄다.
      const isZeroTest = args[0].some((x) => x.t === 'op' && x.v === '=')
        && args[0].some((x) => x.t === 'num' && x.v === 0);
      const dash = args[1].length === 1 && args[1][0].t === 'str';
      if (isZeroTest && dash && args[2]) {
        return { op: 'zeroDash', inner: parseTokens(args[2], p.ctx) };
      }
      // Task 9 단위 3: 나머지 3-인자 IF 는 조건·참·거짓 세 갈래를 각각 독립적으로 파싱한다.
      // 조건도 parseTokens(=parseCompare 진입)로 파싱하므로 비교($A6="OECD")·AND(...)·
      // ISNUMBER(...) ·bare cmp 모두 여기서 그대로 Expr 이 된다.
      if (args.length === 3) {
        const cond = parseTokens(args[0], p.ctx);
        const thenE = parseTokens(args[1], p.ctx);
        const elseE = parseTokens(args[2], p.ctx);
        return { op: 'if', cond, then: thenE, else: elseE };
      }
      throw new Error('IF 형태를 못 다룬다');
    }
    if (t.v === 'AND') {
      const args = argTokens(p);
      return { op: 'and', args: args.map((a) => parseTokens(a, p.ctx)) };
    }
    if (t.v === 'ISNUMBER') {
      const args = argTokens(p);
      return { op: 'isnumber', inner: parseTokens(args[0], p.ctx) };
    }
    if (t.v === 'TEXT') {
      const args = argTokens(p);
      const fmtToks = args[1];
      if (!fmtToks || fmtToks.length !== 1 || fmtToks[0].t !== 'str') {
        throw new Error('TEXT 형식 인자를 못 읽었다: ' + JSON.stringify(fmtToks));
      }
      const { decimals, group } = textFormat(fmtToks[0].v);
      return { op: 'text', inner: parseTokens(args[0], p.ctx), decimals, group };
    }
    if (t.v === 'NUMBERVALUE') {
      // Task 9 단위 4 (CHANGE 2): 예전에는 껍데기만 벗기고 문자열을 그대로 산술로
      // 흘려보냈다 — "69.3%" 가 num() 에서 0 이 됐다. 이제 실제로 파싱하는 연산으로 남긴다.
      const args = argTokens(p);
      return { op: 'numbervalue', inner: parseTokens(args[0], p.ctx) };
    }
    if (t.v === 'VLOOKUP' || t.v === 'HLOOKUP') {
      // Task 9 단위 6: VLOOKUP(찾을값, 외부사각범위, 열인덱스, 0)
      const args = argTokens(p);
      if (args.length !== 4) throw new Error(`${t.v} 인자가 4개가 아니다 (${args.length}개)`);
      const mode = args[3];
      // 네 번째 인자는 실측상 전부 0(정확히 일치)이다. 1(근사 조회)은 정렬 전제가 달라
      // 구현하지 않는다 — 있는 척하지 않고 사유에 남긴다.
      if (!(mode.length === 1 && mode[0].t === 'num' && mode[0].v === 0)) {
        throw new Error(`${t.v} 의 네 번째 인자가 0(정확히 일치)이 아니다: ${JSON.stringify(mode)}`);
      }
      return {
        op: 'lookup',
        dir: t.v === 'VLOOKUP' ? 'v' : 'h',
        needle: parseTokens(args[0], p.ctx),
        range: lookupRange(args[1], p.ctx),
        index: parseTokens(args[2], p.ctx),      // 실측 164건이 셀 참조(C$4)다 — 상수 가정 금지
      };
    }
    // Task 9 단위 7: 지면 범위 집계. SUM(C22) 처럼 값 하나로 오는 것도 있다(실측 2건).
    if (t.v === 'SUM' || t.v === 'MAX' || t.v === 'COUNTA') {
      const args = argTokens(p);
      if (!args.length) throw new Error(`${t.v} 에 인자가 없다`);
      const fn = t.v === 'SUM' ? 'sum' : t.v === 'MAX' ? 'max' : 'counta';
      return { op: 'agg', fn, args: args.map((a) => rangeArg(a, p.ctx)) };
    }
    if (t.v === 'INDEX') {
      // INDEX(범위, n) — 한 줄(한 열 또는 한 행) 범위의 n번째 칸. 2차원은 다루지 않는다.
      const args = argTokens(p);
      if (args.length !== 2) throw new Error(`INDEX 인자가 2개가 아니다 (${args.length}개)`);
      return { op: 'index', range: mustRange('INDEX', args[0]), n: parseTokens(args[1], p.ctx) };
    }
    if (t.v === 'MATCH') {
      const args = argTokens(p);
      if (args.length !== 3) throw new Error(`MATCH 인자가 3개가 아니다 (${args.length}개)`);
      const mode = args[2];
      if (!(mode.length === 1 && mode[0].t === 'num' && mode[0].v === 0)) {
        throw new Error(`MATCH 의 세 번째 인자가 0(정확히 일치)이 아니다: ${JSON.stringify(mode)}`);
      }
      return { op: 'match', needle: parseTokens(args[0], p.ctx), range: mustRange('MATCH', args[1]) };
    }
    if (t.v === 'SUMPRODUCT') {
      // 실측 28건이 한 모양이다: SUMPRODUCT(--ISNUMBER(범위), --(범위<>"문자")).
      // 일반 배열 수식 엔진을 만들지 않는다 — 다른 모양이 오면 unsupported 로 남긴다.
      const args = argTokens(p);
      if (args.length !== 2) throw new Error(`SUMPRODUCT 인자가 2개가 아니다 (${args.length}개)`);
      return { op: 'rangecount', preds: args.map((a) => sumproductPred(a, p.ctx)) };
    }
    if (t.v === 'N') {
      const args = argTokens(p);
      if (args.length !== 1) throw new Error('N 인자가 1개가 아니다');
      return { op: 'n', inner: parseTokens(args[0], p.ctx) };
    }
    if (t.v === 'LEN') {
      const args = argTokens(p);
      if (args.length !== 1) throw new Error('LEN 인자가 1개가 아니다');
      return { op: 'len', inner: parseTokens(args[0], p.ctx) };
    }
    if (t.v === 'FIND') {
      const args = argTokens(p);
      if (args.length !== 2) throw new Error(`FIND 인자가 2개가 아니다 (${args.length}개)`);
      return { op: 'find', needle: parseTokens(args[0], p.ctx), inside: parseTokens(args[1], p.ctx) };
    }
    if (t.v === 'QUOTIENT' || t.v === 'MOD') {
      const args = argTokens(p);
      if (args.length !== 2) throw new Error(`${t.v} 인자가 2개가 아니다`);
      return { op: t.v === 'QUOTIENT' ? 'quotient' : 'mod',
               a: parseTokens(args[0], p.ctx), b: parseTokens(args[1], p.ctx) };
    }
    if (t.v === 'ROUND') {
      const args = argTokens(p);
      if (args.length !== 2) throw new Error('ROUND 인자가 2개가 아니다');
      return { op: 'round', inner: parseTokens(args[0], p.ctx), digits: parseTokens(args[1], p.ctx) };
    }
    if (t.v === 'AVERAGEIFS') {
      // 인자 배치가 SUMIFS 와 같다(평균범위, 조건범위, 조건, …). long 테이블만 받는다.
      const args = argTokens(p);
      const q = ifsQuery('SUMIFS', args, p.ctx);
      if ('kind' in q) throw new Error('격자 대상 AVERAGEIFS 는 이 데이터에 없다');
      return { op: 'averageifs', q };
    }
    if (t.v === 'SUBSTITUTE') {
      const args = argTokens(p);
      // 네 번째 인자(instance_num)는 이 데이터에 없다 — 오면 추측하지 않는다.
      if (args.length !== 3) throw new Error(`SUBSTITUTE 인자가 3개가 아니다 (${args.length}개)`);
      return {
        op: 'substitute',
        inner: parseTokens(args[0], p.ctx),
        find: parseTokens(args[1], p.ctx),
        replace: parseTokens(args[2], p.ctx),
      };
    }
    if (t.v === 'LEFT' || t.v === 'RIGHT') {
      const args = argTokens(p);
      if (args.length !== 2) throw new Error(`${t.v} 인자가 2개가 아니다 (${args.length}개)`);
      return {
        op: t.v === 'LEFT' ? 'left' : 'right',
        inner: parseTokens(args[0], p.ctx),
        n: parseTokens(args[1], p.ctx),
      };
    }
    if (t.v === 'IFERROR') {
      // Task 9 단위 3: 예전에는 껍데기만 벗기고 fallback 을 버렸다 — 잘못됐다.
      // IFERROR((C23-B23)/B23%,"-") 는 B23=0 이면 "-" 를 내야 한다. div 는 이미
      // 0 으로 나눌 때 null 을 낸다 — inner 의 실행 결과가 null 이면 오류로 본다.
      const args = argTokens(p);
      if (!args[1]) throw new Error('IFERROR 에 fallback 인자가 없다');
      return { op: 'iferror', inner: parseTokens(args[0], p.ctx), fallback: parseTokens(args[1], p.ctx) };
    }
    throw new Error('못 다루는 함수: ' + t.v);
  }
  throw new Error('못 다루는 토큰: ' + t.t);
}

function parseTokens(toks: Token[], ctx: ParseCtx): Expr {
  const p: P = { toks, i: 0, ctx };
  const e = parseCompare(p);
  if (p.i < toks.length) throw new Error('남은 토큰이 있다: ' + JSON.stringify(toks.slice(p.i)));
  return e;
}

export function parseFormula(formula: string, ctx: ParseCtx): Expr {
  try {
    return parseTokens(tokenize(formula), ctx);
  } catch (e) {
    return { op: 'unsupported', reason: (e as Error).message, formula };
  }
}
