/** 인쇄된 표 ↔ 엑셀 좌표 매칭 → data/table-spec.json
 *
 *  사용자 결정:
 *    「PDF 에 최종적으로 들어간 표를 기준으로 ... 엑셀에 값이 있는 셀 중에는 참고를 위해서
 *     넣은 값도 많아서 굳이 책자 표에 넣지 않아도 되는 값이 많음」
 *    「원데이터가 바뀌어도, 엑셀이나 pdf 대조를 거치지 않고 바로바로 값이 해당 표 위치에
 *     자동 반영되는 것을 고려해 두고 작업할 것」
 *    「인원은 정수고 비율은 소수 첫째자리까지야」
 *
 *  이 파일이 내는 것은 **좌표뿐**이다. 값은 담지 않는다 — 화면이 `computed-values.json`
 *  (원데이터에서 계산)에서 가져오므로, 원데이터가 바뀌면 같은 좌표에 새 값이 들어간다.
 *  매칭은 **회차당 한 번**만 돌린다.
 *
 *  ── 라벨 매칭을 버린 이유 (실측) ───────────────────────────────────────────
 *  `p202`: 인쇄본 `시간당 임금 / 임 금 근로자 / 정규직 근로자` ↔ 엑셀 `시간당임금총액 /
 *          전체근로자 / 정규근로자`. **숫자는 한 칸도 안 틀리는데 글자가 다르다.**
 *          게다가 인쇄 머리가 3단 병합이다.
 *  `p117`: `p116_117` 은 두 지면을 덮는 시트라 117쪽 데이터가 아래쪽에 있다.
 *  → 라벨로는 못 맞히고 **값으로는 맞는다.** 그러니 값으로 맞춘다.
 *     머리 글자는 **인쇄본 것을 그대로 쓴다** — 책자 표현이 맞는 표현이다.
 *
 *  ── 비교 방식 ──────────────────────────────────────────────────────────
 *  인쇄본은 반올림해서 싣는다(인원=정수, 비율=소수 첫째자리). 그러므로 허용오차가 아니라
 *  **인쇄값과 같은 자리수로 반올림해 정확히 비교**한다. 자리수는 인쇄값 자신이 알려준다.
 *  단위 변환도 있으므로(엑셀 32240827 명 → 인쇄본 32,241 천명) 배율을 함께 찾는다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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

const numOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!/^-?[0-9]*\.?[0-9]+$/.test(s)) return null;
  const n = +s;
  return Number.isFinite(n) ? n : null;
};
/** 인쇄값의 소수 자리수 — 사용자: 「인원은 정수고 비율은 소수 첫째자리까지」 */
const decimalsOf = (printedText) => {
  const s = String(printedText ?? '').trim().replace(/,/g, '');
  const m = /\.([0-9]+)$/.exec(s);
  return m ? m[1].length : 0;
};
const roundTo = (v, d) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };

const SCALES = [1, 1000, 0.001, 100, 0.01, 10, 0.1];

function looksLikeDataTable(t) {
  const rows = t.rows;
  if (rows.length < 2) return false;
  if (Math.max(...rows.map((r) => r.length)) < 3) return false;
  const flat = rows.flat().map((c) => String(c).trim()).filter(Boolean);
  if (flat.length < 6) return false;
  return flat.filter((c) => /^-?[0-9][0-9,.]*$/.test(c)).length / flat.length >= 0.4;
}

function sheetCells(part, sheet) {
  const pre = part + '!' + sheet + '!';
  const out = [];
  const seen = new Set();
  const take = (src) => {
    for (const [k, v] of Object.entries(src)) {
      if (!k.startsWith(pre)) continue;
      const ref = k.slice(pre.length);
      const p = parseRef(ref);
      if (!p) continue;
      const key = p.r + ':' + p.c;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ r: p.r, c: p.c, v });
    }
  };
  take(computed);          // 계산값 우선
  take(constants);
  return out;
}

/** 한 배율에서, 인쇄 셀 값과 같아지는 엑셀 좌표를 찾기 위한 색인 */
function buildIndex(cells, scale) {
  // 자리수별 색인 — 인쇄값의 자리수로 반올림한 키
  const idx = new Map();     // d → Map(값 → [{r,c}])
  for (const d of [0, 1, 2]) idx.set(d, new Map());
  for (const cell of cells) {
    const n = numOf(cell.v);
    if (n === null) continue;
    const scaled = n * scale;
    for (const d of [0, 1, 2]) {
      const key = roundTo(scaled, d);
      const m = idx.get(d);
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(cell);
    }
  }
  return idx;
}

/** 인쇄 표 하나를 엑셀 좌표에 맞춘다 — **값 투표**로.
 *  각 인쇄 셀이 「이 행은 엑셀 r, 이 열은 엑셀 c」에 표를 던지고, 최다 득표로 정한다.
 *  띄엄띄엄 매핑(p8 의 10년 간격)도 이 방식이면 잡힌다. */
function alignByValue(tab, cells) {
  const body = tab.rows;
  let best = null;

  for (const scale of SCALES) {
    const idx = buildIndex(cells, scale);

    // (인쇄 행 i) → 엑셀 행 득표,  (인쇄 열 j) → 엑셀 열 득표
    const rowVotes = new Map(), colVotes = new Map();
    const cand = [];
    for (let i = 0; i < body.length; i++) {
      for (let j = 0; j < body[i].length; j++) {
        const txt = body[i][j];
        const pv = numOf(txt);
        if (pv === null) continue;
        const d = decimalsOf(txt);
        const hits = idx.get(d)?.get(roundTo(pv, d)) || [];
        if (!hits.length || hits.length > 40) continue;      // 너무 흔한 값은 정보가 없다
        cand.push({ i, j, hits });
        const w = 1 / hits.length;                            // 드문 값일수록 표가 무겁다
        for (const h of hits) {
          const rk = i + '>' + h.r, ck = j + '>' + h.c;
          rowVotes.set(rk, (rowVotes.get(rk) || 0) + w);
          colVotes.set(ck, (colVotes.get(ck) || 0) + w);
        }
      }
    }
    if (!cand.length) continue;

    const pick = (votes, n) => {
      const byIdx = new Map();
      for (const [k, w] of votes) {
        const [a, b] = k.split('>').map(Number);
        if (!byIdx.has(a)) byIdx.set(a, []);
        byIdx.get(a).push({ t: b, w });
      }
      const out = new Array(n).fill(null);
      const used = new Set();
      // 득표가 확실한 것부터 배정하고, 같은 엑셀 행/열을 두 번 쓰지 않는다
      const order = [...byIdx.entries()].sort((a, b) =>
        Math.max(...b[1].map((x) => x.w)) - Math.max(...a[1].map((x) => x.w)));
      for (const [a, list] of order) {
        list.sort((x, y) => y.w - x.w);
        for (const x of list) { if (!used.has(x.t)) { out[a] = x.t; used.add(x.t); break; } }
      }
      return out;
    };
    const rowMap = pick(rowVotes, body.length);
    const colMap = pick(colVotes, Math.max(...body.map((r) => r.length)));

    /* 단조성은 **필수가 아니라 선호**다.
       OECD 부록은 인쇄 표가 국가 고정 순서인데 엑셀은 **값 크기로 정렬**돼 있어,
       필수로 걸면 p214 가 통째로 거부된다. 실제 관문은 값 일치율이므로 그쪽에 맡긴다. */
    const mono = (arr) => {
      const seq = arr.filter((x) => x !== null);
      for (let k = 1; k < seq.length; k++) if (seq[k] <= seq[k - 1]) return false;
      return true;
    };
    const monoBonus = (mono(rowMap) ? 0.5 : 0) + (mono(colMap) ? 0.5 : 0);

    // 검증 — 매핑된 자리의 값이 인쇄값과 같은가
    const at = new Map();
    for (const cell of cells) at.set(cell.r + ':' + cell.c, cell.v);
    let good = 0, seen = 0;
    for (let i = 0; i < body.length; i++) {
      for (let j = 0; j < body[i].length; j++) {
        const pv = numOf(body[i][j]);
        if (pv === null || rowMap[i] === null || colMap[j] === null) continue;
        const got = numOf(at.get(rowMap[i] + ':' + colMap[j]));
        if (got === null) { seen++; continue; }
        seen++;
        if (roundTo(got * scale, decimalsOf(body[i][j])) === roundTo(pv, decimalsOf(body[i][j]))) good++;
      }
    }
    if (!seen) continue;
    const rate = good / seen;
    const score = rate * 100 + good + monoBonus;
    if (!best || score > best.score) {
      best = { score, scale, rowMap, colMap, valRate: +rate.toFixed(3), valPairs: seen, matched: good };
    }
  }
  return best;
}

const specs = [];
const report = { ok: [], weak: [], fail: [], noTable: [] };

for (const t of toc.pages) {
  if (!t.file || !t.sheet) continue;
  const pp = pdf.pages.find((p) => String(p.page) === String(t.page));
  const tables = (pp?.tables || []).filter(looksLikeDataTable);
  if (!tables.length) { report.noTable.push(t.page); continue; }

  const cells = sheetCells(t.file, t.sheet);
  if (!cells.length) { report.fail.push({ page: t.page, why: '엑셀 시트에 값이 없다' }); continue; }

  for (const [ti, tab] of tables.entries()) {
    const a = alignByValue(tab, cells);
    if (!a) { report.fail.push({ page: t.page, why: '값으로 맞출 수 없다' }); continue; }

    /* 인쇄 표의 **머리 줄**과 **항목 열**은 값이 없는 줄/열이다 — 매핑에서 null 인 자리.
       표시할 라벨은 **인쇄본 것을 그대로** 쓴다(책자 표현이 맞는 표현이다). */
    const bodyRowIdx = a.rowMap.map((r, i) => (r !== null ? i : -1)).filter((i) => i >= 0);
    const bodyColIdx = a.colMap.map((c, j) => (c !== null ? j : -1)).filter((j) => j >= 0);
    /* 머리는 본문 첫 행 **위의 모든 줄**을 겹쳐서 만든다 — p202 는 3단 머리라
       바로 윗줄만 보면 `시간당 임금` 층이 빠진다. */
    const headRowIdx = bodyRowIdx.length ? Math.max(0, bodyRowIdx[0] - 1) : 0;
    const headOf = (j) => {
      const parts = [];
      for (let k = 0; k < bodyRowIdx[0]; k++) {
        const t2 = String(tab.rows[k]?.[j] ?? '').trim();
        if (t2 && !parts.includes(t2)) parts.push(t2);
      }
      return parts.join(' ');
    };
    const labelColIdx = bodyColIdx.length ? Math.max(0, bodyColIdx[0] - 1) : 0;

    const entry = {
      page: t.page, part: t.file, sheet: t.sheet, table: ti,
      scale: a.scale, valRate: a.valRate, valPairs: a.valPairs, matched: a.matched,
      // 표시용: 인쇄본 머리/항목 라벨
      head: bodyColIdx.map(headOf),
      labels: bodyRowIdx.map((i) => String(tab.rows[i]?.[labelColIdx] ?? '').trim()),
      // 좌표: 표의 (행,열) → 엑셀 (r,c).  값은 담지 않는다.
      rows: bodyRowIdx.map((i) => a.rowMap[i]),
      cols: bodyColIdx.map((j) => a.colMap[j]),
      /* 표시 자리수 — 사용자: 「인원은 정수고 비율은 소수 첫째자리까지」.
         인쇄값 자신이 알려주므로 열마다 인쇄본에서 가장 흔한 자리수를 쓴다.
         배율을 곱하면 부동소수 찌꺼기가 남는데(20525.60000000001) 이것으로 잘린다. */
      decimals: bodyColIdx.map((j) => {
        const counts = {};
        for (const i of bodyRowIdx) {
          const txt = tab.rows[i]?.[j];
          if (numOf(txt) === null) continue;
          const d = decimalsOf(txt);
          counts[d] = (counts[d] || 0) + 1;
        }
        const e = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
        return e ? +e[0] : 0;
      }),
      corner: String(tab.rows[headRowIdx]?.[labelColIdx] ?? '구 분').trim(),
    };
    if (a.valRate >= 0.9 && a.matched >= 4) { specs.push(entry); report.ok.push(t.page); }
    else if (a.valRate >= 0.7 && a.matched >= 3) { specs.push(entry); report.weak.push(t.page); }
    else report.fail.push({ page: t.page, valRate: a.valRate, pairs: a.valPairs, matched: a.matched, scale: a.scale });
  }
}

const out = {
  what: '인쇄 표의 행·열을 엑셀 **좌표**로 옮긴 명세. 값은 담지 않는다.',
  source: 'data/pdf-pages.json × data/computed-values.json+constants.json',
  note: '값 투표로 맞춘다 — 라벨은 쓰지 않는다(인쇄본과 엑셀의 글자가 다르다). '
      + '비교는 인쇄값과 같은 자리수로 반올림해 정확히 한다(인원=정수, 비율=소수 첫째자리). '
      + '표시 라벨은 인쇄본 것을 쓴다. 값은 화면이 computed-values.json 에서 가져오므로 '
      + '원데이터가 바뀌면 같은 좌표에 새 값이 들어간다.',
  counts: { ok: new Set(report.ok).size, weak: new Set(report.weak).size, fail: report.fail.length, noTable: report.noTable.length },
  fail: report.fail,
  specs,
};
writeFileSync(join(dataDir, 'table-spec.json'), JSON.stringify(out, null, 1));

console.log('인쇄 데이터표가 있는 쪽');
console.log('  값 일치 90%+ (채택)   : ' + out.counts.ok);
console.log('  값 일치 70~90% (약함) : ' + out.counts.weak);
console.log('  실패                  : ' + out.counts.fail);
console.log('데이터표 없는 쪽        : ' + out.counts.noTable);
const sc = {};
for (const s of specs) sc[s.scale] = (sc[s.scale] || 0) + 1;
console.log('배율 분포: ' + Object.entries(sc).map(([k, v]) => '×' + k + ':' + v).join(' '));
console.log('→ data/table-spec.json (' + (readFileSync(join(dataDir, 'table-spec.json')).length / 1024).toFixed(1) + ' KB)');
if (out.fail.length) {
  console.log('');
  console.log('=== 실패 (추측으로 채우지 않는다) ===');
  out.fail.slice(0, 20).forEach((u) => console.log('  p' + String(u.page).padEnd(6)
    + (u.why ?? ('값 ' + u.valRate + ' · 맞은 칸 ' + u.matched + '/' + u.pairs + ' · 배율 ×' + u.scale))));
}
