/** 2단계 스펙 §1.1 의 미결정: 발간본 통합문서 리터럴에 의존하는 칸의 목록.
 *
 *  방법 — 추이적 의존을 끝까지 따라간다.
 *    검증된 칸 X 가 읽는 셀 Y 에 대해
 *      cellmap 에 Y 의 명세가 있으면  → Y 도 계산되는 값이다. 계속 내려간다.
 *      cellmap 에 Y 가 없으면        → Y 는 사람이 손으로 넣은 상수다. **잎**이다.
 *  잎의 집합이 「매 회차 사람이 채워야 하는 입력면」이다.
 *
 *  저장소의 추적 산출물만 읽는다. 원본 엑셀은 열지 않는다. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.REPO_DIR ? process.env.REPO_DIR + '/' : './';
const OUT = process.env.OUT ?? 'reports/literal-deps.json';

const snap = JSON.parse(readFileSync(ROOT + 'data/gate-snapshot.json', 'utf8'));
const maps = {}, oracle = {};
for (const f of readdirSync(join(ROOT, 'data/cellmap'))) if (f.endsWith('.json'))
  maps[f.replace('.json', '')] = JSON.parse(readFileSync(join(ROOT, 'data/cellmap', f), 'utf8'));
for (const f of readdirSync(join(ROOT, 'data/oracle'))) if (f.endsWith('.json'))
  oracle[f.replace('.json', '')] = JSON.parse(readFileSync(join(ROOT, 'data/oracle', f), 'utf8'));

/** Expr 안의 모든 cell 참조를 찾는다. 스키마를 다 알지 않아도 되게 일반 순회한다. */
function cellRefs(node, out) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) cellRefs(x, out); return out; }
  if (node.op === 'cell' && typeof node.ref === 'string') {
    out.push({ sheet: node.sheet ?? null, ref: node.ref });
  }
  for (const v of Object.values(node)) cellRefs(v, out);
  return out;
}

const specOf = (part, sheet, ref) => maps[part]?.sheets?.[sheet]?.[ref];

/** X 의 잎을 구한다. 메모이즈 + 순환 방지. */
const leafCache = new Map();
function leavesOf(part, sheet, ref, seen = new Set()) {
  const key = `${part}!${sheet}!${ref}`;
  if (leafCache.has(key)) return leafCache.get(key);
  if (seen.has(key)) return new Set();          // 순환은 빈 집합으로 끊는다
  seen.add(key);

  const spec = specOf(part, sheet, ref);
  let result;
  if (spec === undefined) {
    result = new Set([`${part}!${sheet}!${ref}`]);   // 잎: 손으로 넣은 상수
  } else {
    result = new Set();
    for (const d of cellRefs(spec, [])) {
      const ds = d.sheet ?? sheet;
      for (const l of leavesOf(part, ds, d.ref, seen)) result.add(l);
    }
  }
  seen.delete(key);
  leafCache.set(key, result);
  return result;
}

// 검증된 칸 전부에 대해 잎을 모은다
const leafUsers = new Map();   // 잎 → 그 잎에 의존하는 검증칸 수
let withLeaf = 0, noLeaf = 0;
for (const key of Object.keys(snap.values)) {
  const j = key.lastIndexOf('!'), i = key.indexOf('!');
  const part = key.slice(0, i), sheet = key.slice(i + 1, j), ref = key.slice(j + 1);
  const ls = leavesOf(part, sheet, ref);
  if (ls.size) { withLeaf++; for (const l of ls) leafUsers.set(l, (leafUsers.get(l) || 0) + 1); }
  else noLeaf++;
}

// 잎을 시트별로 묶고, 확정본 값과 종류를 붙인다
const bySheet = new Map();
for (const [leaf, n] of leafUsers) {
  const j = leaf.lastIndexOf('!'), i = leaf.indexOf('!');
  const part = leaf.slice(0, i), sheet = leaf.slice(i + 1, j), ref = leaf.slice(j + 1);
  const v = oracle[part]?.[sheet]?.[ref];
  const k = `${part}!${sheet}`;
  if (!bySheet.has(k)) bySheet.set(k, []);
  bySheet.get(k).push({ ref, users: n, v: v === undefined ? null : v, t: typeof v });
}

console.log('=== 검증칸 ' + Object.keys(snap.values).length + '개의 추이적 의존 ===');
console.log('  잎(손입력 상수)에 의존하는 칸 : ' + withLeaf);
console.log('  의존 없는 칸                 : ' + noLeaf);
console.log('  서로 다른 잎의 수            : ' + leafUsers.size);
console.log('');
console.log('=== 잎이 있는 시트 (의존 칸 많은 순) ===');
const rows = [...bySheet.entries()]
  .map(([k, ls]) => ({ k, n: ls.length, users: ls.reduce((a, b) => a + b.users, 0), ls }))
  .sort((a, b) => b.users - a.users);
for (const r of rows.slice(0, 24)) {
  const nums = r.ls.filter((x) => x.t === 'number').length;
  const txts = r.ls.filter((x) => x.t === 'string').length;
  console.log('  ' + r.k.padEnd(28) + '잎 ' + String(r.n).padStart(4)
    + ' (수치 ' + String(nums).padStart(4) + ' · 문자 ' + String(txts).padStart(4) + ')'
    + '  의존칸 ' + String(r.users).padStart(6));
}
console.log('');
console.log('=== 잎 표본 — 가장 많이 쓰이는 20개 ===');
for (const [leaf, n] of [...leafUsers].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  const j = leaf.lastIndexOf('!'), i = leaf.indexOf('!');
  const v = oracle[leaf.slice(0, i)]?.[leaf.slice(i + 1, j)]?.[leaf.slice(j + 1)];
  console.log('  ' + String(n).padStart(6) + '칸이 의존  ' + leaf.padEnd(34) + ' = ' + JSON.stringify(v).slice(0, 46));
}

writeFileSync(OUT, JSON.stringify({
  summary: { verified: Object.keys(snap.values).length, withLeaf, noLeaf, leaves: leafUsers.size },
  sheets: rows.map((r) => ({ page: r.k, leaves: r.n, users: r.users, cells: r.ls })),
}, null, 1));
console.log('');
console.log('목록: ' + OUT);
