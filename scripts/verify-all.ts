import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, loadAll } from '../src/db/load.ts';
import { verifyPart, verifyCellMap, applyKnownDivergences,
         type CellResult, type FormulaDump, type OracleDump,
         type KnownDivergence, type StaleDivergence } from '../src/verify/compare.ts';
import type { CellMap, Headers } from '../src/types.ts';

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

/** Task 9 단위 9: `stale` 은 더 이상 유효하지 않은 면제의 개수다. **관문을 실패시킨다** —
    면제 목록이 조용히 쌓여 관문을 무력화하는 것을 막는 유일한 장치다. */
export function summarize(rows: CellResult[], stale = 0): Summary {
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
  const un = byVerdict.unsupported ?? 0;
  // presentation(같은시트 INDEX/MATCH/RANK 정렬)은 대조가 아니므로 분모에 넣지 않는다 —
  // 부록·서식 칸이라 확정본에 대해 **애초에 주장할 것이 없다.**
  // Task 9 단위 9 (판정 2026-09-11): known-divergence 는 **다르다 — 분모에 남긴다.**
  // 면제는 「인쇄된 값과 다르다는 것을 알고 넘긴」 칸이고, 일치율은 「이 비율만큼 인쇄본을
  // 재현했다」는 주장 그대로여야 한다. 면제를 분모에서 빼면 100.000% 가 되는데 그것은
  // 세 칸에 대해 거짓이다 — 면제표가 아무리 잘 보여도 그렇다. 넘치게 말하지 않는 수가
  // 둥근 수보다 낫다. 관문(gatePassed)에서만 빼고 분모에는 남긴다.
  const kd = byVerdict['known-divergence'] ?? 0;
  // 전체 리뷰 F7: `no-oracle`(확정본에 값이 없는 칸)이 관문 조건에 없었다. 확정본이
  // 잘리거나 지면이 빠지면 그 칸들이 조용히 분모에서 빠지고 관문은 통과를 찍는다
  // (리뷰어가 part1_1 의 p8 을 지워 697칸이 no-oracle 로 옮겨가는 것을 확인했다).
  // 지금 전 관문에서 0건이다 — 수식이 있는 지면 칸에는 인쇄된 값이 반드시 있다.
  const no = byVerdict['no-oracle'] ?? 0;
  const comparable = m + mm + er + kd;
  return {
    total: rows.length,
    comparable,
    rate: comparable ? m / comparable : 0,
    // presentation 은 관문에서 일부러 뺀다 — 구현하지 않기로 한 결정이지, 빚이 아니다.
    // unsupported 가 남아 있으면 stage 2 가 데이터 계층에서 그 셀을 렌더링할 근거가
    // 없다는 뜻이라 관문을 통과시키지 않는다.
    // 묵은 면제(stale)는 반드시 실패다 — 면제 목록이 낡은 채로 통과하면 그 칸들이
    // 영원히 눈먼 자리가 된다.
    gatePassed: mm === 0 && er === 0 && un === 0 && stale === 0 && no === 0,
    byVerdict, byPart,
  };
}

/** 전체 리뷰 F7: 관문에 **「얼마나 대조했는가」의 하한**이 없었다. `gatePassed` 는
    「불일치·오류·미지원이 0」만 요구하므로, 확정본 파일 하나가 사라지면 그 part 를
    통째로 건너뛰고도 통과한다. 지금까지 그것을 막던 것은 `materialize.test.ts` 의
    하드코딩된 숫자뿐이었다 — 방어선이 관문이 아니라 시험 스위트에 있었다.
    하한은 `data/gate-snapshot.json` 에서 읽는다: 거기에 관문이 통과한 순간의 대조
    대상(29,561칸)이 좌표째로 들어 있어, 파트 수와 셀 수를 따로 적어 둘 필요가 없다. */
export type GateFloor = { parts: number; comparable: number; from: string };

export function readGateFloor(
  dataDir = 'data',
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
  exists: (p: string) => boolean = (p) => existsSync(p),
): GateFloor | null {
  const file = join(dataDir, 'gate-snapshot.json');
  if (!exists(file)) return null;
  const snap = JSON.parse(readFile(file)) as
    { comparable?: number; values?: Record<string, unknown> };
  const keys = Object.keys(snap.values ?? {});
  return {
    parts: new Set(keys.map((k) => k.split('!')[0])).size,
    comparable: snap.comparable ?? keys.length,
    // 리포트에 찍히는 문자열이다 — 플랫폼마다 구분자가 달라지면 커밋된 리포트가 흔들린다.
    from: file.replace(/\\/g, '/'),
  };
}

/** 하한을 어긴 사유들. 하나라도 있으면 관문은 통과가 아니다. */
export function floorViolations(
  run: { parts: string[]; skipped: string[]; summary: Summary },
  floor: GateFloor | null,
): string[] {
  const v: string[] = [];
  // 건너뛴 part 는 그 자체로 위반이다 — 대조하지 않은 것을 통과라고 부르지 않는다.
  if (run.skipped.length) {
    v.push(`확정본이 없어 건너뛴 파트 ${run.skipped.length}개: ${run.skipped.join(', ')}`);
  }
  if (!floor) {
    v.push('대조 규모의 하한을 읽을 수 없다 — data/gate-snapshot.json 이 없다 '
      + '(먼저 `npm run build:snapshot` 으로 기준을 만든다)');
    return v;
  }
  if (run.parts.length < floor.parts) {
    v.push(`대조한 파트가 ${run.parts.length}개다 — 하한 ${floor.parts}개 (${floor.from})`);
  }
  if (run.summary.comparable < floor.comparable) {
    v.push(`대조한 셀이 ${run.summary.comparable}개다 — 하한 ${floor.comparable}개 (${floor.from})`);
  }
  return v;
}

/** 관문이 무엇을 읽고 돌 것인가.
    전체 리뷰 F4: **기본은 `cellmap` 이다.** 단위 11 까지 출하 진입점(`npm run verify`)은
    `data/formulas/` 와 `data/raw/headers.json` 을 읽어 매번 cellmap 을 다시 만들었고,
    물화물(`data/cellmap/*.json`)은 시험과 스냅샷 생성기만 읽었다 — 「그 다음부터 관문은
    수식도 헤더도 읽지 않는다」는 서술이 출하 경로에 대해서는 거짓이었다. 이제 관문이
    물화물을 탄다. 수식 경로는 `--from-formulas` 로 남겨 두 경로를 계속 대조할 수 있다. */
export type GateSource = 'cellmap' | 'formulas';

export type GateOpts = {
  dataDir?: string;
  source?: GateSource;
  /** 기준연도(=앵커). 기본은 BASE_YEAR 또는 2025. */
  year?: string;
  /** 파일 읽기·목록 주입 — 시험이 「무엇을 열었는가」를 감시하고 part 를 좁히는 자리다.
      주석으로 「읽지 않는다」고 주장하지 않기 위해 존재한다. */
  readFile?: (path: string) => string;
  readDir?: (path: string) => string[];
  exists?: (path: string) => boolean;
  log?: (line: string) => void;
};

export type GateRun = {
  source: GateSource;
  year: string;
  anchor: number;
  /** 실제로 대조한 part (확정본이 없어 건너뛴 것은 제외) */
  parts: string[];
  skipped: string[];
  rows: CellResult[];
  stale: StaleDivergence[];
  known: KnownDivergence[];
  exempt: CellResult[];
  summary: Summary;
  /** F7: 대조 규모의 하한(gate-snapshot 기준)과 그것을 어긴 사유 */
  floor: GateFloor | null;
  violations: string[];
  /** 관문 통과 = 판정 조건 + 규모 하한 둘 다 */
  passed: boolean;
};

export function runGate(opts: GateOpts = {}): GateRun {
  // Task 9 단위 10: BASE_YEAR 는 이제 **앵커**다(리뷰 지적 6 — 단위 8 이후 이 값을 읽는
  // 곳이 없어 거짓 손잡이였다). 관문의 전제는 인쇄된 값의 재현이므로 기본값 2025 로
  // 돌린다. 2025 가 아닌 값으로 돌리면 앵커를 주입하는 part(part1_5·part3)에서 RULING 17
  // 단정이 던져 즉시 멈춘다 — 「확정본과 대조한다」와 「다른 연도로 계산한다」는 동시에
  // 성립할 수 없기 때문이다. 다른 연도를 계산해 보려면 관문이 아니라 anchorCell 을 쓴다.
  const YEAR = opts.year ?? process.env.BASE_YEAR ?? '2025';
  const dataDir = opts.dataDir ?? 'data';
  const source: GateSource = opts.source ?? 'cellmap';
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const readDir = opts.readDir ?? ((p: string) => readdirSync(p));
  const exists = opts.exists ?? ((p: string) => existsSync(p));
  const log = opts.log ?? ((line: string) => console.log(line));
  const anchor = Number(YEAR);

  const dbFile = join(dataDir, 'obs.sqlite');
  const fresh = !exists(dbFile);
  const db = openDb(dbFile);
  if (fresh) {
    log('적재: ' + JSON.stringify(loadAll(db, join(dataDir, 'raw'))));
  }

  // 수식 경로에서만 헤더 매핑이 필요하다 — 물화된 cellmap 에는 열 이름이 이미 해석돼 있다.
  const headers = source === 'formulas'
    ? (JSON.parse(readFile(join(dataDir, 'raw', 'headers.json'))) as Headers) : null;

  // Task 9 단위 9: 사용자가 「인쇄본이 틀렸다」고 판정한 칸의 면제 목록.
  // 좌표만이 아니라 확정본 값과 계산값을 둘 다 적어 두고, 둘 다 그대로일 때만 면제한다.
  const knownFile = join(dataDir, 'known-divergences.json');
  const known = exists(knownFile)
    ? (JSON.parse(readFile(knownFile)) as KnownDivergence[]) : [];

  const srcDir = join(dataDir, source === 'cellmap' ? 'cellmap' : 'formulas');
  const rows: CellResult[] = [];
  const parts: string[] = [];
  const skipped: string[] = [];
  for (const f of readDir(srcDir)) {
    if (!f.endsWith('.json')) continue;
    const part = basename(f, '.json');
    const op = join(dataDir, 'oracle', f);
    if (!exists(op)) { log('확정본 없음, 건너뜀: ' + part); skipped.push(part); continue; }
    const oracle = JSON.parse(readFile(op)) as OracleDump;
    const r = source === 'cellmap'
      ? verifyCellMap(part, JSON.parse(readFile(join(srcDir, f))) as CellMap, oracle, db, anchor)
      : verifyPart(part, JSON.parse(readFile(join(srcDir, f))) as FormulaDump,
                   oracle, db, headers!, YEAR);
    parts.push(part);
    // 면제는 part 별로 먼저 적용한다 — 아래 진행 표시가 최종 판정과 어긋나지 않게.
    // 묵음 검사는 전체를 모은 뒤 한 번 더 돌린다(건너뛴 part 의 항목도 잡으려면 전역이어야 한다).
    const rr = applyKnownDivergences(r, known.filter((k) => k.part === part)).rows;
    rows.push(...rr);
    const s = summarize(rr);
    const partCol = part.padEnd(20);
    const compCol = String(s.comparable).padStart(5);
    const matchCol = String(s.byVerdict.match ?? 0).padStart(5);
    log(`  ${partCol} 대조 ${compCol} · 일치 ${matchCol} (${(s.rate * 100).toFixed(2)}%)`);
  }

  // Task 9 단위 9: 면제를 적용한다. 차이가 그대로인 칸만 known-divergence 가 되고,
  // 묵은 항목(이제 일치하거나 값이 달라진 것)은 경고로 찍고 관문을 실패시킨다.
  const stale: StaleDivergence[] = applyKnownDivergences(rows, known).stale;
  const exempt = rows.filter((r) => r.verdict === 'known-divergence');
  const summary = summarize(rows, stale.length);
  const floor = readGateFloor(dataDir, readFile, exists);
  const violations = floorViolations({ parts, skipped, summary }, floor);
  return { source, year: YEAR, anchor, parts, skipped, rows, stale, known, exempt,
           summary, floor, violations, passed: summary.gatePassed && violations.length === 0 };
}

function main() {
  // 전체 리뷰 F4: 기본은 물화물(cellmap)이다. 수식 경로는 플래그로 남는다.
  const source: GateSource = process.argv.includes('--from-formulas') ? 'formulas' : 'cellmap';
  const run = runGate({ source });
  const { rows, stale, known, exempt, year: YEAR } = run;
  if (exempt.length) {
    console.log('\n면제(known-divergence) %d건 — 사용자 판정으로 대조에서 뺀다:', exempt.length);
    for (const r of exempt) {
      console.log(`  ${r.part}!${r.sheet}!${r.ref}  확정본 ${JSON.stringify(r.expected)} / 계산 ${JSON.stringify(r.got)}`);
    }
  }
  if (stale.length) {
    console.log('\n[경고] 묵은 면제 %d건 — 관문을 실패시킨다:', stale.length);
    for (const x of stale) {
      console.log(`  ${x.entry.part}!${x.entry.sheet}!${x.entry.ref}: ${x.why}`);
    }
  }
  if (run.violations.length) {
    console.log('\n[경고] 대조 규모가 하한에 못 미친다 — 관문을 실패시킨다:');
    for (const w of run.violations) console.log('  ' + w);
  }

  const s = run.summary;
  mkdirSync('reports', { recursive: true });

  const sourceNote = run.source === 'cellmap'
    ? '물화된 cellmap(`data/cellmap/*.json`) + 확정본 + obs.sqlite — **수식 파일도 헤더 매핑도 읽지 않는다**'
    : '수식 덤프(`data/formulas/*.json`) + `headers.json` + 확정본 + obs.sqlite (`--from-formulas`)';
  const lines: string[] = [
    '# 전건 대조 리포트',
    '',
    `기준연도 ${YEAR} · 생성 ${new Date().toISOString().slice(0, 10)}`,
    '',
    `읽은 것: ${sourceNote}`,
    '',
    `- 대조한 파트 **${run.parts.length}**${run.skipped.length ? ` · 건너뛴 파트 ${run.skipped.length}` : ''}`,
    `- 수식 좌표 **${s.total}**`,
    `- 대조 가능 **${s.comparable}** (확정본에 값이 있고 파싱된 것)`,
    `- 일치 **${s.byVerdict.match ?? 0}** · 불일치 **${s.byVerdict.mismatch ?? 0}** · 실행오류 **${s.byVerdict.error ?? 0}**`,
    `- 파싱 못함 ${s.byVerdict.unsupported ?? 0} · 확정본에 값 없음 ${s.byVerdict['no-oracle'] ?? 0}`,
    `- 표현(presentation) **${s.byVerdict.presentation ?? 0}** — OECD 부록의 같은시트 INDEX/MATCH/RANK 정렬 수식. 원천 통합문서를 참조하지 않는 표시 로직이라 SQL 로 재구현하지 않기로 정했다. 대조 분모·관문 모두에서 제외한다.`,
    `- 면제(known-divergence) **${s.byVerdict['known-divergence'] ?? 0}** — 사용자가 「인쇄본이 틀렸다」고 판정한 칸. 확정본은 고치지 않았다(확정본은 계속 「인쇄된 것」을 뜻한다). 대조 분모·관문에서 제외하지만 **차이가 그대로일 때만** 면제된다.`,
    `- 일치율 **${(s.rate * 100).toFixed(3)}%** — 분모는 대조 가능 ${s.comparable} 이고 **면제 ${s.byVerdict['known-divergence'] ?? 0}건도 분모에 든다**(인쇄본을 재현하지 못한 칸이므로). presentation 만 분모에서 뺀다.`,
    '',
    `## 관문: ${run.passed ? '통과' : '미통과'} (불일치 0 · 오류 0 · 파싱못함 0 · 확정본에 값 없음 0 · 묵은 면제 0 — presentation 과 면제는 제외)`,
    '',
    run.floor
      ? `대조 규모 하한: 파트 ${run.floor.parts} · 셀 ${run.floor.comparable} (${run.floor.from}) — 확정본 파일이 빠져 part 를 건너뛰면 관문이 실패한다.`
      : '대조 규모 하한: **없다** — data/gate-snapshot.json 이 없다.',
    '',
    ...(run.violations.length
      ? ['### [경고] 규모 하한 위반 — 관문 실패 사유', '',
         ...run.violations.map((w) => `- ${w}`), ''] : []),
    ...(exempt.length ? ['### 면제 내역', '', '| 좌표 | 확정본(인쇄) | 계산 | 판정자 · 날짜 | 사유 |', '|---|---|---|---|---|',
      ...exempt.map((r) => {
        const e = known.find((k) => k.part === r.part && k.sheet === r.sheet && k.ref === r.ref)!;
        return `| ${r.part}!${r.sheet}!${r.ref} | ${JSON.stringify(r.expected)} | ${JSON.stringify(r.got)} | ${e.decided_by} · ${e.decided_on} | ${e.reason.replace(/\|/g, '\\|')} |`;
      }), ''] : []),
    ...(stale.length ? ['### [경고] 묵은 면제 — 관문 실패 사유', '',
      ...stale.map((x) => `- \`${x.entry.part}!${x.entry.sheet}!${x.entry.ref}\`: ${x.why}`), ''] : []),
    '## 파트별',
    '',
    '| 파트 | 대조 | 일치 | 불일치 | 오류 | 파싱못함 | 표현 | 면제 | 값없음 | 일치율 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const part of Object.keys(s.byPart).sort()) {
    const b = s.byPart[part];
    const comp = (b.match ?? 0) + (b.mismatch ?? 0) + (b.error ?? 0) + (b['known-divergence'] ?? 0);
    lines.push(`| ${part} | ${comp} | ${b.match ?? 0} | ${b.mismatch ?? 0} | ${b.error ?? 0} | ${b.unsupported ?? 0} | ${b.presentation ?? 0} | ${b['known-divergence'] ?? 0} | ${b['no-oracle'] ?? 0} | ${comp ? ((b.match ?? 0) / comp * 100).toFixed(2) : '—'}% |`);
  }
  writeFileSync(join('reports', 'verify-summary.md'), lines.join('\n') + '\n');

  const bad = rows.filter((r) => r.verdict !== 'match');
  writeFileSync(join('reports', 'verify-detail.jsonl'),
    bad.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // 파싱 실패 이유별 집계 — 다음에 무엇을 지원해야 하는지 알려준다.
  // 근본원인(reasonKey)으로 묶는다 — 정확한 문자열로만 묶으면 좌표·JSON 덤프가
  // 박힌 이유 하나가 count-1 행 수백 개로 쪼개져 순위표 아래로 흩어진다.
  // presentation 은 여기서 뺀다 — 구현하지 않기로 한 결정이라, 이 순위표(=남은 작업
  // 순서)에 섞이면 다음 단위가 무엇부터 해야 하는지 왜곡된다.
  const presentationCount = rows.filter((r) => r.verdict === 'presentation').length;
  const reasons = new Map<string, { n: number; sample: CellResult }>();
  for (const r of rows) {
    if (r.verdict !== 'unsupported' && r.verdict !== 'error') continue;
    const key = reasonKey(r.reason ?? '(이유없음)');
    const cur = reasons.get(key);
    if (cur) cur.n++;
    else reasons.set(key, { n: 1, sample: r });
  }
  const rl = ['# 파싱·실행 실패 이유', '',
    `표현(presentation) 판정 **${presentationCount}**건은 제외했다 — OECD 부록의 같은시트 정렬 수식으로, 구현하지 않기로 정했다.`,
    '', '근본원인(reasonKey) 기준으로 묶었다 — 좌표·JSON 덤프 등 변동 꼬리는 지우고, 함수명처럼 꼬리 자체가 요점인 경우는 남긴다.', '', '| 건수 | 근본원인 | 대표 이유 | 대표 좌표 |', '|---|---|---|---|'];
  for (const [key, v] of [...reasons].sort((a, b) => b[1].n - a[1].n)) {
    const full = (v.sample.reason ?? '(이유없음)').replace(/\|/g, '\\|');
    rl.push(`| ${v.n} | ${key.replace(/\|/g, '\\|')} | ${full} | ${v.sample.part}!${v.sample.sheet}!${v.sample.ref} |`);
  }
  writeFileSync(join('reports', 'unsupported-reasons.md'), rl.join('\n') + '\n');

  console.log('\n일치율 %s%% · 관문 %s',
    (s.rate * 100).toFixed(3), run.passed ? '통과' : '미통과');
  console.log('리포트: reports/verify-summary.md · verify-detail.jsonl · unsupported-reasons.md');
  process.exit(run.passed ? 0 : 1);
}

// Windows 에서 구분자·대소문자가 어긋날 수 있어 경로 문자열 비교를 쓰지 않는다.
// 어긋나면 test 가 summarize 를 import 하는 순간 main() 이 돌아 data/ 를 찾다 죽는다.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
