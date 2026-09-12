/** 인쇄된 표 ↔ 엑셀 좌표 매칭 → data/table-spec.json
 *
 *  사용자 결정:
 *    「PDF 에 최종적으로 들어간 표를 기준으로 다시 다듬어야 할듯. 엑셀에 값이 있는 셀 중에는
 *     참고를 위해서 넣은 값도 많아서 ... 굳이 책자 표에 넣지 않아도 되는 값이 많음」
 *    「원데이터가 바뀌어도, 엑셀이나 pdf 대조를 거치지 않고 바로바로 값이 해당 표 위치에
 *     자동 반영되는 것을 고려해 두고 작업할 것」
 *
 *  그래서 이 파일이 내는 것은 **좌표뿐**이다 — 어느 엑셀 행·열을 표의 어느 자리에 놓을지.
 *  값은 담지 않는다. 화면은 `computed-values.json`(원데이터에서 계산)에서 값을 가져온다.
 *  원데이터가 바뀌면 같은 좌표에 새 값이 들어간다. 매칭은 **회차당 한 번**만 돌린다.
 *
 *  실측이 확인해 준 것:
 *    · 엑셀 수치칸 22,920 중 인쇄된 것은 4,766(20.8%). 79.2%는 참고용이다.
 *    · `p8` 의 인쇄 표는 `["구 분","1970","1980",…,"2070"]` = **10년 단위 13열**.
 *      엑셀의 희소 라벨 행에서 유도한 5년 단위 규칙은 틀렸다. **표 모양은 PDF 가 답한다.**
 *    · 인쇄 표는 **단위를 변환**한다(엑셀 32240827 명 → 인쇄본 32,241 천명).
 *      그래서 값 일치는 **배율을 허용**해서 본다 — 그것이 매핑의 자체 검증이 된다.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.REPO_DIR ?? '.';
const dataDir = join(ROOT, 'data');

const pdf = JSON.parse(readFileSync(join(dataDir, 'pdf-pages.json'), 'utf8'));
const toc = JSON.parse(readFileSync(join(dataDir, 'toc.json'), 'utf8'));
const computed = JSON.parse(readFileSync(join(dataDir, 'computed-values.json'), 'utf8')).values;
const constants = JSON.parse(readFileSync(join(dataDir, 'constants.json'), 'utf8')).values;

const colNum = (s) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const colStr = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
const parseRef = (r) => { const m = /^([A-Z]+)([0-9]+)$/.exec(r); return m ? { c: colNum(m[1]), r: +m[2] } : null; };

/** 라벨 비교용 정규화 */
function norm(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  s = s.replace(/[’'`]/g, '').replace(/\s+/g, '');
  s = s.replace(/[()（）\[\]]/g, '').replace(/[·:：~∼\-−–—]/g, '');
  s = s.replace(/(년|월|세|명|원|개|인)$/g, '');
  return s;
}
/** 시점 라벨 → 비교 키 (연도 `2019` 또는 연월 `201908`) */
function periodOf(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  let m = /^[’'`]?([0-9]{2})\s*[.\-\/]\s*([0-9]{1,2})/.exec(raw);
  if (m) return (2000 + +m[1]) * 100 + +m[2];
  m = /^([0-9]{4})\s*[.\-\/]\s*([0-9]{1,2})/.exec(raw);
  if (m) return (+m[1]) * 100 + +m[2];
  const d = raw.replace(/[^0-9]/g, '');
  if (d.length === 6) { const y = +d.slice(0, 4); if (y >= 1900 && y <= 2100) return +d; }
  if (d.length === 4) { const n = +d; if (n >= 1900 && n <= 2100) return n; }
  if (d.length === 2 && /^[’'`]/.test(raw)) { const n = 2000 + +d; if (n <= 2099) return n; }
  return null;
}
function samePeriod(a, b) {
  if (a === null || b === null) return false;
  if (a === b) return true;
  const y = (n) => (n > 9999 ? Math.floor(n / 100) : n);
  return y(a) === y(b);
}
/** 라벨 일치.  **값 검증이 안전망**이므로 느슨하게 본다 —
 *  엑셀이 접두어를 붙이는 경우가 흔하다(인쇄본 `15세이상` ↔ 엑셀 `합계_15세이상`). */
function labelEq(a, b) {
  const pa = periodOf(a), pb = periodOf(b);
  if (pa !== null && pb !== null) return samePeriod(pa, pb);
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 2 && nb.length >= 2 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

const numOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!/^-?[0-9]*\.?[0-9]+$/.test(s)) return null;
  const n = +s;
  return Number.isFinite(n) ? n : null;
};

/** 엑셀 시트의 값 (계산값 우선, 없으면 상수). 확정본은 읽지 않는다 —
 *  매칭도 원데이터 기반 값으로 해야 회차가 바뀌어도 같은 방식이 선다. */
function sheetMap(part, sheet) {
  const pre = part + '!' + sheet + '!';
  const out = {};
  for (const [k, v] of Object.entries(constants)) if (k.startsWith(pre)) out[k.slice(pre.length)] = v;
  for (const [k, v] of Object.entries(computed)) if (k.startsWith(pre)) out[k.slice(pre.length)] = v;
  return out;
}

function looksLikeDataTable(t) {
  const rows = t.rows;
  if (rows.length < 2) return false;
  if (Math.max(...rows.map((r) => r.length)) < 3) return false;
  const flat = rows.flat().map((c) => String(c).trim()).filter(Boolean);
  if (flat.length < 6) return false;
  return flat.filter((c) => /^-?[0-9][0-9,.]*$/.test(c)).length / flat.length >= 0.4;
}

const SCALES = [1, 1000, 0.001, 100, 0.01, 10, 0.1];

const specs = [];
const report = { ok: [], weak: [], fail: [], noTable: [] };

for (const t of toc.pages) {
  if (!t.file || !t.sheet) continue;
  const pp = pdf.pages.find((p) => String(p.page) === String(t.page));
  const tables = (pp?.tables || []).filter(looksLikeDataTable);
  if (!tables.length) { report.noTable.push(t.page); continue; }

  const map = sheetMap(t.file, t.sheet);
  const byPos = new Map();
  for (const [ref, v] of Object.entries(map)) {
    const p = parseRef(ref);
    if (p) byPos.set(p.r + ':' + p.c, v);
  }
  const at = (r, c) => byPos.get(r + ':' + c);
  const allRows = [...new Set([...byPos.keys()].map((k) => +k.split(':')[0]))].sort((a, b) => a - b);
  const allCols = [...new Set([...byPos.keys()].map((k) => +k.split(':')[1]))].sort((a, b) => a - b);

  for (const [ti, tab] of tables.entries()) {
    /* 인쇄 표에서 **머리 줄**과 **항목 열**의 후보를 모두 시도한다.
       앞 판은 「라벨이 가장 많은 줄」을 머리로 골랐는데, 그것이 데이터 행일 수 있었다
       (p117 `["’15","119","116",…]`). 이제 **엑셀과 실제로 맞는 정도**로 고른다. */
    const headCands = [];
    for (let hr = 0; hr < Math.min(3, tab.rows.length); hr++) {
      headCands.push({ hr, labels: tab.rows[hr].map((c) => String(c ?? '').trim()) });
      // 2단 머리: hr 과 hr+1 을 겹쳐 채운다
      if (tab.rows[hr + 1]) {
        const merged = tab.rows[hr].map((c, i) => String(c ?? '').trim() || String(tab.rows[hr + 1][i] ?? '').trim());
        headCands.push({ hr: hr + 1, labels: merged, merged: true });
      }
    }

    let best = null;
    for (const hc of headCands) {
      /* 엑셀에서 이 머리 라벨과 가장 잘 맞는 행 */
      for (const r of allRows) {
        if (r > 45) continue;
        /* 같은 엑셀 열을 두 번 쓰지 않는다 — 인쇄 머리가 반복되는 표가 있다
           (p90 `["’24년","’25년","’24년","’25년"]` = 좌우 두 개의 작은 표). */
        const usedC = new Set();
        const colMap = hc.labels.map((h) => {
          if (!h) return null;
          for (const c of allCols) {
            if (usedC.has(c)) continue;
            const v = at(r, c);
            if (v !== undefined && labelEq(h, v)) { usedC.add(c); return c; }
          }
          return null;
        });
        const need = hc.labels.filter(Boolean).length;
        const hit = colMap.filter((c) => c !== null).length;
        if (!need || hit / need < 0.3) continue;

        /* 항목 열 — 인쇄 첫 열(또는 앞 2열 합침)의 라벨과 맞는 엑셀 열 */
        const bodyRows = tab.rows.slice(hc.hr + 1);
        for (const variant of [0, 1]) {
          const labels = bodyRows.map((row) => {
            const a = String(row[0] ?? '').trim();
            const b = String(row[1] ?? '').trim();
            return variant === 0 ? a : (a || b);
          });
          for (const lc of allCols.slice(0, 5)) {
            const usedR = new Set();
            const rowMap = labels.map((lb) => {
              if (!lb) return null;
              for (const r2 of allRows) {
                if (usedR.has(r2)) continue;
                const v = at(r2, lc);
                if (v !== undefined && labelEq(lb, v)) { usedR.add(r2); return r2; }
              }
              return null;
            });
            const rneed = labels.filter(Boolean).length;
            const rhit = rowMap.filter((x) => x !== null).length;
            if (!rneed || rhit / rneed < 0.3) continue;

            /* **자체 검증** — 매핑이 맞으면 계산값이 인쇄값과 일정한 배율로 맞는다.
               라벨만 보면 우연히 맞을 수 있지만 값까지 맞기는 어렵다. */
            let bestScale = 1, bestVal = 0, pairs = 0;
            for (const sc of SCALES) {
              let good = 0, seen = 0;
              rowMap.forEach((r2, ri) => {
                if (r2 === null) return;
                colMap.forEach((c2, ci) => {
                  if (c2 === null) return;
                  const printed = numOf(bodyRows[ri]?.[ci]);
                  const got = numOf(at(r2, c2));
                  if (printed === null || got === null) return;
                  seen++;
                  const scaled = got * sc;
                  const tol = Math.max(Math.abs(printed) * 0.02, 0.6);
                  if (Math.abs(scaled - printed) <= tol) good++;
                });
              });
              if (seen && good / seen > bestVal) { bestVal = good / seen; bestScale = sc; pairs = seen; }
            }

            const score = (hit / need) * 0.25 + (rhit / rneed) * 0.25 + bestVal * 0.5;
            if (!best || score > best.score) {
              best = {
                score, headerRow: r, labelCol: lc, headRowIdx: hc.hr, variant,
                cols: colMap, rows: rowMap,
                printedHead: hc.labels, printedLabels: labels,
                headRate: +(hit / need).toFixed(3), rowRate: +(rhit / rneed).toFixed(3),
                valRate: +bestVal.toFixed(3), scale: bestScale, valPairs: pairs,
              };
            }
          }
        }
      }
    }

    if (!best) { report.fail.push({ page: t.page, why: '머리·항목 후보가 없다', head: (tab.rows[0] || []).slice(0, 5) }); continue; }
    const entry = { page: t.page, part: t.file, sheet: t.sheet, table: ti, ...best };
    delete entry.score;
    /* 받아들이는 기준: **값이 맞아야 한다.** 라벨만 맞고 값이 안 맞으면 매핑이 틀린 것이다. */
    // 작은 표는 쌍이 적다 — 그런 경우 값이 **완전히** 맞아야 채택한다
    const okBig = best.valRate >= 0.8 && best.valPairs >= 4;
    const okSmall = best.valRate >= 0.99 && best.valPairs >= 2;
    if (okBig || okSmall) { specs.push(entry); report.ok.push(t.page); }
    else if (best.valRate >= 0.5 && best.valPairs >= 4) { specs.push(entry); report.weak.push(t.page); }
    else report.fail.push({ page: t.page, headRate: best.headRate, rowRate: best.rowRate, valRate: best.valRate, pairs: best.valPairs, head: best.printedHead.filter(Boolean).slice(0, 5) });
  }
}

const out = {
  what: '인쇄 표의 행·열을 엑셀 **좌표**로 옮긴 명세. 값은 담지 않는다.',
  source: 'data/pdf-pages.json × data/computed-values.json+constants.json',
  note: '값은 화면이 computed-values.json 에서 가져온다 — 원데이터가 바뀌면 같은 좌표에 '
      + '새 값이 들어간다. 이 매칭은 회차당 한 번만 돌린다. '
      + '받아들이는 기준은 **값 일치율**이다(배율 허용) — 라벨만 맞고 값이 안 맞으면 매핑이 틀린 것.',
  counts: { ok: new Set(report.ok).size, weak: new Set(report.weak).size, fail: report.fail.length, noTable: report.noTable.length },
  fail: report.fail,
  specs,
};
writeFileSync(join(dataDir, 'table-spec.json'), JSON.stringify(out, null, 1));

console.log('인쇄 데이터표가 있는 쪽');
console.log('  값 일치 80%+ (채택)   : ' + out.counts.ok);
console.log('  값 일치 50~80% (약함) : ' + out.counts.weak);
console.log('  실패                  : ' + out.counts.fail);
console.log('데이터표 없는 쪽        : ' + out.counts.noTable);
const scales = {};
for (const s of specs) scales[s.scale] = (scales[s.scale] || 0) + 1;
console.log('배율 분포: ' + Object.entries(scales).map(([k, v]) => '×' + k + ':' + v).join(' '));
console.log('→ data/table-spec.json (' + (readFileSync(join(dataDir, 'table-spec.json')).length / 1024).toFixed(1) + ' KB)');
if (out.fail.length) {
  console.log('');
  console.log('=== 실패 (추측으로 채우지 않는다) ===');
  out.fail.slice(0, 16).forEach((u) => console.log('  p' + String(u.page).padEnd(5)
    + (u.valRate !== undefined ? '값 ' + u.valRate + ' (쌍 ' + u.pairs + ') 머리 ' + u.headRate + ' 항목 ' + u.rowRate : u.why)
    + '  ' + JSON.stringify(u.head).slice(0, 60)));
}
