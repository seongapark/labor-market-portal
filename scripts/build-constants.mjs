/** 상수 물화 — 확정본을 실행 경로에서 빼낸다.
 *
 *  왜: 화면이 값을 계산하려면 지금 확정본(`data/oracle/`)을 읽어야 한다. 전체 리뷰가
 *  지적한 대로 일치 셀의 26.4%가 DB 를 아예 타지 않고 통합문서 리터럴에 의존한다.
 *  그러면 「원데이터를 다시 받으면 수치가 갱신된다」가 성립하지 않는다.
 *
 *  실측(scripts/analyze-literals.mjs): 추이적 잎이 **247개**뿐이고 거의 전부 데이터가
 *  아니다 — VLOOKUP 열 번호 83 · 문자 라벨 82 · 축 시작연도 77 · 나머지 5(그중 4개는
 *  영국·미국·프랑스의 고령화사회 도달 연도라는 역사 상수).
 *
 *  그래서 그 247개를 **명세로 물화**한다. 그 뒤 계산에 필요한 것은
 *  `cellmap + constants + obs.sqlite` 뿐이고, 확정본은 **검증에만** 쓰인다.
 *
 *  실행: node scripts/build-constants.mjs
 *  산출: data/constants.json
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.REPO_DIR ?? '.';
const dataDir = join(ROOT, 'data');

const maps = {}, oracle = {};
for (const f of readdirSync(join(dataDir, 'cellmap'))) {
  if (f.endsWith('.json')) maps[f.replace('.json', '')] = JSON.parse(readFileSync(join(dataDir, 'cellmap', f), 'utf8'));
}
for (const f of readdirSync(join(dataDir, 'oracle'))) {
  if (f.endsWith('.json')) oracle[f.replace('.json', '')] = JSON.parse(readFileSync(join(dataDir, 'oracle', f), 'utf8'));
}
const charts = JSON.parse(readFileSync(join(dataDir, 'charts.json'), 'utf8'));

const colNum = (s) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const colStr = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
const parseRef = (r) => { const m = /^([A-Z]+)([0-9]+)$/.exec(r); return m ? { c: colNum(m[1]), r: +m[2] } : null; };

/** 명세(Expr) 안의 모든 cell 참조를 찾는다. 스키마를 다 알지 않아도 되게 일반 순회. */
function cellRefs(node, out) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) cellRefs(x, out); return out; }
  // Expr 의 셀 노드
  if (node.op === 'cell' && typeof node.ref === 'string') out.push({ sheet: node.sheet ?? null, ref: node.ref });
  // **Crit 의 셀 노드** — 조건은 {kind:'cell', ref} 로 셀을 가리킨다.
  // 이것을 빼먹어 조건 셀이 미리 계산되지 않고 SUMIFS 가 0 을 냈다(13,665칸).
  if (node.kind === 'cell' && typeof node.ref === 'string') out.push({ sheet: node.sheet ?? null, ref: node.ref });
  // **범위 노드** — agg(SUM/MAX/COUNTA)·조회·SUMPRODUCT 가 {range:{r1,r2,c1,c2}} 로 온다.
  // 이것을 빼먹어 SUM(C6:C20) 이 C6 하나만 더하고 C6/(C6%) = 100 이 나왔다(7,277칸).
  if (node.range && typeof node.range === 'object') {
    const g = node.range;
    if ([g.r1, g.r2, g.c1, g.c2].every((n) => typeof n === 'number')) {
      for (let r = Math.min(g.r1, g.r2); r <= Math.max(g.r1, g.r2); r++) {
        for (let c = Math.min(g.c1, g.c2); c <= Math.max(g.c1, g.c2); c++) {
          out.push({ sheet: node.sheet ?? g.sheet ?? null, ref: colStr(c) + r });
        }
      }
    }
  }
  // {kind:'year', e} 의 e, {kind:'expr'} 의 e 등은 아래 일반 순회가 훑는다
  for (const v of Object.values(node)) cellRefs(v, out);
  return out;
}

const specOf = (part, sheet, ref) => maps[part]?.sheets?.[sheet]?.[ref];

/** 잎(수식이 없는 셀) 수집 — 메모이즈 + 순환 방지 */
const cache = new Map();
function leaves(part, sheet, ref, seen = new Set()) {
  const key = `${part}!${sheet}!${ref}`;
  if (cache.has(key)) return cache.get(key);
  if (seen.has(key)) return new Set();
  seen.add(key);
  const spec = specOf(part, sheet, ref);
  let out;
  if (spec === undefined) {
    out = new Set([key]);
  } else {
    out = new Set();
    for (const d of cellRefs(spec, [])) {
      for (const l of leaves(part, d.sheet ?? sheet, d.ref, seen)) out.add(l);
    }
  }
  seen.delete(key);
  cache.set(key, out);
  return out;
}

/* 1) 명세가 있는 모든 셀의 잎 */
const need = new Set();
for (const [part, m] of Object.entries(maps)) {
  for (const [sheet, cells] of Object.entries(m.sheets)) {
    for (const ref of Object.keys(cells)) for (const l of leaves(part, sheet, ref)) need.add(l);
  }
}

/* 2) 차트 범위가 가리키는 칸도 필요하다 — 그래프의 범주 라벨은 대개 수식이 없는 문자다 */
function expandRef(f, hostSheet) {
  const out = [];
  for (const piece of String(f).replace(/^\(/, '').replace(/\)$/, '').split(',')) {
    const m = /^(?:'([^']+)'|([A-Za-z0-9_가-힣.]+))!(.+)$/.exec(piece.trim());
    const sheet = m ? (m[1] ?? m[2]) : hostSheet;
    const clean = (m ? m[3] : piece.trim()).replace(/\$/g, '');
    const rm = /^([A-Z]+[0-9]+):([A-Z]+[0-9]+)$/.exec(clean);
    if (rm) {
      const a = parseRef(rm[1]), b = parseRef(rm[2]);
      if (!a || !b) continue;
      for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
        for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.push({ sheet, ref: colStr(c) + r });
      }
    } else if (/^[A-Z]+[0-9]+$/.test(clean)) out.push({ sheet, ref: clean });
  }
  return out;
}
let chartCells = 0;
for (const [part, sheets] of Object.entries(charts.parts)) {
  for (const [sheet, specs] of Object.entries(sheets)) {
    for (const sp of specs) {
      for (const g of sp.groups || []) {
        for (const se of g.series || []) {
          for (const f of [se.cat, se.val, se.nameRef]) {
            if (!f) continue;
            for (const x of expandRef(f, sheet)) {
              // 수식이 있으면 계산되므로 상수가 아니다
              if (specOf(part, x.sheet, x.ref) !== undefined) continue;
              need.add(`${part}!${x.sheet}!${x.ref}`);
              chartCells++;
            }
          }
        }
      }
    }
  }
}

/* 3) 확정본에서 값을 떠 온다. 여기가 확정본을 읽는 **마지막** 지점이다. */
const values = {};
let missing = 0;
for (const key of [...need].sort()) {
  const j = key.lastIndexOf('!'), i = key.indexOf('!');
  const v = oracle[key.slice(0, i)]?.[key.slice(i + 1, j)]?.[key.slice(j + 1)];
  if (v === undefined) { missing++; continue; }
  values[key] = v;
}

const kinds = { num: 0, str: 0, year: 0, smallint: 0 };
for (const v of Object.values(values)) {
  if (typeof v === 'string') kinds.str++;
  else if (typeof v === 'number') {
    kinds.num++;
    if (Number.isInteger(v) && v >= 1800 && v <= 2100) kinds.year++;
    else if (Number.isInteger(v) && Math.abs(v) <= 100) kinds.smallint++;
  }
}

const out = {
  what: '수식이 없는 칸(상수)의 값. 확정본을 실행 경로에서 빼내기 위한 **명세**다.',
  source: 'data/oracle/*.json — 회차마다 한 번 물화한다. 매월 갱신에는 쓰이지 않는다.',
  note: '이것이 있으면 계산에 필요한 것은 cellmap + constants + obs.sqlite 뿐이다. '
      + '확정본은 검증(관문)에만 쓴다. 실측 분류: 문자 라벨·축 시작연도·조회 열번호가 대부분이고 '
      + '통계값은 없다(scripts/analyze-literals-classify.mjs).',
  counts: { cells: Object.keys(values).length, missing, ...kinds },
  values,
};
writeFileSync(join(dataDir, 'constants.json'), JSON.stringify(out, null, 1));
console.log('상수 ' + Object.keys(values).length + '개 (확정본에 없어 건너뛴 것 ' + missing + ')');
console.log('  문자 ' + kinds.str + ' · 수치 ' + kinds.num
  + ' (그중 연도꼴 ' + kinds.year + ' · 작은정수 ' + kinds.smallint + ')');
console.log('  차트 범위에서 더한 칸 ' + chartCells + '건(중복 포함)');
console.log('→ data/constants.json ('
  + (readFileSync(join(dataDir, 'constants.json')).length / 1024).toFixed(1) + ' KB)');
