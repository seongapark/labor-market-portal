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

// 이유 문자열을 근본원인으로 묶는다. compare.ts/parse.ts/execute.ts 의 에러 메시지는
// 좌표·JSON 토큰 덤프·파일명 같은 "꼬리"를 이유 안에 그대로 박아 넣기 때문에, 정확히
// 같은 문자열로만 묶으면 하나의 근본원인이 좌표 수만큼 count-1 행으로 쪼개져 순위표
// 맨 아래로 흩어진다. 반대로 "못 다루는 함수: INDEX" 처럼 꼬리 자체가 요점(함수명)인
// 경우는 쪼개져야 옳다 — INDEX 와 VLOOKUP 을 같은 행으로 묶으면 Task 9 가 무엇부터
// 구현해야 하는지 알 수 없게 된다. 그래서 규칙은:
//   1. 끝에 붙은 "(...)" 부가정보(예: "(C:C)")는 순서(ordinal)가 이미 문장에 있으므로 지운다.
//   2. ": <꼬리>" 형태에서 꼬리가 숫자·공백·따옴표·괄호 중 하나라도 품으면(=좌표,
//      JSON 덤프, "src 'etc' 는 ..." 같은 문장) 노이즈로 보고 지운다. 꼬리가 순수한
//      짧은 식별자(예: "INDEX", "str")면 그게 메시지의 요점이므로 남긴다.
//   3. 남은 숫자(열 순번 등)는 # 로 뭉갠다.
// 일반 분류기를 만들지 않는다 — 위 세 규칙이 전부다.
export function reasonKey(reason: string): string {
  let key = reason.replace(/\s*\([^()]*\)\s*$/, '');
  const m = key.match(/^(.*?):\s(.+)$/s);
  if (m && /[\d\s"'[\]{}]/.test(m[2])) key = m[1];
  key = key.replace(/\d+/g, '#');
  return key.trim();
}

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
    const partCol = part.padEnd(20);
    const compCol = String(s.comparable).padStart(5);
    const matchCol = String(s.byVerdict.match ?? 0).padStart(5);
    console.log(`  ${partCol} 대조 ${compCol} · 일치 ${matchCol} (${(s.rate * 100).toFixed(2)}%)`);
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

  // 파싱 실패 이유별 집계 — 다음에 무엇을 지원해야 하는지 알려준다.
  // 근본원인(reasonKey)으로 묶는다 — 정확한 문자열로만 묶으면 좌표·JSON 덤프가
  // 박힌 이유 하나가 count-1 행 수백 개로 쪼개져 순위표 아래로 흩어진다.
  const reasons = new Map<string, { n: number; sample: CellResult }>();
  for (const r of rows) {
    if (r.verdict !== 'unsupported' && r.verdict !== 'error') continue;
    const key = reasonKey(r.reason ?? '(이유없음)');
    const cur = reasons.get(key);
    if (cur) cur.n++;
    else reasons.set(key, { n: 1, sample: r });
  }
  const rl = ['# 파싱·실행 실패 이유', '', '근본원인(reasonKey) 기준으로 묶었다 — 좌표·JSON 덤프 등 변동 꼬리는 지우고, 함수명처럼 꼬리 자체가 요점인 경우는 남긴다.', '', '| 건수 | 근본원인 | 대표 이유 | 대표 좌표 |', '|---|---|---|---|'];
  for (const [key, v] of [...reasons].sort((a, b) => b[1].n - a[1].n)) {
    const full = (v.sample.reason ?? '(이유없음)').replace(/\|/g, '\\|');
    rl.push(`| ${v.n} | ${key.replace(/\|/g, '\\|')} | ${full} | ${v.sample.part}!${v.sample.sheet}!${v.sample.ref} |`);
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
