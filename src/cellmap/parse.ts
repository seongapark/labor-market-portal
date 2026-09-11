import { tokenize, type Token } from './tokenize.ts';
import type { Crit, Expr, Headers, Query, Src } from '../types.ts';

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

/** 조건 인자 하나를 Crit 으로 */
function toCrit(toks: Token[]): Crit {
  if (toks.length === 1) {
    const t = toks[0];
    if (t.t === 'str') return { kind: 'lit', value: t.v };
    if (t.t === 'num') return { kind: 'lit', value: String(t.v) };
    if (t.t === 'ref' && t.ext === null && t.sheet === null) {
      return { kind: 'cell', ref: plainRef(t.a1) };
    }
  }
  // RULING(9/10, 8195건 중 8150건 실측): TEXT(<셀 하나>,"0") — 연도 조건은 그 셀이
  // 가리키는 값을 실행 시점에 읽는다. 셀 하나가 아닌 형태(45건, 실측)는 무엇을 읽어야
  // 할지 알 수 없어 unsupported 로 남긴다 — 추측하지 않는다.
  if (toks[0]?.t === 'fn' && toks[0].v === 'TEXT') {
    const args = textCallArgs(toks);
    const first = args[0];
    if (first && first.length === 1) {
      const t = first[0];
      if (t.t === 'ref' && t.ext === null && t.sheet === null) {
        return { kind: 'year', ref: plainRef(t.a1) };
      }
    }
    throw new Error('TEXT 조건의 인자가 단일 같은시트 셀 참조가 아니다: ' + JSON.stringify(toks));
  }
  throw new Error('조건을 못 읽었다: ' + JSON.stringify(toks));
}

function ifsQuery(name: 'SUMIFS' | 'COUNTIFS', args: Token[][], ctx: ParseCtx): Query {
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

  if (name === 'SUMIFS') {
    const v = refOf(args[0]);
    src = v.src; sheet = v.sheet;
    value = colName(src, sheet, v.a1, ctx.headers);
    rest = args.slice(1);
  } else {
    const v = refOf(args[0]);
    src = v.src; sheet = v.sheet;
    value = colName(src, sheet, v.a1, ctx.headers);   // COUNTIFS 는 첫 범위가 곧 조건 범위다
    rest = args;
  }

  const where: Record<string, Crit> = {};
  for (let k = 0; k + 1 < rest.length; k += 2) {
    const cr = refOf(rest[k]);
    if (cr.src !== src || cr.sheet !== sheet) {
      throw new Error(`한 ${name} 안에서 시트가 갈린다: ${cr.sheet} vs ${sheet}`);
    }
    where[colName(src, sheet, cr.a1, ctx.headers)] = toCrit(rest[k + 1]);
  }
  return { src, table: sheet!, value, where };
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
    throw new Error('산술에 외부통합문서 참조가 왔다: ' + t.a1);
  }
  if (t.t === 'fn') {
    if (t.v === 'SUMIFS' || t.v === 'COUNTIFS') {
      const args = argTokens(p);
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
