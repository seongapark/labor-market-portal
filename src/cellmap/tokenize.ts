export type Token =
  | { t: 'fn'; v: string }
  | { t: 'ref'; ext: number | null; sheet: string | null; a1: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' };

const A1 = /^\$?[A-Z]{1,3}(\$?\d+)?(:\$?[A-Z]{1,3}(\$?\d+)?)?/;
const FN = /^_xlfn\.[A-Za-z][A-Za-z0-9_.]*|^[A-Za-z][A-Za-z0-9_.]*/;

export function tokenize(formula: string): Token[] {
  let s = formula.startsWith('=') ? formula.slice(1) : formula;
  const out: Token[] = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') { i++; continue; }
    if (ch === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (ch === ')') { out.push({ t: 'rp' }); i++; continue; }
    if (ch === ',') { out.push({ t: 'comma' }); i++; continue; }

    if (ch === '"') {                       // 문자열. "" 는 escape 된 인용부호다
      let j = i + 1, buf = '';
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') { buf += '"'; j += 2; continue; }
          break;
        }
        buf += s[j]; j++;
      }
      out.push({ t: 'str', v: buf });
      i = j + 1;
      continue;
    }

    // '[2]시트명'!범위  — 시트명에 공백·특수문자가 있으면 이 형태다
    if (ch === "'") {
      const m = /^'(?:\[(\d+)\])?([^']+)'!/.exec(s.slice(i));
      if (m) {
        const rest = s.slice(i + m[0].length);
        const r = A1.exec(rest);
        if (r) {
          out.push({ t: 'ref', ext: m[1] ? Number(m[1]) : null, sheet: m[2], a1: r[0] });
          i += m[0].length + r[0].length;
          continue;
        }
      }
    }

    // [1]시트명!범위
    if (ch === '[') {
      const m = /^\[(\d+)\]([^!]*)!/.exec(s.slice(i));
      if (m) {
        const rest = s.slice(i + m[0].length);
        const r = A1.exec(rest);
        if (r) {
          out.push({ t: 'ref', ext: Number(m[1]), sheet: m[2], a1: r[0] });
          i += m[0].length + r[0].length;
          continue;
        }
      }
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(s.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }

    // 함수명 · 같은 시트/보조시트 참조 · 셀 참조
    const w = FN.exec(s.slice(i));
    if (w) {
      let name = w[0];
      const after = s.slice(i + name.length);

      if (after.startsWith('(')) {                       // 함수
        out.push({ t: 'fn', v: name.replace(/^_xlfn\./, '') });
        i += name.length;
        continue;
      }
      if (after.startsWith('!')) {                        // 시트명!범위
        const rest = after.slice(1);
        const r = A1.exec(rest);
        if (r) {
          out.push({ t: 'ref', ext: null, sheet: name, a1: r[0] });
          i += name.length + 1 + r[0].length;
          continue;
        }
      }
    }

    // 보조시트는 _ 로 시작해 FN 정규식에 안 걸린다
    if (ch === '_') {
      const m = /^(_[^!]*)!/.exec(s.slice(i));
      if (m) {
        const rest = s.slice(i + m[0].length);
        const r = A1.exec(rest);
        if (r) {
          out.push({ t: 'ref', ext: null, sheet: m[1], a1: r[0] });
          i += m[0].length + r[0].length;
          continue;
        }
      }
    }

    const r = A1.exec(s.slice(i));
    if (r && /[A-Z$]/.test(ch)) {
      out.push({ t: 'ref', ext: null, sheet: null, a1: r[0] });
      i += r[0].length;
      continue;
    }

    const op = /^(<=|>=|<>|[+\-*/^&<>=%])/.exec(s.slice(i));
    if (op) { out.push({ t: 'op', v: op[0] }); i += op[0].length; continue; }

    throw new Error(`토큰화 실패: ${s.slice(i, i + 24)} (전체: ${formula.slice(0, 80)})`);
  }
  return out;
}
