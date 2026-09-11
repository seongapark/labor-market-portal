/** 인쇄된 표 ↔ 엑셀 셀 매칭 → data/table-spec.json
 *
 *  사용자 결정: 「PDF 에 최종적으로 들어간 표를 기준으로 다시 다듬어야 할듯. 엑셀에 값이
 *  있는 셀 중에는 참고를 위해서 넣은 값도 많아서 ... 굳이 책자 표에 넣지 않아도 되는 값이
 *  많음」 + 「업데이트는 PDF나 엑셀 의존적이지 않도록, 원데이터에서 바로」
 *
 *  그래서 PDF 는 **「무엇을 보여줄지」의 명세**로만 쓰고, 값은 계산값에서 가져온다.
 *  PDF 값을 그대로 쓰면 매월 갱신이 표에 반영되지 않는다.
 *
 *  방법: 인쇄 표의 **머리행**과 **첫 열**을 엑셀 시트의 라벨과 맞춰, 보여줄 (행,열) 좌표를
 *  정한다. 라벨이 안 맞는 지면은 **추측으로 채우지 않고 목록으로 보고**한다.
 *
 *  실측이 확인해 준 것: `p8` 의 인쇄 표는 `7행 × 13열`, 머리가
 *  `["구 분","1970","1980",…,"2070"]` = **10년 단위**다. 내가 엑셀의 희소 라벨 행에서
 *  유도한 규칙은 5년 단위(21칸)를 냈으니 틀렸다. **표 모양은 PDF 가 답한다.**
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.REPO_DIR ?? '.';
const dataDir = join(ROOT, 'data');

const pdf = JSON.parse(readFileSync(join(dataDir, 'pdf-pages.json'), 'utf8'));
const toc = JSON.parse(readFileSync(join(dataDir, 'toc.json'), 'utf8'));
const computed = JSON.parse(readFileSync(join(dataDir, 'computed-values.json'), 'utf8')).values;
const constants = JSON.parse(readFileSync(join(dataDir, 'constants.json'), 'utf8')).values;

const oracle = {};
for (const f of readdirSync(join(dataDir, 'oracle'))) {
  if (f.endsWith('.json')) oracle[f.replace('.json', '')] = JSON.parse(readFileSync(join(dataDir, 'oracle', f), 'utf8'));
}

const colNum = (s) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const colStr = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
const parseRef = (r) => { const m = /^([A-Z]+)([0-9]+)$/.exec(r); return m ? { c: colNum(m[1]), r: +m[2] } : null; };

/** 라벨 비교용 정규화 — 공백·괄호주석·특수문자를 털어낸다 */
function norm(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  s = s.replace(/[’']/g, '').replace(/\s+/g, '');
  s = s.replace(/[()（）]/g, '').replace(/[·:：~∼-]/g, '');
  s = s.replace(/년$|월$|세$/g, '');
  return s;
}
/** 시점 라벨을 비교 가능한 키로.  실패 8건의 원인이 여기였다 —
 *  머리가 `’19.8` `’20.6` `'20.8` 처럼 **연.월**인데 4자리·2자리만 보고 있었다.
 *  돌려주는 값: 연도만이면 `2019`, 연·월이면 `201908` (엑셀의 prd_de 와 같은 꼴). */
function periodOf(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  // ’19.8 · '20.6 · 19.8월 → 연+월
  let m = /^[’'`]?([0-9]{2})\s*[.\-\/]\s*([0-9]{1,2})/.exec(raw);
  if (m) return (2000 + +m[1]) * 100 + +m[2];
  // 2019.8 · 2019-08
  m = /^([0-9]{4})\s*[.\-\/]\s*([0-9]{1,2})/.exec(raw);
  if (m) return (+m[1]) * 100 + +m[2];
  // 201908
  m = /^([0-9]{6})$/.exec(raw.replace(/[^0-9]/g, ''));
  if (m) { const y = +m[1].slice(0, 4); if (y >= 1900 && y <= 2100) return +m[1]; }
  // 2019 · 2019년
  const d = raw.replace(/[^0-9]/g, '');
  if (d.length === 4) { const n = +d; if (n >= 1900 && n <= 2100) return n; }
  if (d.length === 2 && /^[’'`]/.test(raw)) { const n = 2000 + +d; if (n <= 2099) return n; }
  return null;
}
/** 시점 비교 — 연도끼리, 연월끼리, 그리고 「연월 vs 그 연도」도 맞는 것으로 본다 */
function samePeriod(a, b) {
  if (a === null || b === null) return false;
  if (a === b) return true;
  const ya = a > 999999 ? null : (a > 9999 ? Math.floor(a / 100) : a);
  const yb = b > 999999 ? null : (b > 9999 ? Math.floor(b / 100) : b);
  return ya !== null && yb !== null && ya === yb && (a > 9999) !== (b > 9999);
}

/** 엑셀 시트의 모든 값 (계산값 우선, 없으면 확정본 — 라벨은 대개 상수다) */
function sheetMap(part, sheet) {
  const out = {};
  for (const [k, v] of Object.entries(oracle[part]?.[sheet] || {})) out[k] = v;
  for (const [key, v] of Object.entries(constants)) {
    if (key.startsWith(part + '!' + sheet + '!')) out[key.slice(part.length + sheet.length + 2)] = v;
  }
  for (const [key, v] of Object.entries(computed)) {
    if (key.startsWith(part + '!' + sheet + '!')) out[key.slice(part.length + sheet.length + 2)] = v;
  }
  return out;
}

/** 표처럼 보이는가 — p16 의 `3×1 머리=["19.9"]` 같은 오검출을 걸러낸다 */
function looksLikeDataTable(t) {
  const rows = t.rows;
  if (rows.length < 2) return false;
  const w = Math.max(...rows.map((r) => r.length));
  if (w < 3) return false;
  const flat = rows.flat().map((c) => String(c).trim()).filter(Boolean);
  if (flat.length < 6) return false;
  const nums = flat.filter((c) => /^-?[0-9][0-9,.]*$/.test(c)).length;
  if (nums / flat.length < 0.4) return false;
  // 머리행에 라벨이 3개 이상 있어야 한다
  const head = rows[0].map((c) => String(c).trim()).filter(Boolean);
  return head.length >= 3;
}

const specs = [];
const report = { matched: [], partial: [], unmatched: [], noTable: [] };

for (const t of toc.pages) {
  if (!t.file || !t.sheet) continue;
  const pp = pdf.pages.find((p) => String(p.page) === String(t.page));
  const tables = (pp?.tables || []).filter(looksLikeDataTable);
  if (!tables.length) { report.noTable.push(t.page); continue; }

  const map = sheetMap(t.file, t.sheet);
  // 엑셀 셀을 (행,열) 격자로
  const byPos = new Map();
  for (const [ref, v] of Object.entries(map)) {
    const p = parseRef(ref);
    if (p) byPos.set(p.r + ':' + p.c, v);
  }
  const rowsOf = (c) => {
    const out = new Map();
    for (const [k, v] of byPos) { const [r, cc] = k.split(':').map(Number); if (cc === c) out.set(r, v); }
    return out;
  };
  const colsOf = (r) => {
    const out = new Map();
    for (const [k, v] of byPos) { const [rr, c] = k.split(':').map(Number); if (rr === r) out.set(c, v); }
    return out;
  };
  const allRows = [...new Set([...byPos.keys()].map((k) => +k.split(':')[0]))].sort((a, b) => a - b);
  const allCols = [...new Set([...byPos.keys()].map((k) => +k.split(':')[1]))].sort((a, b) => a - b);

  for (const [ti, tab] of tables.entries()) {
    /* 머리행은 첫 줄이 아닐 수 있다 — 병합 때문에 첫 줄이 비고 둘째 줄에 시점이 온다
       (p37 `["구 분","소비자물가지수","",""]`). 첫 3줄을 겹쳐 라벨이 가장 많은 조합을 쓴다. */
    const cand = [];
    for (const k of [0, 1, 2]) if (tab.rows[k]) cand.push(tab.rows[k].map((c) => String(c).trim()));
    let head = cand[0] || [];
    let bestFill = head.filter(Boolean).length;
    for (const row of cand.slice(1)) {
      if (row.filter(Boolean).length > bestFill) { head = row; bestFill = row.filter(Boolean).length; }
    }
    // 겹쳐서 채우기: 빈 칸을 다른 줄의 같은 자리로 메운다
    const merged = head.slice();
    for (const row of cand) {
      for (let k = 0; k < row.length; k++) if (!merged[k] && row[k]) merged[k] = row[k];
    }
    if (merged.filter(Boolean).length > bestFill) head = merged;
    const bodyLabels = tab.rows.slice(1).map((r) => String(r[0] ?? '').trim()).filter(Boolean);

    /* 1) 머리행 찾기 — 인쇄 머리의 라벨이 가장 많이 일치하는 엑셀 행 */
    let bestRow = null, bestHit = 0, bestColMap = null;
    for (const r of allRows) {
      if (r > 40) continue;
      const cols = colsOf(r);
      const colMap = [];
      let hit = 0;
      for (const h of head) {
        if (!h) { colMap.push(null); continue; }
        const hp = periodOf(h), hn = norm(h);
        let found = null;
        for (const [c, v] of cols) {
          const vp = periodOf(v);
          if ((hp !== null && samePeriod(vp, hp)) || (hp === null && hn && norm(v) === hn)) { found = c; break; }
        }
        colMap.push(found);
        if (found !== null) hit++;
      }
      if (hit > bestHit) { bestHit = hit; bestRow = r; bestColMap = colMap; }
    }

    /* 2) 항목 행 찾기 — 인쇄 첫 열의 라벨이 일치하는 엑셀 행 */
    let labelCol = null, bestRowHit = 0, bestRowMap = null;
    for (const c of allCols.slice(0, 4)) {
      const rows = rowsOf(c);
      const rowMap = [];
      let hit = 0;
      for (const lb of bodyLabels) {
        const ln = norm(lb);
        let found = null;
        if (ln) for (const [r, v] of rows) if (norm(v) === ln) { found = r; break; }
        rowMap.push(found);
        if (found !== null) hit++;
      }
      if (hit > bestRowHit) { bestRowHit = hit; labelCol = c; bestRowMap = rowMap; }
    }

    const headNeed = head.filter(Boolean).length;
    const rowNeed = bodyLabels.length;
    const headRate = headNeed ? bestHit / headNeed : 0;
    const rowRate = rowNeed ? bestRowHit / rowNeed : 0;
    const entry = {
      page: t.page, part: t.file, sheet: t.sheet, table: ti,
      headerRow: bestRow, labelCol,
      cols: bestColMap, rows: bestRowMap,
      printedHead: head, printedLabels: bodyLabels,
      headRate: +headRate.toFixed(3), rowRate: +rowRate.toFixed(3),
    };
    if (headRate >= 0.8 && rowRate >= 0.8) { specs.push(entry); report.matched.push(t.page); }
    else if (headRate >= 0.4 || rowRate >= 0.4) { specs.push(entry); report.partial.push(t.page); }
    else report.unmatched.push({ page: t.page, headRate: entry.headRate, rowRate: entry.rowRate, head: head.slice(0, 6) });
  }
}

const out = {
  what: '인쇄 표(PDF)의 행·열 구성을 엑셀 좌표에 맞춘 명세. 값은 계산값에서 가져온다.',
  source: 'data/pdf-pages.json (인쇄 표) × data/oracle+constants+computed (엑셀 라벨)',
  note: 'PDF 값을 그대로 쓰지 않는다 — 그러면 매월 갱신이 표에 반영되지 않는다. '
      + '라벨이 안 맞는 지면은 추측으로 채우지 않고 unmatched 로 남긴다.',
  counts: {
    matched: new Set(report.matched).size,
    partial: new Set(report.partial).size,
    unmatched: report.unmatched.length,
    noTable: report.noTable.length,
  },
  unmatched: report.unmatched,
  specs,
};
writeFileSync(join(dataDir, 'table-spec.json'), JSON.stringify(out, null, 1));

console.log('인쇄 데이터표가 있는 쪽 중');
console.log('  완전 매칭 (머리·항목 80% 이상) : ' + out.counts.matched);
console.log('  부분 매칭 (40% 이상)           : ' + out.counts.partial);
console.log('  매칭 실패                      : ' + out.counts.unmatched);
console.log('데이터표가 없는 쪽(그래프만)     : ' + out.counts.noTable);
console.log('→ data/table-spec.json (' + (readFileSync(join(dataDir, 'table-spec.json')).length / 1024).toFixed(1) + ' KB)');
if (out.unmatched.length) {
  console.log('');
  console.log('=== 매칭 실패 — 추측으로 채우지 않는다 ===');
  out.unmatched.slice(0, 20).forEach((u) => console.log('  p' + String(u.page).padEnd(5)
    + '머리 ' + u.headRate + ' · 항목 ' + u.rowRate + '  ' + JSON.stringify(u.head).slice(0, 70)));
}
