import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { summarize, runGate, readGateFloor, floorViolations } from '../scripts/verify-all.ts';
import type { CellResult } from '../src/verify/compare.ts';

const rows: CellResult[] = [
  { part: 'p1', sheet: 'a', ref: 'A1', verdict: 'match', expected: 1, got: 1 },
  { part: 'p1', sheet: 'a', ref: 'A2', verdict: 'match', expected: 2, got: 2 },
  { part: 'p1', sheet: 'a', ref: 'A3', verdict: 'mismatch', expected: 3, got: 9 },
  { part: 'p2', sheet: 'b', ref: 'B1', verdict: 'unsupported', expected: 1, got: null, reason: 'INDEX' },
  { part: 'p2', sheet: 'b', ref: 'B2', verdict: 'no-oracle', expected: null, got: null },
  { part: 'p2', sheet: 'b', ref: 'B3', verdict: 'error', expected: 1, got: null, reason: '실행 불가' },
];

test('summarize: 판정별로 센다', () => {
  const s = summarize(rows);
  assert.equal(s.total, 6);
  assert.equal(s.byVerdict.match, 2);
  assert.equal(s.byVerdict.mismatch, 1);
  assert.equal(s.byVerdict.unsupported, 1);
  assert.equal(s.byVerdict['no-oracle'], 1);
  assert.equal(s.byVerdict.error, 1);
});

test('summarize: 일치율은 대조 가능한 셀(match+mismatch+error) 기준이다', () => {
  const s = summarize(rows);
  // no-oracle 과 unsupported 는 분모에서 뺀다 — 대조를 한 게 아니다.
  // comparable 은 match(2)+mismatch(1)+error(1)=4 — error 를 분모에서 빼는
  // 회귀(= m+mm 만 쓰는 것)라면 3 이 나와 이 값과 어긋난다.
  assert.equal(s.comparable, 4);
  assert.equal(s.rate, 2 / 4);
});

test('summarize: 파트별로도 센다', () => {
  const s = summarize(rows);
  assert.equal(s.byPart['p1'].match, 2);
  assert.equal(s.byPart['p1'].mismatch, 1);
  assert.equal(s.byPart['p2'].unsupported, 1);
  assert.equal(s.byPart['p2'].error, 1);
});

test('summarize: 관문 통과 여부는 mismatch+error+unsupported+no-oracle 이 0 인지다', () => {
  assert.equal(summarize(rows).gatePassed, false);
  // mismatch 도 error 도 unsupported 도 no-oracle 도 없으면 통과.
  assert.equal(
    summarize(rows.filter((r) => r.verdict !== 'mismatch' && r.verdict !== 'error'
      && r.verdict !== 'unsupported' && r.verdict !== 'no-oracle')).gatePassed,
    true,
  );
  // 전체 리뷰 F7: `no-oracle` 하나만 남아도 실패여야 한다. 확정본이 잘리거나 지면이
  // 빠지면 그 칸들이 no-oracle 로 옮겨가 조용히 분모에서 빠지는데, 옛 조건은 그것을
  // 통과로 찍었다(리뷰어가 part1_1!p8 을 지워 697칸이 옮겨가는 것을 확인했다).
  assert.equal(
    summarize(rows.filter((r) => r.verdict === 'match' || r.verdict === 'no-oracle')).gatePassed,
    false,
  );
  // mismatch 는 0 인데 error 가 하나 남아 있으면: gatePassed 는 여전히 false 여야
  // 한다. `mm === 0` 만 보고 `&& er === 0` 을 빼먹는 회귀를 이 assertion 이 잡는다.
  assert.equal(summarize(rows.filter((r) => r.verdict !== 'mismatch')).gatePassed, false);
  // mismatch 도 error 도 없는데 unsupported 가 하나 남아 있으면: 여전히 false 여야
  // 한다. `&& un === 0` 을 빼먹는 회귀를 잡는다 (Task 9 단위 2 의 핵심).
  assert.equal(
    summarize(rows.filter((r) => r.verdict !== 'mismatch' && r.verdict !== 'error')).gatePassed,
    false,
  );
});

// TASK 9 단위 2 — presentation 판정과 관문 강화.
const presentationRow: CellResult =
  { part: 'p3', sheet: 'c', ref: 'C1', verdict: 'presentation', expected: 1, got: null, reason: 'INDEX' };

test('summarize: presentation 은 comparable 과 일치율 분모에서 빠진다', () => {
  const withPresentation = [...rows, presentationRow];
  const s = summarize(withPresentation);
  // rows 와 comparable·rate 가 동일해야 한다 — presentation 이 분모를 건드리지 않는다.
  assert.equal(s.comparable, 4);
  assert.equal(s.rate, 2 / 4);
  assert.equal(s.byVerdict.presentation, 1);
  assert.equal(s.total, 7);
});

// unsupported 하나가 남으면 관문은 실패해야 하지만, 같은 자리에 presentation 하나가
// 있으면(= "구현하지 않기로 한 결정") 관문은 통과해야 한다. 이 쌍이 단위 2 전체의
// 핵심을 고정한다 — 옛 두-조건 gatePassed(mm===0 && er===0)로 잠깐 되돌리면 두
// 케이스 모두 true 가 나와(=unsupported 를 걸러내지 못해) 이 테스트가 실패한다는
// 것을 로컬에서 직접 확인했다(커밋하지 않음).
test('summarize: mismatch·error 0 에 unsupported 1 이면 gatePassed=false, 그 자리가 presentation 이면 true', () => {
  const cleanRows: CellResult[] = rows.filter((r) => r.verdict === 'match');
  const withUnsupported = [...cleanRows,
    { part: 'p2', sheet: 'b', ref: 'B1', verdict: 'unsupported', expected: 1, got: null, reason: 'X' } as CellResult];
  const withPresentation = [...cleanRows, presentationRow];
  assert.equal(summarize(withUnsupported).gatePassed, false);
  assert.equal(summarize(withPresentation).gatePassed, true);
});

// ── 전체 리뷰 F4 — 물화물이 **출하 경로**를 탄다 ────────────────────────────
// 단위 11 까지 `npm run verify` 는 `data/formulas/` 와 `data/raw/headers.json` 을 읽어
// cellmap 을 매번 다시 만들었고, `data/cellmap/*.json` 은 시험과 스냅샷 생성기만 읽었다.
// 그래서 「그 다음부터 관문은 수식도 헤더도 읽지 않는다」는 서술이 **출하 진입점에
// 대해서는 거짓**이었다. 이 시험은 그 주장을 주석이 아니라 **읽은 파일 목록**으로 짓는다.

// 관문을 **한 번만** 돌리고 아래 시험들이 같은 결과를 쓴다 (전건 실행이 40초다).
const opened: string[] = [];
const run = runGate({
  readFile: (p) => { opened.push(p); return readFileSync(p, 'utf8'); },
  readDir: (p) => { opened.push(p); return readdirSync(p); },
  log: () => {},
});

test('관문의 기본 경로는 cellmap 이다 — data/formulas 도 headers.json 도 열지 않는다', () => {
  // 감시한 자리가 관문이 파일을 읽는 자리 전부다(DB 는 node:sqlite 가 직접 연다).
  assert.deepEqual(opened.filter((p) => /formulas|headers\.json/.test(p)), [],
    '기본 경로가 수식·헤더 파일을 열었다');
  assert.ok(opened.some((p) => /cellmap/.test(p)), 'cellmap 을 읽지 않았다');
  assert.ok(opened.some((p) => /oracle/.test(p)), '확정본을 읽지 않았다');
  // 그리고 그 경로만으로 관문 수치가 그대로 나온다
  const s = run.summary;
  assert.equal(s.byVerdict.match, 29558);
  assert.equal(s.byVerdict.mismatch ?? 0, 0);
  assert.equal(s.byVerdict.error ?? 0, 0);
  assert.equal(s.byVerdict.unsupported ?? 0, 0);
  assert.equal(s.byVerdict.presentation, 3364);
  assert.equal(s.byVerdict['known-divergence'], 3);
  assert.equal(s.byVerdict['no-oracle'] ?? 0, 0);
  assert.equal(s.comparable, 29561);
  assert.equal(run.stale.length, 0);
  assert.equal(run.skipped.length, 0);
  assert.equal((s.rate * 100).toFixed(3), '99.990');
  assert.equal(s.gatePassed, true);
  assert.deepEqual(run.violations, []);
  assert.equal(run.passed, true);
});

// ── 전체 리뷰 F7 — 관문에 「얼마나 대조했는가」의 하한을 둔다 ───────────────

test('F7: 하한은 gate-snapshot 에서 읽는다 — 파트 13 · 셀 29,561', () => {
  const floor = readGateFloor();
  assert.ok(floor);
  assert.equal(floor.parts, 13);
  assert.equal(floor.comparable, 29561);
  assert.equal(run.parts.length, floor.parts);
  assert.equal(run.summary.comparable, floor.comparable);
});

test('F7: 확정본 파일이 빠져 part 를 건너뛰면 관문이 실패한다', () => {
  // 확정본 하나를 **없는 것으로 만든다**(exists 주입). 옛 관문은 그 part 를 통째로
  // 건너뛰고도 통과를 찍었다 — 방어선이 관문이 아니라 시험 스위트의 하드코딩된
  // 숫자뿐이었다.
  // part 둘로 좁혀 돌리고(둘 다 면제가 없는 part 다) 하나의 확정본을 숨긴다.
  // 면제 목록도 숨긴다 — 그러면 **판정 조건은 전부 만족**(불일치 0 · 오류 0 · 미지원 0 ·
  // 값없음 0 · 묵은 면제 0)이 되어, 옛 관문이라면 그대로 「통과」를 찍는 상황이 된다.
  const hidden = 'part1_2.json';
  const gone = (p: string, name: string) =>
    p.endsWith(`\\${name}`) || p.endsWith(`/${name}`);
  const one = runGate({
    readDir: (p) => readdirSync(p).filter((f) => f === hidden || f === 'part1_3.json'),
    exists: (p) => (gone(p, 'known-divergences.json')
      || (gone(p, hidden) && p.includes('oracle')) ? false : existsSync(p)),
    log: () => {},
  });
  assert.deepEqual(one.skipped, ['part1_2']);
  assert.deepEqual(one.parts, ['part1_3']);
  // 판정 조건만 보면 통과다 — 이것이 F7 이 지적한 그 구멍이다.
  assert.equal(one.summary.gatePassed, true);
  // 규모 하한이 그것을 잡는다.
  assert.ok(one.violations.some((w) => w.includes('건너뛴 파트')), one.violations.join(' | '));
  assert.equal(one.passed, false, '건너뛴 part 가 있는데 관문이 통과했다');
});

test('F7: part 하나 어치의 셀이 빠지면 규모 하한이 그것을 잡는다', () => {
  // 확정본이 **잘린** 경우(파일은 있고 값이 없다)는 건너뜀으로 잡히지 않는다 —
  // 그때 남는 방어선이 셀 수 하한이다. 실제 관문 결과에서 part 하나를 덜어 확인한다.
  const floor = readGateFloor();
  const short = run.rows.filter((r) => r.part !== 'part1_2');
  const v = floorViolations(
    { parts: run.parts.filter((p) => p !== 'part1_2'), skipped: [], summary: summarize(short) },
    floor);
  assert.ok(v.some((w) => w.includes('대조한 셀')), v.join(' | '));
  assert.ok(v.some((w) => w.includes('대조한 파트')), v.join(' | '));
  // 규모가 그대로면 위반이 없다 (하한이 「항상 실패」가 아니라는 확인)
  assert.deepEqual(floorViolations(run, floor), []);
});

test('--from-formulas 경로가 살아 있고 cellmap 경로와 셀 단위로 같다', () => {
  // part 하나로 좁혀 두 경로를 같은 자리에서 비교한다(readDir 주입 — 생산 경로에는
  // part 를 좁히는 손잡이가 없다). 전건 왕복은 materialize.test.ts 가 계속 맡는다.
  const only = (p: string) => readdirSync(p).filter((f) => f === 'part1_2.json');
  const a = runGate({ source: 'cellmap', readDir: only, log: () => {} });
  const b = runGate({ source: 'formulas', readDir: only, log: () => {} });
  assert.equal(a.parts.length, 1);
  assert.equal(b.parts.length, 1);
  assert.deepEqual(b.rows, a.rows, '수식 경로와 cellmap 경로의 결과가 다르다');
});
