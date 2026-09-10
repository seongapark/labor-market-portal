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
  // TEXT(셀,"0") — 연도 조건
  if (toks[0]?.t === 'fn' && toks[0].v === 'TEXT') return { kind: 'year' };
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
  if (t.t === 'lp') {
    const e = parseExpr(p);
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
      // IF(X=0,"-",X) 만 다룬다
      const isZeroTest = args[0].some((x) => x.t === 'op' && x.v === '=')
        && args[0].some((x) => x.t === 'num' && x.v === 0);
      const dash = args[1].length === 1 && args[1][0].t === 'str';
      if (isZeroTest && dash && args[2]) {
        return { op: 'zeroDash', inner: parseTokens(args[2], p.ctx) };
      }
      throw new Error('IF 형태를 못 다룬다');
    }
    if (t.v === 'NUMBERVALUE' || t.v === 'IFERROR') {
      const args = argTokens(p);
      return parseTokens(args[0], p.ctx);   // 껍데기만 벗긴다
    }
    throw new Error('못 다루는 함수: ' + t.v);
  }
  throw new Error('못 다루는 토큰: ' + t.t);
}

function parseTokens(toks: Token[], ctx: ParseCtx): Expr {
  const p: P = { toks, i: 0, ctx };
  const e = parseExpr(p);
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
