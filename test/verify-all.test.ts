import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { summarize, runGate } from '../scripts/verify-all.ts';
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

test('summarize: 관문 통과 여부는 mismatch+error+unsupported 가 0 인지다', () => {
  assert.equal(summarize(rows).gatePassed, false);
  // mismatch 도 error 도 unsupported 도 없으면 통과.
  assert.equal(
    summarize(rows.filter((r) =>
      r.verdict !== 'mismatch' && r.verdict !== 'error' && r.verdict !== 'unsupported')).gatePassed,
    true,
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

test('관문의 기본 경로는 cellmap 이다 — data/formulas 도 headers.json 도 열지 않는다', () => {
  const opened: string[] = [];
  const run = runGate({
    readFile: (p) => { opened.push(p); return readFileSync(p, 'utf8'); },
    readDir: (p) => { opened.push(p); return readdirSync(p); },
    log: () => {},
  });
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
