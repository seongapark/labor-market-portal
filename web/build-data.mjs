/** 배포용 데이터 번들
 *  발간 PDF 목차(`data/toc.json`)를 축으로 삼고, 검증된 수치와 **엑셀이 선언한 차트**를
 *  이어붙인다.
 *
 *  목차가 축인 이유: 엑셀 작업본의 part/sheet 구성은 **제작 편의를 위한 분할**이고,
 *  독자가 보는 구조가 아니다. 독자가 아는 구조는 발간본 목차다(Part › 장 › 절 › 지면).
 *
 *  차트를 추론하지 않는 이유: 목업 단계에서 표 모양으로 차트 종류를 추론했고 그것이
 *  결함 5건을 만들었다. 통합문서에는 차트가 **선언**돼 있다(`data/charts.json`).
 *  그것이 유일한 근거이고, 사용자가 명시적으로 다르게 지시한 지면만 재정의한다.
 *
 *  읽는 것: toc.json · charts.json · gate-snapshot.json · layout.json · oracle/ ·
 *           known-divergences.json.  원본 엑셀은 열지 않는다. */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.env.REPO_DIR ? process.env.REPO_DIR + '/' : './';
const OUT = process.env.OUT ?? 'dist/data.json';

const snap = JSON.parse(readFileSync(ROOT + 'data/gate-snapshot.json', 'utf8'));
const toc = JSON.parse(readFileSync(ROOT + 'data/toc.json', 'utf8'));
const layout = JSON.parse(readFileSync(ROOT + 'data/layout.json', 'utf8'));
const known = JSON.parse(readFileSync(ROOT + 'data/known-divergences.json', 'utf8'));
const chartDefs = JSON.parse(readFileSync(ROOT + 'data/charts.json', 'utf8'));

const oracle = {};
for (const f of readdirSync(join(ROOT, 'data/oracle'))) {
  if (f.endsWith('.json')) oracle[f.replace('.json', '')] = JSON.parse(readFileSync(join(ROOT, 'data/oracle', f), 'utf8'));
}
const srcOf = new Map();
for (const p of layout.pages) srcOf.set(p.part + '!' + p.sheet, { org: p.a2 || '', stat: p.c2 || '' });

/* ── 사용자가 통합문서와 다르게 지시한 지면 ────────────────────────────────
   엑셀 선언이 기본값이다. 이 목록은 **사용자의 명시적 지시만** 담는다.
   추측으로 늘리지 않는다 — 늘리는 순간 「원본이 명시하는 것만 읽는다」가 무너진다. */
const OVERRIDE = {
  // "p195, p40같은 경우는 pdf를 참고해서 파이차트로 구현하는게 정보전달이 더 좋음"
  // + "p195에 남자 여자 파이 두께도 각각 동일하게 수정"
  // 통합문서는 barChart/clustered 2계열(정규직·비정규직)이라고 선언한다.
  p195: { kind: 'pieChart', why: '사용자 지시 — 통합문서는 barChart 이지만 파이가 정보전달이 낫다' },

  // "취업자랑 실업자랑 합친게 경제활동인구니까 저건 말이안되는거지,
  //  비경제활동인구랑 합쳐서 전체를 만들어야지"
  // 통합문서의 파이는 A10:A12 = 경제활동인구·취업자·실업자 인데, 취업+실업=경활 이므로
  // 합이 59,197.8 로 의미가 없다. 실측: B10 29,598.9 + B13 16,163.5 = B9 45,762.4(15세이상인구).
  // 그래서 **범주를 A10·A13(경제활동/비경제활동)으로 바꾼다.** 종류(pie)는 통합문서와 같다.
  p40: {
    kind: 'pieChart',
    series: [{ catRefs: ["'p40'!$A$10", "'p40'!$A$13"], valRefs: ["'p40'!$B$10", "'p40'!$B$13"] }],
    why: '사용자 지시 — 취업자+실업자=경제활동인구라서 원래 파이는 중복 집계다. '
       + '경제활동인구와 비경제활동인구로 전체를 만든다',
  },
};

const colNum = (s) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const parseRef = (ref) => { const m = /^([A-Z]+)([0-9]+)$/.exec(ref); return m ? { c: colNum(m[1]), r: +m[2] } : null; };
const colStr = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };

const exempt = new Set(known.map((k) => `${k.part}!${k.sheet}!${k.ref}`));

// 계산값을 지면별로 모은다
const computed = {};
for (const [key, v] of Object.entries(snap.values)) {
  const j = key.lastIndexOf('!');
  (computed[key.slice(0, j)] = computed[key.slice(0, j)] || {})[key.slice(j + 1)] = v;
}

/** 해석용 전체 값 맵: 계산값이 있으면 계산값, 없으면 확정본. 행 제한 없음.
 *  차트 범위가 1~3행(제목 줄)이나 표 밖을 가리킬 수 있으므로 걸러내지 않는다. */
function fullMap(part, sheet) {
  const oc = oracle[part]?.[sheet] || {};
  const comp = computed[`${part}!${sheet}`] || {};
  const out = {};
  for (const [k, v] of Object.entries(oc)) out[k] = v;
  for (const [k, v] of Object.entries(comp)) out[k] = v;
  return out;
}

/** `'p8'!$B$4:$CX$4` · `('p86'!$D$5,'p86'!$F$5)` · `'p40'!$A$10` → [{sheet, ref}] 순서대로 */
function expandRef(f, hostSheet) {
  if (!f) return [];
  const out = [];
  const body = f.replace(/^\(/, '').replace(/\)$/, '');
  for (const piece of body.split(',')) {
    const m = /^(?:'([^']+)'|([A-Za-z0-9_가-힣.]+))!(.+)$/.exec(piece.trim());
    const sheet = m ? (m[1] ?? m[2]) : hostSheet;
    const rangePart = m ? m[3] : piece.trim();
    const clean = rangePart.replace(/\$/g, '');
    const rm = /^([A-Z]+[0-9]+):([A-Z]+[0-9]+)$/.exec(clean);
    if (rm) {
      const a = parseRef(rm[1]), b = parseRef(rm[2]);
      if (!a || !b) continue;
      const r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r);
      const c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ sheet, ref: colStr(c) + r });
    } else if (/^[A-Z]+[0-9]+$/.test(clean)) {
      out.push({ sheet, ref: clean });
    }
  }
  return out;
}

const maps = new Map();
function valueAt(part, sheet, ref) {
  const k = part + '!' + sheet;
  if (!maps.has(k)) maps.set(k, fullMap(part, sheet));
  const v = maps.get(k)[ref];
  return v === undefined ? null : v;
}
function resolve(part, f, hostSheet) {
  return expandRef(f, hostSheet).map((x) => valueAt(part, x.sheet, x.ref));
}
function resolveOne(part, f, hostSheet) {
  const a = resolve(part, f, hostSheet);
  return a.length ? a[0] : null;
}

/** 차트 선언 → 그릴 수 있는 형태.  계열마다 범주와 값을 실제 수치로 푼다. */
function buildCharts(part, sheet) {
  const specs = chartDefs.parts?.[part]?.[sheet];
  if (!specs) return [];
  const out = [];
  for (const s of specs) {
    // valAx 의 위치로 주축/보조축을 가른다 (이중축 77개)
    const axPos = {};
    for (const [id, a] of Object.entries(s.axes)) if (a.type === 'valAx') axPos[id] = a.pos || 'l';
    let lastCat = null;
    const groups = [];
    for (const g of s.groups) {
      const series = [];
      for (const se of g.series) {
        const cats = se.cat ? resolve(part, se.cat, sheet) : null;
        if (cats && cats.length) lastCat = cats;
        const vals = resolve(part, se.val, sheet).map((v) => (typeof v === 'number' ? v : null));
        if (!vals.length) continue;
        series.push({
          name: se.name ?? (se.nameRef ? resolveOne(part, se.nameRef, sheet) : null),
          cats: cats && cats.length ? cats : lastCat,   // 범주 없는 35계열은 형제에서 물려받는다
          vals,
          smooth: !!se.smooth,
        });
      }
      if (!series.length) continue;
      const ids = g.axIds.filter((id) => id in axPos);
      groups.push({
        kind: g.kind,
        barDir: g.barDir || null,
        grouping: g.grouping || null,
        axis: ids.length ? (axPos[ids[ids.length - 1]] === 'r' ? 'r' : 'l') : 'l',
        series,
      });
    }
    if (groups.length) out.push({ title: s.title || null, groups });
  }
  // 사용자 재정의
  const ov = OVERRIDE[sheet];
  if (ov && out.length) {
    for (const c of out) {
      for (const g of c.groups) {
        if (ov.kind) g.kind = ov.kind;
        g.override = ov.why;
      }
    }
    if (ov.series) {
      // 계열까지 바꾸는 재정의: 첫 차트의 첫 그룹만 갈아끼운다
      out[0].groups = [{
        kind: ov.kind, barDir: null, grouping: null, axis: 'l', override: ov.why,
        series: ov.series.map((s) => ({
          name: null,
          cats: s.catRefs.map((f) => resolveOne(part, f, sheet)),
          vals: s.valRefs.map((f) => {
            const v = resolveOne(part, f, sheet);
            return typeof v === 'number' ? v : null;
          }),
          smooth: false,
        })),
      }];
      out.length = 1;
    }
  }
  return out;
}

const pages = [];
for (const t of toc.pages) {
  const pageKey = t.file && t.sheet ? `${t.file}!${t.sheet}` : null;
  const oc = (pageKey && oracle[t.file]?.[t.sheet]) || {};
  const comp = (pageKey && computed[pageKey]) || {};
  const src = (pageKey && srcOf.get(pageKey)) || { org: '', stat: '' };

  const cells = [];
  let verified = 0, exemptN = 0;
  for (const ref of new Set([...Object.keys(oc), ...Object.keys(comp)])) {
    const pos = parseRef(ref);
    if (!pos || pos.r <= 3) continue;          // 1~3행은 제목·출처 메타. 머리로 따로 쓴다
    const hasComp = ref in comp;
    const ex = exempt.has(`${pageKey}!${ref}`);
    if (hasComp && !ex) verified++;
    if (ex) exemptN++;
    cells.push({
      r: pos.r, c: pos.c,
      v: hasComp ? comp[ref] : (oc[ref] ?? null),
      o: ex ? oc[ref] : undefined,
      k: hasComp ? (ex ? 'x' : 'v') : 'l',
    });
  }
  cells.sort((a, b) => a.r - b.r || a.c - b.c);

  pages.push({
    page: t.page, part: t.part, chapter: t.chapter, section: t.section,
    title: t.title, sheet: t.sheet, org: src.org, stat: src.stat,
    verified, exempt: exemptN,
    charts: pageKey ? buildCharts(t.file, t.sheet) : [],
    cells,
  });
}

const withData = pages.filter((p) => p.cells.length).length;
// 한 시트가 여러 지면을 덮는다(`p116_117` 등). 총계는 **시트 기준으로 한 번만** 센다 —
// 지면별로 더하면 그 시트의 칸이 두 번 세어져 관문 수치와 어긋난다.
const bySheet = new Map();
for (const p of pages) if (p.sheet && !bySheet.has(p.sheet)) bySheet.set(p.sheet, p);
const verifiedTotal = [...bySheet.values()].reduce((a, p) => a + p.verified, 0);
const exemptTotal = [...bySheet.values()].reduce((a, p) => a + p.exempt, 0);
const chartTotal = [...bySheet.values()].reduce((a, p) => a + p.charts.length, 0);
const withCharts = [...bySheet.values()].filter((p) => p.charts.length).length;
const multi = pages.length - bySheet.size;

const out = {
  meta: {
    anchor: snap.anchor, commit: snap.commit.slice(0, 7), generated_at: snap.generated_at,
    comparable: snap.comparable, rate: snap.rate, counts: snap.counts,
    pages: pages.length, withData, sheets: bySheet.size,
    verifiedShown: verifiedTotal, charts: chartTotal, sheetsWithCharts: withCharts,
    repo: 'https://github.com/seongapark/labor-market-portal',
    toc_source: toc.source,
    chart_source: chartDefs.source,
  },
  exempt: known,
  pages,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log('목차 지면 ' + pages.length + ' · 수치 있는 지면 ' + withData
  + ' · 시트 ' + bySheet.size + ' (여러 지면을 덮는 시트로 겹치는 지면 ' + multi + '개)');
console.log('검증칸 ' + verifiedTotal + ' · 면제 ' + exemptTotal + '  ← 시트 기준, 중복 없음');
console.log('차트 ' + chartTotal + '개 · 차트 있는 시트 ' + withCharts + '개');
const kinds = {};
for (const p of bySheet.values()) for (const c of p.charts) for (const g of c.groups) kinds[g.kind] = (kinds[g.kind] || 0) + 1;
console.log('  ' + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(' · '));
console.log('번들 ' + (readFileSync(OUT).length / 1024 / 1024).toFixed(2) + ' MB → ' + OUT);
const noData = pages.filter((p) => !p.cells.length);
if (noData.length) console.log('수치 없는 지면 ' + noData.length + '개: ' + noData.map((p) => 'p' + p.page).join(' '));
