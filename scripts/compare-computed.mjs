/** 계산 경로의 값이 관문 스냅샷과 같은가 — **진단**이다 (관문이 아니다).
 *
 *  두 경로가 있고 둘은 다른 것을 증명한다:
 *    판정 경로(`scripts/verify-all.ts`)  cellmap + 확정본 + obs.sqlite
 *        → 「인쇄된 값을 재현한다」. 관문이다.
 *    계산 경로(`scripts/compute-values.mjs`)  cellmap + constants + obs.sqlite
 *        → 「확정본 없이 원데이터만으로 같은 값이 나온다」. 매월 갱신의 실체다.
 *
 *  이 스크립트는 후자의 산출물(`data/computed-values.json`)을 관문이 통과한 순간의
 *  계산값(`data/gate-snapshot.json`)과 좌표째로 맞춰 본다. 스냅샷은 확정본이 아니다 —
 *  **그때 우리가 계산한 값**이고, 그래서 「확정본을 읽지 않아도 같은 값이 나오는가」를
 *  묻는 데 쓸 수 있다.
 *
 *  실행: node scripts/compare-computed.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sameValue } from '../src/verify/compare.ts';

const ROOT = process.env.REPO_DIR ?? '.';
const dataDir = join(ROOT, 'data');

const snapFile = join(dataDir, 'gate-snapshot.json');
const compFile = join(dataDir, 'computed-values.json');
for (const f of [snapFile, compFile]) {
  if (!existsSync(f)) {
    console.error(`${f} 가 없다 — 먼저 npm run build:snapshot · npm run compute 를 돌린다.`);
    process.exit(1);
  }
}
const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
const comp = JSON.parse(readFileSync(compFile, 'utf8'));

let same = 0;
const diff = [];      // 값이 다르다
const missing = [];   // 계산 경로가 값을 내지 못했다
for (const [key, want] of Object.entries(snap.values)) {
  const got = comp.values[key];
  if (got === undefined) { missing.push({ key, want }); continue; }
  // 인자 순서가 방향이다 — sameValue(기준, 계산값). 구분자 완화가 비대칭이라 그렇다.
  if (sameValue(want, got)) same++;
  else diff.push({ key, want, got });
}

const total = Object.keys(snap.values).length;
console.log('스냅샷 %d칸 · 일치 %d (%s%%) · 다름 %d · 계산 못함 %d',
  total, same, (same / total * 100).toFixed(2), diff.length, missing.length);
console.log('스냅샷 앵커 %s · 계산 앵커 %s', snap.anchor, comp.anchor);

/** 남은 차이를 좌표로 묶어 보여준다 — 「어디가」와 「왜」를 보고서에 그대로 옮기려면
    건수만으로는 부족하다. */
function group(rows) {
  const by = new Map();
  for (const r of rows) {
    const [part, sheet] = r.key.split('!');
    const k = part + '!' + sheet;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return [...by].sort((a, b) => b[1].length - a[1].length);
}

for (const [label, rows] of [['다름', diff], ['계산 못함', missing]]) {
  if (!rows.length) continue;
  console.log('\n== %s %d칸 — 지면별 ==', label, rows.length);
  for (const [k, rs] of group(rows).slice(0, 20)) {
    const s = rs[0];
    console.log('  ' + String(rs.length).padStart(5) + '  ' + k.padEnd(24)
      + '  예: ' + s.key.split('!').slice(2).join('!')
      + ' 스냅샷 ' + JSON.stringify(s.want)
      + (s.got === undefined ? '' : ' / 계산 ' + JSON.stringify(s.got)));
  }
  const more = group(rows).length - 20;
  if (more > 0) console.log('  … 지면 ' + more + '개 더');
}

// 계산 경로가 스냅샷에 없는 칸까지 낸 것(부록 presentation 등)은 차이가 아니다 —
// 관문의 대조 대상이 아니어서 스냅샷에 없을 뿐이다. 몇 칸인지만 알려 준다.
const extra = Object.keys(comp.values).filter((k) => !(k in snap.values)).length;
console.log('\n계산 경로가 낸 값 %d칸 (스냅샷 밖 %d칸 — 부록 표현 칸·보조시트다)',
  Object.keys(comp.values).length, extra);
