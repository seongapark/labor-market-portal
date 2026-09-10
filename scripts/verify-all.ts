import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, loadAll } from '../src/db/load.ts';
import { verifyPart, type CellResult, type FormulaDump, type OracleDump } from '../src/verify/compare.ts';
import type { Headers } from '../src/types.ts';

export type Summary = {
  total: number;
  comparable: number;
  rate: number;
  gatePassed: boolean;
  byVerdict: Record<string, number>;
  byPart: Record<string, Record<string, number>>;
};

export function summarize(rows: CellResult[]): Summary {
  const byVerdict: Record<string, number> = {};
  const byPart: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    byPart[r.part] ??= {};
    byPart[r.part][r.verdict] = (byPart[r.part][r.verdict] ?? 0) + 1;
  }
  const m = byVerdict.match ?? 0;
  const mm = byVerdict.mismatch ?? 0;
  const er = byVerdict.error ?? 0;
  const comparable = m + mm + er;
  return {
    total: rows.length,
    comparable,
    rate: comparable ? m / comparable : 0,
    gatePassed: mm === 0 && er === 0,
    byVerdict, byPart,
  };
}

function main() {
  const YEAR = process.env.BASE_YEAR ?? '2025';
  const dataDir = 'data';
  const headers = JSON.parse(
    readFileSync(join(dataDir, 'raw', 'headers.json'), 'utf8')) as Headers;

  const dbFile = join(dataDir, 'obs.sqlite');
  const fresh = !existsSync(dbFile);
  const db = openDb(dbFile);
  if (fresh) {
    console.log('적재:', loadAll(db, join(dataDir, 'raw')));
  }

  const rows: CellResult[] = [];
  for (const f of readdirSync(join(dataDir, 'formulas'))) {
    if (!f.endsWith('.json')) continue;
    const part = basename(f, '.json');
    const formulas = JSON.parse(
      readFileSync(join(dataDir, 'formulas', f), 'utf8')) as FormulaDump;
    const op = join(dataDir, 'oracle', f);
    if (!existsSync(op)) { console.log('확정본 없음, 건너뜀:', part); continue; }
    const oracle = JSON.parse(readFileSync(op, 'utf8')) as OracleDump;
    const r = verifyPart(part, formulas, oracle, db, headers, YEAR);
    rows.push(...r);
    const s = summarize(r);
    console.log('  %-20s 대조 %5d · 일치 %5d (%s%%)', part, s.comparable,
      s.byVerdict.match ?? 0, (s.rate * 100).toFixed(2));
  }

  const s = summarize(rows);
  mkdirSync('reports', { recursive: true });

  const lines: string[] = [
    '# 전건 대조 리포트',
    '',
    `기준연도 ${YEAR} · 생성 ${new Date().toISOString().slice(0, 10)}`,
    '',
    `- 수식 좌표 **${s.total}**`,
    `- 대조 가능 **${s.comparable}** (확정본에 값이 있고 파싱된 것)`,
    `- 일치 **${s.byVerdict.match ?? 0}** · 불일치 **${s.byVerdict.mismatch ?? 0}** · 실행오류 **${s.byVerdict.error ?? 0}**`,
    `- 파싱 못함 ${s.byVerdict.unsupported ?? 0} · 확정본에 값 없음 ${s.byVerdict['no-oracle'] ?? 0}`,
    `- 일치율 **${(s.rate * 100).toFixed(3)}%**`,
    '',
    `## 관문: ${s.gatePassed ? '통과 (불일치 0 · 오류 0)' : '미통과'}`,
    '',
    '## 파트별',
    '',
    '| 파트 | 대조 | 일치 | 불일치 | 오류 | 파싱못함 | 값없음 | 일치율 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const part of Object.keys(s.byPart).sort()) {
    const b = s.byPart[part];
    const comp = (b.match ?? 0) + (b.mismatch ?? 0) + (b.error ?? 0);
    lines.push(`| ${part} | ${comp} | ${b.match ?? 0} | ${b.mismatch ?? 0} | ${b.error ?? 0} | ${b.unsupported ?? 0} | ${b['no-oracle'] ?? 0} | ${comp ? ((b.match ?? 0) / comp * 100).toFixed(2) : '—'}% |`);
  }
  writeFileSync(join('reports', 'verify-summary.md'), lines.join('\n') + '\n');

  const bad = rows.filter((r) => r.verdict !== 'match');
  writeFileSync(join('reports', 'verify-detail.jsonl'),
    bad.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // 파싱 실패 이유별 집계 — 다음에 무엇을 지원해야 하는지 알려준다
  const reasons = new Map<string, { n: number; sample: CellResult }>();
  for (const r of rows) {
    if (r.verdict !== 'unsupported' && r.verdict !== 'error') continue;
    const key = (r.reason ?? '(이유없음)').slice(0, 90);
    const cur = reasons.get(key);
    if (cur) cur.n++;
    else reasons.set(key, { n: 1, sample: r });
  }
  const rl = ['# 파싱·실행 실패 이유', '', '| 건수 | 이유 | 대표 좌표 |', '|---|---|---|'];
  for (const [key, v] of [...reasons].sort((a, b) => b[1].n - a[1].n)) {
    rl.push(`| ${v.n} | ${key.replace(/\|/g, '\\|')} | ${v.sample.part}!${v.sample.sheet}!${v.sample.ref} |`);
  }
  writeFileSync(join('reports', 'unsupported-reasons.md'), rl.join('\n') + '\n');

  console.log('\n일치율 %s%% · 관문 %s',
    (s.rate * 100).toFixed(3), s.gatePassed ? '통과' : '미통과');
  console.log('리포트: reports/verify-summary.md · verify-detail.jsonl · unsupported-reasons.md');
  process.exit(s.gatePassed ? 0 : 1);
}

// Windows 에서 구분자·대소문자가 어긋날 수 있어 경로 문자열 비교를 쓰지 않는다.
// 어긋나면 test 가 summarize 를 import 하는 순간 main() 이 돌아 data/ 를 찾다 죽는다.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
