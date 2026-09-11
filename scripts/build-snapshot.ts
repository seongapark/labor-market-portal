/** Task 9 단위 11 (물화): 관문 통과 시점의 계산값 → `data/gate-snapshot.json`
 *
 * **왜 필요한가:** 이것이 없으면 나중에 값이 달라졌을 때 「번역 회귀」인지 「원자료
 * 개정」인지 구분할 수 없다. 세종 3칸(단위 8b·9)이 정확히 그 모호함이었다 — 관문이
 * 통과한 순간 우리가 무엇을 계산했는지 적어 두면, 다음부터는 원인을 지목할 수 있다.
 *
 * **cellmap 경로로만 돌린다** — 수식 파일을 읽지 않는다. 그리고 **관문이 통과하지
 * 않으면 쓰지 않는다**: 실패한 관문의 스냅샷은 기준이 될 수 없다.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, dataFingerprint } from '../src/db/load.ts';
import { verifyCellMap, applyKnownDivergences,
         type CellResult, type OracleDump, type KnownDivergence } from '../src/verify/compare.ts';
import { summarize } from './verify-all.ts';
import type { CellMap } from '../src/types.ts';

const dataDir = 'data';
const anchor = Number(process.env.BASE_YEAR ?? '2025');
const db = openDb(join(dataDir, 'obs.sqlite'));
const known = existsSync(join(dataDir, 'known-divergences.json'))
  ? (JSON.parse(readFileSync(join(dataDir, 'known-divergences.json'), 'utf8')) as KnownDivergence[])
  : [];

const rows: CellResult[] = [];
for (const f of readdirSync(join(dataDir, 'cellmap'))) {
  if (!f.endsWith('.json')) continue;
  const part = basename(f, '.json');
  const map = JSON.parse(readFileSync(join(dataDir, 'cellmap', f), 'utf8')) as CellMap;
  const op = join(dataDir, 'oracle', f);
  if (!existsSync(op)) { console.log('확정본 없음, 건너뜀:', part); continue; }
  const oracle = JSON.parse(readFileSync(op, 'utf8')) as OracleDump;
  rows.push(...applyKnownDivergences(
    verifyCellMap(part, map, oracle, db, anchor), known.filter((k) => k.part === part)).rows);
}
const stale = applyKnownDivergences(rows, known).stale;
const s = summarize(rows, stale.length);

if (!s.gatePassed) {
  console.error('관문이 통과하지 않았다 — 스냅샷을 쓰지 않는다.');
  console.error(JSON.stringify(s.byVerdict));
  for (const x of stale) console.error('묵은 면제:', x.why);
  process.exit(1);
}

// 대조 대상(match·mismatch·error·known-divergence)의 계산값을 전부 담는다.
const COMPARED = new Set(['match', 'mismatch', 'error', 'known-divergence']);
const values: Record<string, number | string | null> = {};
for (const r of rows) {
  if (!COMPARED.has(r.verdict)) continue;
  values[`${r.part}!${r.sheet}!${r.ref}`] = r.got;
}

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch { /* git 이 없으면 unknown 으로 남긴다 — 거짓말하지 않는다 */ }

const out = {
  what: '관문이 통과한 순간의 계산값 전체. 나중에 값이 달라졌을 때 「번역 회귀」와 '
    + '「원자료 개정」을 구분하는 기준이다. 확정본(인쇄된 값)과는 다른 것이다.',
  anchor,
  commit,                       // 생성 시점의 HEAD (이 파일을 담는 커밋의 부모다)
  generated_at: new Date().toISOString(),
  source: 'data/cellmap/*.json + data/oracle/*.json + data/obs.sqlite (수식 파일을 읽지 않는다)',
  // 전체 리뷰 F11: **자료 쪽 지문.** obs.sqlite 와 data/raw 는 추적되지 않으므로, 이것이
  // 없으면 나중에 값이 달라졌을 때 「번역 회귀」와 「자료 개정」을 구별할 수 없다.
  // 파일 해시는 재수집마다 달라져 쓸모없다 — 표별 행 수와 최대 시점(내용 지문)을 담는다.
  data: dataFingerprint(db),
  counts: s.byVerdict,
  comparable: s.comparable,
  rate: s.rate,
  values,
};
const file = join(dataDir, 'gate-snapshot.json');
writeFileSync(file, JSON.stringify(out, null, 0) + '\n');
console.log('앵커 %d · 커밋 %s · 값 %d개 · %dKB',
  anchor, commit.slice(0, 8), Object.keys(values).length, Math.round(statSync(file).size / 1024));
console.log('나온 곳:', file);
