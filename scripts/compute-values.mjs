/** 계산 전용 진입점 — 확정본 없이 값을 낸다.
 *
 *  사용자 결정: 「업데이트는 PDF나 엑셀 의존적이지 않도록, 원데이터에서 바로 뽑아올수
 *  있도록 파이프라인 설계. (그래프 또한 그래야함)」
 *
 *  입력은 셋뿐이다:
 *    data/cellmap/*.json    셀별 질의 명세 (명세 · 동결)
 *    data/constants.json    수식이 없는 칸의 값 (명세 · 동결)
 *    data/obs.sqlite        원데이터 (KOSIS·OECD API — 매월 갱신)
 *
 *  `verifyCellMap` 은 `grids = oracle` 로 두고 평가한다. 확정본에는 **계산된 값까지** 다
 *  들어 있어서 그냥 됐던 것이다. 상수만으로 시작하면 셀이 다른 계산 셀을 참조할 때 값이
 *  없으므로, **계산 결과를 격자에 되먹이며 재귀 평가**한다(`anchorCell` 과 같은 방식).
 *
 *  실행: node scripts/compute-values.mjs
 *  산출: data/computed-values.json   (좌표 → 값)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execute } from '../src/query/execute.ts';
import { makeAnchorCtxFromMap } from '../src/query/anchor.ts';

const colStr = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };

const ROOT = process.env.REPO_DIR ?? '.';
const dataDir = join(ROOT, 'data');
const ANCHOR = Number(process.env.ANCHOR ?? 2025);

const maps = {};
for (const f of readdirSync(join(dataDir, 'cellmap'))) {
  if (f.endsWith('.json')) maps[f.replace('.json', '')] = JSON.parse(readFileSync(join(dataDir, 'cellmap', f), 'utf8'));
}
const constants = JSON.parse(readFileSync(join(dataDir, 'constants.json'), 'utf8')).values;
const db = new DatabaseSync(join(dataDir, 'obs.sqlite'), { readOnly: true });

/* 상수를 part 별 격자로 나눈다 */
const constGrids = {};
for (const [key, v] of Object.entries(constants)) {
  const j = key.lastIndexOf('!'), i = key.indexOf('!');
  const part = key.slice(0, i), sheet = key.slice(i + 1, j), ref = key.slice(j + 1);
  ((constGrids[part] = constGrids[part] || {})[sheet] = constGrids[part][sheet] || {})[ref] = v;
}

const values = {};
const stats = { computed: 0, presentation: 0, failed: 0, nonExpr: 0, passes: 0 };
const reasons = {};

/** Task 9 단위 13: 이 명세로 계산할 식이 있는가.
 *
 *  `kind:'expr'` 이면 그 식이고, `kind:'presentation'` 이면 **함께 실린 계산용 식**이다.
 *  OECD 부록(p214~p240)은 값 크기로 정렬된 표이고, 그 정렬 수식(시트 수식어 붙은
 *  INDEX/MATCH · RANK · COUNTIF · ROW)이 presentation 으로 갈려 있다. 정렬 결과를
 *  상수로 동결하면 원데이터가 바뀌어도 순서가 얼어붙으므로 **계산해야 한다**.
 *  관문은 같은 명세의 `e` 를 보지 않는다(`kind !== 'expr'` 로 빠진다) — presentation
 *  3,364칸은 계속 대조 분모 밖이다. 두 경로가 갈리는 지점이 이 한 줄이다. */
const exprOf = (spec) =>
  spec.kind === 'expr' ? spec.e : (spec.kind === 'presentation' ? spec.e : undefined);

/* 고정점 반복으로 계산한다.
 *
 * 처음에는 참조를 재귀로 미리 채웠는데, OECD 부록의 정렬 보조시트(`_정렬기준`·`_13개국`)가
 * **자기 범위를 참조**해서 순환 3,583건이 났다. 순서를 맞추려 애쓰는 대신 값이 바뀌지
 * 않을 때까지 전체를 다시 계산한다 — 위상정렬이 필요 없고 정렬 보조시트도 수렴한다. */
const MAX_PASS = 12;
for (const [part, m] of Object.entries(maps)) {
  const grids = {};
  for (const [sheet, cells] of Object.entries(constGrids[part] || {})) grids[sheet] = { ...cells };
  const anchorCtx = makeAnchorCtxFromMap(m, ANCHOR, ANCHOR);

  let pass = 0, changed = 1;
  const fail = new Map();
  while (changed && pass < MAX_PASS) {
    changed = 0;
    pass++;
    for (const [sheet, cells] of Object.entries(m.sheets)) {
      for (const [ref, spec] of Object.entries(cells)) {
        const e = exprOf(spec);
        if (!e) continue;
        let v;
        try {
          // `ref` 는 `ROW()`(인자 없는 자기 행)의 유일한 출처다 — 부록의 정렬 수식
          // 1,386건이 `MATCH(ROW()-5, …)` 로 자기 행을 정렬 순번으로 쓴다.
          v = execute(e, { db, grids, sheet, ref, anchor: anchorCtx });
        } catch (err) {
          fail.set(sheet + '!' + ref, String(err && err.message ? err.message : err).slice(0, 90));
          continue;
        }
        fail.delete(sheet + '!' + ref);
        const g = (grids[sheet] = grids[sheet] || {});
        if (g[ref] !== v) { g[ref] = v; changed++; }
      }
    }
  }
  stats.passes = Math.max(stats.passes, pass);

  for (const [sheet, cells] of Object.entries(m.sheets)) {
    for (const [ref, spec] of Object.entries(cells)) {
      if (!exprOf(spec)) { stats.nonExpr++; continue; }
      const v = grids[sheet]?.[ref];
      if (v === undefined || v === null) continue;
      values[`${part}!${sheet}!${ref}`] = v;
      stats.computed++;
      if (spec.kind === 'presentation') stats.presentation++;
    }
  }
  for (const r of fail.values()) { stats.failed++; reasons[r] = (reasons[r] || 0) + 1; }
}

/** 명세 안의 cell 참조를 찾는다 (스키마를 다 알지 않아도 되게 일반 순회) */
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

const out = {
  what: '원데이터에서 계산한 값. 확정본을 읽지 않는다.',
  inputs: ['data/cellmap/*.json', 'data/constants.json', 'data/obs.sqlite'],
  anchor: ANCHOR,
  generated_at: new Date().toISOString(),
  counts: stats,
  values,
};
writeFileSync(join(dataDir, 'computed-values.json'), JSON.stringify(out));
console.log('계산 ' + stats.computed + '(그 중 정렬·표시 ' + stats.presentation + ')'
  + ' · 실패 ' + stats.failed
  + ' · 계산할 식 없음 ' + stats.nonExpr + ' · 최대 반복 ' + stats.passes + '회');
if (Object.keys(reasons).length) {
  console.log('실패 사유 상위:');
  Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .forEach(([r, n]) => console.log('  ' + String(n).padStart(5) + '  ' + r));
}
console.log('→ data/computed-values.json ('
  + (readFileSync(join(dataDir, 'computed-values.json')).length / 1024 / 1024).toFixed(2) + ' MB)');
